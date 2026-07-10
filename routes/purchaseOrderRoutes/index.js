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
const { connectToDatabase } = require("../../utils/mongodb");
const {
  syncPurchaseOrders,
  updatePurchaseOrders,
  appendPurchaseOrderRow,
  appendPurchaseOrderRows,
  COLLECTION: PO_COLLECTION,
  META: PO_META,
} = require("../../utils/purchaseOrderSync");

const VIEW = requirePermission("po:order:view");

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Order date in the sheet's native format: YYYY-M-D with NO leading zeros
// (e.g. "2026-7-10"), matching the purchase team's existing rows. A zero-padded
// value ("2026-07-10") trips the date column's data validation in Tencent Docs.
// Computed in the business timezone so it doesn't drift a day at UTC midnight.
function melbourneOrderDate(now) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(now)
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
  // Coerce to numbers to strip any locale-added leading zeros ("07" → "7").
  return `${+parts.year}-${+parts.month}-${+parts.day}`;
}

// Validate one Create-PO item; returns an error string or null.
function poItemError(b) {
  const category = String((b && b.category) || "").trim();
  const orderQty = Number(b && b.orderQty);
  const sku = String((b && b.sku) || "").trim();
  const productName = String((b && b.productName) || "").trim();
  if (!category) return "Category is required.";
  if (!Number.isFinite(orderQty) || orderQty <= 0) return "A positive quantity is required.";
  if (!sku && !productName) return "A product (SKU or name) is required.";
  return null;
}

// Build a dashboard-sourced PO record from a request item.
function poItemToRecord(b, orderDate, now, createdBy) {
  return {
    category: String(b.category || "").trim(),
    orderDate,
    sku: String(b.sku || "").trim(),
    productName: String(b.productName || "").trim(),
    orderQty: Number(b.orderQty),
    unitPrice: null,
    supplier: "",
    orderedAt: "",
    shippedQty: null,
    shippedDate: "",
    dhlTracking: "",
    receivedDate: "",
    note: String(b.note || "").trim(),
    status: "pending",
    lineTotal: null,
    zoho_id: b.zoho_id != null && String(b.zoho_id).trim() ? String(b.zoho_id).trim() : null,
    source: "dashboard",
    createdBy: createdBy || null,
    createdAt: now,
    syncedAt: now,
  };
}

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

// ── POST /purchaseOrder/sync ────────────────────────────────────────
// Pull every purchase-order tab into the imb_purchase_order collection (a full
// replace — the sheet is the source of truth). Returns per-category counts.
router.post("/sync", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const result = await syncPurchaseOrders(db);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("PO sync error:", error);
    return res.status(502).json({ success: false, message: error.message || "Sync failed" });
  }
});

// ── POST /purchaseOrder/updateSync ──────────────────────────────────
// Incremental sync: pull the Tencent sheet and apply the purchase team's edits
// to the matching DB rows (updates changed columns, inserts new rows, deletes
// nothing — dashboard-created rows and our note/zoho_id are preserved). Same
// logic the daily cron runs; this is the manual, in-app trigger. Slow — it
// exports the whole workbook.
router.post("/updateSync", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const result = await updatePurchaseOrders(db);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("PO update sync error:", error);
    return res
      .status(502)
      .json({ success: false, message: error.message || "Update sync failed" });
  }
});

// ── GET /purchaseOrder/records ──────────────────────────────────────
// Read the synced collection — paginated, filterable by category / status /
// free-text (SKU, product, supplier, DHL#).
router.get("/records", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 500);

    const match = {};
    if (req.query.category) match.category = String(req.query.category);
    if (req.query.status) match.status = String(req.query.status);
    // "Not yet received" = everything except the received (收到日期 filled) stage.
    else if (String(req.query.notReceived) === "true") match.status = { $ne: "received" };
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ sku: rx }, { productName: rx }, { supplier: rx }, { dhlTracking: rx }];
    }

    const col = db.collection(PO_COLLECTION);
    const total = await col.countDocuments(match);
    const rows = await col
      .find(match)
      .sort({ category: 1, sourceRow: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();
    const meta = await db.collection(PO_META).findOne({ _id: "meta" });

    // Per-category counts: total (from meta) + not-yet-received (live) — the tree
    // shows whichever matches the current "Not yet received only" toggle.
    const openAgg = await col
      .aggregate([
        { $match: { status: { $ne: "received" } } },
        { $group: { _id: "$category", n: { $sum: 1 } } },
      ])
      .toArray();
    const byCategoryOpen = {};
    for (const r of openAgg) byCategoryOpen[r._id] = r.n;

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      rows,
      lastSyncedAt: meta ? meta.lastSyncedAt : null,
      byCategory: meta ? meta.byCategory : {},
      byCategoryOpen,
    });
  } catch (error) {
    console.error("PO records error:", error);
    return res.status(500).json({ success: false, message: "Failed to load records" });
  }
});

// ── GET /purchaseOrder/categories ───────────────────────────────────
// The category (sheet) list, for the Create PO picker.
router.get("/categories", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const meta = await db.collection(PO_META).findOne({ _id: "meta" });
    const categories = meta && meta.byCategory ? Object.keys(meta.byCategory) : [];
    return res.json({ success: true, categories });
  } catch (error) {
    console.error("PO categories error:", error);
    return res.status(500).json({ success: false, message: "Failed to load categories" });
  }
});

// ── POST /purchaseOrder/create ──────────────────────────────────────
// Create a purchase order in-app (from Stock Monitoring). Inserted with
// source:"dashboard" so the mirror sync preserves it. NOTE: this does NOT yet
// write the row back into the Tencent sheet — that write API is unresolved.
router.post("/create", VIEW, async function (req, res) {
  try {
    const b = req.body || {};
    const err = poItemError(b);
    if (err) return res.status(400).json({ success: false, message: err });

    const now = new Date();
    const createdBy = (req.user && (req.user.username || req.user.email)) || null;
    const rec = poItemToRecord(b, melbourneOrderDate(now), now, createdBy);

    const db = await connectToDatabase();
    const r = await db.collection(PO_COLLECTION).insertOne(rec);

    // Append the row to the Tencent sheet too — non-fatal: the PO is already in
    // our DB, so a Tencent hiccup shouldn't fail the request.
    let tencentWritten = false;
    let tencentError = null;
    try {
      await appendPurchaseOrderRow(rec);
      tencentWritten = true;
    } catch (e) {
      tencentError = (e && e.message) || String(e);
      console.error("PO Tencent write-back failed:", tencentError);
    }

    return res.json({
      success: true,
      record: { _id: r.insertedId, ...rec },
      tencentWritten,
      tencentError,
    });
  } catch (error) {
    console.error("PO create error:", error);
    return res.status(500).json({ success: false, message: "Failed to create purchase order" });
  }
});

// ── POST /purchaseOrder/createBatch ─────────────────────────────────
// Create several POs at once (from the PO page). Each item carries its own
// category / quantity / note / product. All are inserted (source:"dashboard"),
// then appended to the Tencent sheet grouped by category — one export + write
// per distinct category. The Tencent write is non-fatal (DB is the record).
router.post("/createBatch", VIEW, async function (req, res) {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, message: "No items provided." });
    if (items.length > 100) return res.status(400).json({ success: false, message: "Too many items (max 100)." });

    // Validate all up-front so we never insert a partial batch.
    for (let i = 0; i < items.length; i++) {
      const err = poItemError(items[i]);
      if (err) return res.status(400).json({ success: false, message: `Item ${i + 1}: ${err}` });
    }

    const now = new Date();
    const orderDate = melbourneOrderDate(now);
    const createdBy = (req.user && (req.user.username || req.user.email)) || null;
    const records = items.map((b) => poItemToRecord(b, orderDate, now, createdBy));

    const db = await connectToDatabase();
    const r = await db.collection(PO_COLLECTION).insertMany(records);
    records.forEach((rec, i) => { rec._id = r.insertedIds[i]; });

    let tencentWritten = false;
    let tencentError = null;
    try {
      await appendPurchaseOrderRows(records);
      tencentWritten = true;
    } catch (e) {
      tencentError = (e && e.message) || String(e);
      console.error("PO batch Tencent write-back failed:", tencentError);
    }

    const byCategory = {};
    for (const rec of records) byCategory[rec.category] = (byCategory[rec.category] || 0) + 1;

    return res.json({ success: true, created: records.length, byCategory, tencentWritten, tencentError });
  } catch (error) {
    console.error("PO createBatch error:", error);
    return res.status(500).json({ success: false, message: "Failed to create purchase orders" });
  }
});

// ── POST /purchaseOrder/byZohoIds ───────────────────────────────────
// For a set of Zoho item_ids, summarise the NOT-yet-received purchases per id:
//   orderQty   = Σ 订货数量  |  shippedQty = Σ 发货数量  |  trackings = distinct DHL #s
// Used by Stock Monitoring's "Purchase" column. Ids with no open purchase are
// simply absent from `data`.
router.post("/byZohoIds", VIEW, async function (req, res) {
  try {
    const ids = [
      ...new Set(
        (Array.isArray(req.body && req.body.zohoIds) ? req.body.zohoIds : [])
          .filter((x) => x != null)
          .map((x) => String(x).trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length) return res.json({ success: true, data: {} });

    const db = await connectToDatabase();
    const rows = await db
      .collection(PO_COLLECTION)
      .aggregate([
        { $match: { zoho_id: { $in: ids }, status: { $ne: "received" } } },
        {
          $group: {
            _id: "$zoho_id",
            orderQty: { $sum: { $ifNull: ["$orderQty", 0] } },
            shippedQty: { $sum: { $ifNull: ["$shippedQty", 0] } },
            trackings: { $addToSet: "$dhlTracking" },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const data = {};
    for (const r of rows) {
      data[r._id] = {
        orderQty: r.orderQty || 0,
        shippedQty: r.shippedQty || 0,
        count: r.count || 0,
        trackings: (r.trackings || []).map((t) => String(t || "").trim()).filter(Boolean),
      };
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("PO byZohoIds error:", error);
    return res.status(500).json({ success: false, message: "Failed to load purchase info" });
  }
});

module.exports = router;
