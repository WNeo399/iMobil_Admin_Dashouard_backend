// Purchase Order — read-only view over the supplier's Tencent Docs spreadsheet
// ("澳洲"). The tree lists the sheet's tabs; the table shows a tab's rows.
//
//   GET  /purchaseOrder/tabs          → [{ sheetId, title, rowCount, columnCount }]
//   GET  /purchaseOrder/tab?title=…   → { columns, rows } for one tab
//   POST /purchaseOrder/refresh       → force a fresh export
//
// Mounted under the authenticated chain in app.js. Gated by po:order:view.

var express = require("express");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { poApiId, getTabs, exportWorkbook } = require("../../utils/tencentDocs");

const VIEW = requirePermission("po:order:view");

// Cache the parsed workbook — an export takes a few seconds and returns the
// whole book, so one export serves every tab until the TTL lapses.
const TTL_MS = 15 * 60 * 1000;
let cache = { at: 0, byTitle: null };
let inFlight = null;

async function getWorkbook(force) {
  if (!force && cache.byTitle && Date.now() - cache.at < TTL_MS) {
    return cache.byTitle;
  }
  if (inFlight) return inFlight; // dedupe concurrent exports
  inFlight = (async () => {
    try {
      const byTitle = await exportWorkbook(poApiId());
      cache = { at: Date.now(), byTitle };
      return byTitle;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ── GET /purchaseOrder/tabs ─────────────────────────────────────────
router.get("/tabs", VIEW, async function (req, res) {
  try {
    const tabs = await getTabs(poApiId());
    return res.json({ success: true, tabs });
  } catch (error) {
    console.error("PO tabs error:", error);
    return res
      .status(502)
      .json({ success: false, message: error.message || "Failed to load tabs" });
  }
});

// ── GET /purchaseOrder/tab?title= ───────────────────────────────────
// Returns the header row + data rows for one tab. First call of a cache cycle
// triggers the export (slower); later calls are served from memory.
router.get("/tab", VIEW, async function (req, res) {
  try {
    const title = String(req.query.title || "").trim();
    if (!title) {
      return res.status(400).json({ success: false, message: "title is required" });
    }
    const wb = await getWorkbook(false);
    const rows = wb[title];
    if (!rows) {
      return res
        .status(404)
        .json({ success: false, message: `Tab "${title}" not found` });
    }
    const columns = rows.length ? rows[0].map((c) => (c == null ? "" : String(c))) : [];
    return res.json({
      success: true,
      title,
      columns,
      rows: rows.slice(1),
      cachedAt: cache.at || null,
    });
  } catch (error) {
    console.error("PO tab error:", error);
    return res
      .status(502)
      .json({ success: false, message: error.message || "Failed to load tab data" });
  }
});

// ── POST /purchaseOrder/refresh ─────────────────────────────────────
router.post("/refresh", VIEW, async function (req, res) {
  try {
    const wb = await getWorkbook(true);
    return res.json({ success: true, tabs: Object.keys(wb).length, cachedAt: cache.at });
  } catch (error) {
    console.error("PO refresh error:", error);
    return res
      .status(502)
      .json({ success: false, message: error.message || "Refresh failed" });
  }
});

module.exports = router;
