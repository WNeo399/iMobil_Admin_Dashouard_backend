// Blackbelt Defence API — device reports by IMEI / serial number.
//
// Two-step auth (auth-token → access-token), then two-step lookup
// (get-imei → download-report), and the report comes back as XML which we
// flatten into a plain object.
//
// Nothing in here throws: a lookup failure returns null so the caller can
// carry on without the device details. Response code 216 ("No Report")
// is a normal empty result, not an error.
//
// Credentials come from the environment:
//   BLACKBELT_DEVICE_ID · BLACKBELT_CLIENT_KEY · BLACKBELT_CLIENT_SECRET
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");

const BASE_URL = "https://api.blackbeltdefence.com/api/v1";
const TIMEOUT_MS = 30000;
const REPORT_TYPE = "analyst";
// Access tokens have no stated lifetime, so reuse one for a conservative
// window and re-login when it ages out (or if a call comes back 401).
const TOKEN_TTL_MS = 45 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;
let loginPromise = null; // in-flight login shared by concurrent callers

function creds() {
  return {
    deviceID: process.env.BLACKBELT_DEVICE_ID || "",
    clientKey: process.env.BLACKBELT_CLIENT_KEY || "",
    clientSecret: process.env.BLACKBELT_CLIENT_SECRET || "",
  };
}

function isConfigured() {
  const c = creds();
  return !!(c.deviceID && c.clientKey && c.clientSecret);
}

// Blackbelt searches on either an IMEI or a serial number, and the two
// fields aren't interchangeable — a serial sent as an IMEI comes back 216
// "No Report". A 15-digit pure number is an IMEI; anything else (an Apple
// serial, which carries letters) is a serial number. No checksum test:
// Blackbelt's own documentation example fails Luhn, so a valid-looking
// IMEI that doesn't add up is still searched as an IMEI.
function isImei(value) {
  return /^\d{15}$/.test(String(value || "").replace(/[\s-]/g, ""));
}

// ── auth ────────────────────────────────────────────────────────────
async function login(force = false) {
  if (!isConfigured()) return null;
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) return cachedToken;
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    const { deviceID, clientKey, clientSecret } = creds();
    const auth = await axios.post(
      `${BASE_URL}/auth-token`,
      { request: { deviceID, clientKey, clientSecret } },
      { timeout: TIMEOUT_MS, headers: { "Content-Type": "application/json" } },
    );
    const authToken = auth.data && auth.data.response && auth.data.response.authToken;
    if (!authToken) throw new Error("No authToken returned");

    const access = await axios.post(
      `${BASE_URL}/access-token`,
      { request: { deviceID } },
      {
        timeout: TIMEOUT_MS,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      },
    );
    const accessToken = access.data && access.data.response && access.data.response.accessToken;
    if (!accessToken) throw new Error("No accessToken returned");

    cachedToken = accessToken;
    cachedAt = Date.now();
    return accessToken;
  })()
    .catch((e) => {
      console.warn("Blackbelt login failed:", (e && e.message) || e);
      cachedToken = null;
      return null;
    })
    .finally(() => {
      loginPromise = null;
    });

  return loginPromise;
}

// ── XML → object ────────────────────────────────────────────────────
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", trimValues: true });

// Report XML nests differently depending on device type, so pull fields by
// name from anywhere in the tree rather than guessing a fixed path.
function findField(node, name, depth = 0) {
  if (node == null || depth > 12) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findField(item, name, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  for (const key of Object.keys(node)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      const v = node[key];
      if (v == null) continue;
      if (typeof v === "object") {
        // e.g. { "#text": "Apple" }
        if (v["#text"] != null) return v["#text"];
        continue;
      }
      return v;
    }
  }
  for (const key of Object.keys(node)) {
    const hit = findField(node[key], name, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function str(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "null" || s === "undefined" ? "" : s;
}
function toInt(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// Field mapping per the integration doc.
function parseReport(xml) {
  const tree = parser.parse(xml);
  const data = {
    brandName: str(findField(tree, "Manufacturer")),
    modelName: str(findField(tree, "Model")),
    serialNumber: str(findField(tree, "SerialNumber")),
    imei: str(findField(tree, "IMEI")),
    storage: str(findField(tree, "HandsetMemorySize")),
    color: str(findField(tree, "DeviceColor")),
    batteryHealth: toInt(findField(tree, "BatteryOverallPercentage")),
    batteryCycleCount: toInt(findField(tree, "BatteryCycleCount")),
    batteryCapacity: str(findField(tree, "BatteryDesignCapacity")),
    aNumber: str(findField(tree, "ANumber")),
  };
  // A report with nothing identifying in it is no use to the caller.
  if (!data.modelName && !data.brandName && !data.imei && !data.serialNumber) return null;
  return data;
}

// ── lookup ──────────────────────────────────────────────────────────
function dateWindow() {
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow, for TZ slack
  return { dateFrom: "2010-01-01", dateTo: to.toISOString().slice(0, 10) };
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Ask Blackbelt about one code, on one search field, and return its most
// recent report id — or null when there's nothing (including the 216
// "No Report" case).
//
// The live response nests as response.devices.device[].report[], which is
// not what the integration doc shows (response.device[].reports[]), so
// accept both spellings.
async function searchOn(token, code, field) {
  const { deviceID } = creds();
  const { dateFrom, dateTo } = dateWindow();
  const request = { deviceID, reportType: REPORT_TYPE, dateFrom, dateTo, [field]: code };

  const resp = await axios.post(
    `${BASE_URL}/get-imei`,
    { request },
    {
      timeout: TIMEOUT_MS,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    },
  );
  const r = (resp.data && resp.data.response) || {};
  if (Number(r.code) === 216) return null; // documented "No Report"

  const all = asArray(r.devices ? r.devices.device : r.device);

  // Only trust an entry that echoes back the code we asked about. An
  // unrecognised search field doesn't error — it comes back as every device
  // in the date window (thousands of them), and picking the newest report
  // out of that would staple a stranger's report onto this handset. A lone
  // result is accepted as-is, since not every response echoes identifiers.
  const wanted = String(code || "").toUpperCase();
  const identifies = (d) =>
    ["@id", "@IMEI", "@SerialNumber", "id", "IMEI", "SerialNumber"].some(
      (k) => d && d[k] != null && String(d[k]).toUpperCase() === wanted,
    );
  const matched = all.filter(identifies);
  const devices = matched.length ? matched : all.length === 1 ? all : [];
  if (!devices.length) return null;

  const reports = [];
  for (const d of devices) {
    for (const rep of asArray(d && (d.report || d.reports))) {
      const id = rep && (rep["@id"] || rep.id || rep["@_id"]);
      if (id) reports.push({ id: String(id), date: (rep && rep.date) || "" });
    }
  }
  if (!reports.length) return null;
  // Newest first; reports without a usable date keep their original order.
  reports.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return reports[0].id;
}

// Find the device's report id. 15 pure digits is an IMEI and goes to the
// IMEI field; anything else is a serial number.
//
// `serialnumber` is the exact field name Blackbelt expects. A misspelling is
// NOT rejected — it comes back as every device in the window (see the match
// guard above) — which is why the name is pinned here rather than guessed.
async function searchReportId(token, code) {
  return searchOn(token, code, isImei(code) ? "IMEI" : "serialnumber");
}

async function downloadReport(token, reportID) {
  const { deviceID } = creds();
  const resp = await axios.post(
    `${BASE_URL}/download-report`,
    { request: { deviceID, reportType: REPORT_TYPE, reportID } },
    {
      timeout: TIMEOUT_MS,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    },
  );
  return (resp.data && resp.data.response && resp.data.response.report) || null;
}

// Search Blackbelt for `code` (IMEI or serial) and return the parsed
// device data, or null when there's no report / anything goes wrong.
// Returns { notConfigured: true } when credentials aren't set.
async function lookupDevice(code) {
  const value = String(code || "").replace(/[\s-]/g, "").trim();
  if (!value) return { error: "No IMEI or serial supplied" };
  if (!isConfigured()) return { notConfigured: true };

  const attempt = async (force) => {
    const token = await login(force);
    if (!token) return { error: "Blackbelt authentication failed" };
    const reportID = await searchReportId(token, value);
    if (!reportID) return { found: false };
    const xml = await downloadReport(token, reportID);
    if (!xml) return { found: false };
    const device = parseReport(xml);
    return device ? { found: true, device, reportID } : { found: false };
  };

  try {
    return await attempt(false);
  } catch (e) {
    // An expired cached token shows up as a 401 — log in again and retry once.
    const status = e && e.response && e.response.status;
    if (status === 401 || status === 403) {
      try {
        return await attempt(true);
      } catch (e2) {
        console.warn("Blackbelt lookup failed after re-auth:", (e2 && e2.message) || e2);
        return { error: "Blackbelt lookup failed" };
      }
    }
    console.warn("Blackbelt lookup failed:", (e && e.message) || e);
    return { error: e && e.code === "ECONNABORTED" ? "Blackbelt timed out" : "Blackbelt lookup failed" };
  }
}

module.exports = { lookupDevice, isImei, isConfigured };
