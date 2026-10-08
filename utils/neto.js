// Neto (Maropost) store API — where the Exyon accessory orders come from
// (www.toptechdeals.com.au). Configured via NETOAPI_URL + NETOAPI_KEY in the
// env. Read-only here.
//
// Each Neto product carries our Zoho item id in its custom field Misc38
// ("zoho_id", checked 2026-10-08), which is how a Neto SKU maps to our item.

const axios = require("axios");

function endpoint() {
  const raw = String(process.env.NETOAPI_URL || "").trim();
  if (!raw || !process.env.NETOAPI_KEY) throw new Error("Neto API not configured (set NETOAPI_URL / NETOAPI_KEY).");
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return /\/do\/WS\/NetoAPI/i.test(u.pathname) ? u.origin + u.pathname : `${u.origin}/do/WS/NetoAPI`;
}

async function netoCall(action, body) {
  const r = await axios.post(endpoint(), body, {
    headers: {
      NETOAPI_ACTION: action,
      NETOAPI_KEY: process.env.NETOAPI_KEY,
      ...(process.env.NETOAPI_USERNAME ? { NETOAPI_USERNAME: process.env.NETOAPI_USERNAME } : {}),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });
  const d = r.data || {};
  if (d.Ack !== "Success" && d.Ack !== "Warning") {
    const msg = (d.Messages && JSON.stringify(d.Messages).slice(0, 300)) || "Neto did not answer";
    throw new Error(`Neto ${action}: ${msg}`);
  }
  return d;
}

// SKU → zoho_id ("" when the product has none), cached for a while so a page
// load doesn't call Neto each time. A SKU without an id is re-asked sooner
// (someone may be filling it in).
const HIT_TTL = 60 * 60 * 1000;
const MISS_TTL = 10 * 60 * 1000;
const cache = new Map(); // sku → { id, at }
const BATCH = 100;

async function zohoIdsForSkus(skus) {
  const out = new Map();
  const now = Date.now();
  const ask = [];
  for (const s of new Set(skus.map((x) => String(x || "").trim()).filter(Boolean))) {
    const c = cache.get(s);
    if (c && now - c.at < (c.id ? HIT_TTL : MISS_TTL)) out.set(s, c.id);
    else ask.push(s);
  }
  for (let i = 0; i < ask.length; i += BATCH) {
    const part = ask.slice(i, i + BATCH);
    const d = await netoCall("GetItem", { Filter: { SKU: part, OutputSelector: ["SKU", "Misc38"] } });
    const got = new Map((d.Item || []).map((it) => [String(it.SKU || "").trim(), String(it.Misc38 || "").trim()]));
    for (const s of part) {
      const raw = got.get(s) || "";
      const id = /^\d{15,20}$/.test(raw) ? raw : ""; // "N/A" and the like are no id
      cache.set(s, { id, at: now });
      out.set(s, id);
    }
  }
  return out;
}

module.exports = { netoCall, zohoIdsForSkus };
