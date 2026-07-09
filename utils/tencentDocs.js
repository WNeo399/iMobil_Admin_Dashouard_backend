// Minimal Tencent Docs (docs.qq.com) Open API client — just what the Purchase
// Order page needs: list a spreadsheet's tabs, and read its rows.
//
// Auth: three headers straight from the env (an OAuth2 access token — see the
// note on expiry at the bottom).
//   TENCENT_CLIENT_ID / TENCENT_ACCESS_TOKEN / TENCENT_OPEN_ID
//
// Two id forms matter:
//   • URL slug (from https://docs.qq.com/sheet/<slug>), e.g. "DYkZlcnBrRVRYTkdr"
//   • API id, e.g. "300000000$bFerpkETXNGk"
// The slug is "D" + base64(the API id's suffix), so we convert slug → API id.

const XLSX = require("xlsx-js-style");

const BASE = "https://docs.qq.com/openapi";
// The Purchase Order source sheet ("澳洲"). Override via env; the default is the
// known file so it works out of the box.
const PO_FILE = process.env.TENCENT_PO_FILE_ID || "DYkZlcnBrRVRYTkdr";

function headers(extra) {
  return {
    "Access-Token": process.env.TENCENT_ACCESS_TOKEN,
    "Client-Id": process.env.TENCENT_CLIENT_ID,
    "Open-Id": process.env.TENCENT_OPEN_ID,
    ...(extra || {}),
  };
}

// Accepts a full docs.qq.com URL, a "D…" URL slug, or an already-"$"-form API id.
function toApiId(idOrUrl) {
  let s = String(idOrUrl || "").trim();
  const m = s.match(/\/sheet\/(D[A-Za-z0-9]+)/) || s.match(/\/doc\/(D[A-Za-z0-9]+)/);
  if (m) s = m[1];
  if (s.includes("$")) return s; // already an API id
  if (/^D[A-Za-z0-9]+$/.test(s)) {
    const suffix = Buffer.from(s.slice(1), "base64").toString("utf8");
    return "300000000$" + suffix;
  }
  return s;
}

function poApiId() {
  return toApiId(PO_FILE);
}

// GET /openapi/spreadsheet/v3/{apiId} → [{ sheetId, title, rowCount, columnCount }]
async function getTabs(apiId) {
  const r = await fetch(`${BASE}/spreadsheet/v3/${encodeURIComponent(apiId)}`, {
    headers: headers(),
  });
  const j = await r.json();
  if (!Array.isArray(j.properties)) {
    throw new Error(
      `Tencent tabs error: ${j.msg || j.message || JSON.stringify(j).slice(0, 200)}`,
    );
  }
  return j.properties.map((p) => ({
    sheetId: p.sheetId,
    title: p.title,
    rowCount: p.rowCount,
    columnCount: p.columnCount,
  }));
}

// Async-export the whole workbook to xlsx, download it, and return the parsed
// XLSX workbook object (raw — no trimming).
async function downloadWorkbook(apiId) {
  const e = encodeURIComponent(apiId);
  const start = await (
    await fetch(`${BASE}/drive/v2/files/${e}/async-export`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ exportType: "csv" }), // returns an xlsx of the book
    })
  ).json();
  const operationID = start && start.data && start.data.operationID;
  if (!operationID) {
    throw new Error(
      `Tencent export start failed: ${start && (start.msg || JSON.stringify(start).slice(0, 200))}`,
    );
  }

  let url = null;
  for (let i = 0; i < 40; i++) {
    const prog = await (
      await fetch(
        `${BASE}/drive/v2/files/${e}/export-progress?operationID=${operationID}`,
        { headers: headers() },
      )
    ).json();
    if (prog && prog.data && prog.data.url) {
      url = prog.data.url;
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (!url) throw new Error("Tencent export timed out");

  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  return XLSX.read(buf, { type: "buffer" });
}

// Parse every tab into arrays-of-arrays. Returns { title: rows[][] }. The direct
// cell-values API is faster but its range params are undocumented for reads;
// export is reliable and gives all tabs in one shot.
async function exportWorkbook(apiId) {
  const wb = await downloadWorkbook(apiId);
  // The export pads to the sheet's used range, so trim it: drop fully-blank
  // rows (padding / blank separators), then keep only columns that have a
  // non-blank header (row 0) — dropping padding and any unlabelled column.
  const blank = (c) => String(c == null ? "" : c).trim() === "";
  const isBlankRow = (row) => !row || row.every(blank);
  const byTitle = {};
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils
      .sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false })
      .filter((r) => !isBlankRow(r));
    const header = rows[0] || [];
    const keep = [];
    for (let c = 0; c < header.length; c++) {
      if (!blank(header[c])) keep.push(c);
    }
    byTitle[name] = rows.map((r) => keep.map((c) => (r[c] == null ? "" : r[c])));
  }
  return byTitle;
}

// Raw (untrimmed) rows for one tab — keeps real column positions + row indices,
// which the trimmed exportWorkbook loses. Needed to locate where to append.
async function getSheetRawRows(apiId, title) {
  const wb = await downloadWorkbook(apiId);
  const name = wb.SheetNames.find((n) => n === title);
  if (!name) throw new Error(`Sheet "${title}" not found`);
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false });
}

// Look up a tab's sheetID (used in write ranges) via the sheetbook API.
async function getSheetId(apiId, title) {
  const r = await (
    await fetch(`${BASE}/sheetbook/v2/${encodeURIComponent(apiId)}/sheets-info`, {
      headers: headers(),
    })
  ).json();
  const list = (r && r.data && r.data.sheetData) || [];
  const s = list.find((x) => x.title === title);
  return s ? s.sheetID : null;
}

// Write a 2-D array of values into a range. range is A1 notation WITHOUT the
// sheet prefix (e.g. "A5:K5"); sheetId is prepended. PUT overwrites those cells.
async function putValues(apiId, sheetId, rangeA1, values) {
  const range = `${sheetId}!${rangeA1}`;
  const url = `${BASE}/sheetbook/v2/${encodeURIComponent(apiId)}/values/${encodeURIComponent(range)}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ values }),
  });
  const j = await r.json().catch(() => ({}));
  if (!(r.ok && (j.ret === 0 || j.code === 0 || j.msg === "Succeed"))) {
    throw new Error(`Tencent write failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}

module.exports = {
  toApiId,
  poApiId,
  getTabs,
  exportWorkbook,
  getSheetRawRows,
  getSheetId,
  putValues,
  PO_FILE,
};

// NOTE ON TOKEN EXPIRY: TENCENT_ACCESS_TOKEN is an OAuth2 access token and will
// expire. When it does, these calls start returning auth errors. To keep this
// working unattended, add a refresh step (needs the refresh token + client
// secret) that renews the access token before it lapses.
