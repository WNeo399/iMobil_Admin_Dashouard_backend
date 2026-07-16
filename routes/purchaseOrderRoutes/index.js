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
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { poApiId, getTabs, exportWorkbook } = require("../../utils/tencentDocs");
const { connectToDatabase } = require("../../utils/mongodb");
const {
  syncPurchaseOrders,
  updatePurchaseOrders,
  updatePurchaseOrderRow,
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

// Order timestamp for 下单时间 — "YYYY-M-D HH:mm" in Melbourne time.
function melbourneOrderDateTime(now) {
  const p = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
  return `${+p.year}-${+p.month}-${+p.day} ${p.hour}:${p.minute}`;
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

    // Base match — everything EXCEPT the status / not-received filter, so the
    // KPI status breakdown can show every status for the current view.
    const base = {};
    if (req.query.category) base.category = String(req.query.category);
    if (req.query.supplier) base.supplier = String(req.query.supplier);
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      base.$or = [{ sku: rx }, { productName: rx }, { supplier: rx }, { dhlTracking: rx }];
    }

    // Table match adds the status / not-received filter on top of the base.
    const match = { ...base };
    if (req.query.status) match.status = String(req.query.status);
    // "Not yet received" = everything except the received (收到日期 filled) stage.
    else if (String(req.query.notReceived) === "true") match.status = { $ne: "received" };

    const col = db.collection(PO_COLLECTION);
    const total = await col.countDocuments(match);
    // Sort by 订单日期 oldest → newest. orderDate is "YYYY-M-D" (no zero-padding),
    // so a string sort misorders it — build a numeric YYYYMMDD key instead. Empty
    // or unparseable dates fall to ~99999999 and sort last.
    const rows = await col
      .aggregate([
        { $match: match },
        { $addFields: { _od: { $split: [{ $ifNull: ["$orderDate", ""] }, "-"] } } },
        {
          $addFields: {
            _odKey: {
              $add: [
                { $multiply: [{ $convert: { input: { $arrayElemAt: ["$_od", 0] }, to: "int", onError: 9999, onNull: 9999 } }, 10000] },
                { $multiply: [{ $convert: { input: { $arrayElemAt: ["$_od", 1] }, to: "int", onError: 99, onNull: 99 } }, 100] },
                { $convert: { input: { $arrayElemAt: ["$_od", 2] }, to: "int", onError: 99, onNull: 99 } },
              ],
            },
          },
        },
        { $sort: { _odKey: 1, sourceRow: 1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        { $project: { _od: 0, _odKey: 0 } },
      ])
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

    // Status breakdown for the KPI cards — over the base match (category /
    // supplier / search), independent of the currently-selected status.
    const statusAgg = await col
      .aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }])
      .toArray();
    const byStatus = {};
    for (const r of statusAgg) byStatus[r._id || "unknown"] = r.n;

    // Supplier list for the dropdown — within the current category (not narrowed
    // by the selected supplier), busiest first.
    const supMatch = { supplier: { $nin: ["", null] } };
    if (req.query.category) supMatch.category = String(req.query.category);
    const supAgg = await col
      .aggregate([
        { $match: supMatch },
        { $group: { _id: "$supplier", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 200 },
      ])
      .toArray();
    const suppliers = supAgg.map((r) => r._id);

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      rows,
      lastSyncedAt: meta ? meta.lastSyncedAt : null,
      byCategory: meta ? meta.byCategory : {},
      byCategoryOpen,
      byStatus,
      suppliers,
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

// ── POST /purchaseOrder/placeOrder ──────────────────────────────────
// Mark a pending PO as ordered: set 供应商 (required) + 采购单价 (optional),
// stamp 下单时间 = now, and move status → "ordered". Writes the same fields back
// to the Tencent sheet row (non-fatal) so the sheet stays authoritative and the
// next sync doesn't revert them.
router.post("/placeOrder", VIEW, async function (req, res) {
  try {
    const b = req.body || {};
    const id = String(b.id || "");
    const supplier = String(b.supplier || "").trim();
    const hasPrice = b.unitPrice != null && String(b.unitPrice).trim() !== "";
    const unitPrice = hasPrice ? Number(b.unitPrice) : null;

    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    if (hasPrice && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      return res.status(400).json({ success: false, message: "采购单价 must be a valid non-negative number." });
    }

    let _id;
    try { _id = new ObjectId(id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }

    const db = await connectToDatabase();
    const col = db.collection(PO_COLLECTION);
    const rec = await col.findOne({ _id });
    if (!rec) return res.status(404).json({ success: false, message: "PO not found." });

    const orderedAt = melbourneOrderDateTime(new Date());
    // 供应商 + 采购单价 are both optional. Clear any 缺货 / 已取消 flag — placing the
    // order supersedes them.
    const set = { orderedAt, status: "ordered", shortage: false, cancelled: false, syncedAt: new Date() };
    if (supplier) set.supplier = supplier;
    if (hasPrice) {
      set.unitPrice = unitPrice;
      set.lineTotal = rec.orderQty != null ? Math.round(rec.orderQty * unitPrice * 100) / 100 : null;
    }
    await col.updateOne({ _id }, { $set: set });

    // Mirror the order details into the Tencent sheet row (non-fatal).
    let tencentWritten = false;
    let tencentError = null;
    try {
      const fields = { orderedAt };
      if (supplier) fields.supplier = supplier;
      if (hasPrice) fields.unitPrice = unitPrice;
      await updatePurchaseOrderRow(rec, fields);
      tencentWritten = true;
    } catch (e) {
      tencentError = (e && e.message) || String(e);
      console.error("PO placeOrder Tencent write-back failed:", tencentError);
    }

    return res.json({ success: true, status: "ordered", orderedAt, tencentWritten, tencentError });
  } catch (error) {
    console.error("PO placeOrder error:", error);
    return res.status(500).json({ success: false, message: "Failed to place order" });
  }
});

// ── POST /purchaseOrder/markShortage ────────────────────────────────
// Mark a PO as 缺货 (out of stock). This is a dashboard-only flag (there's no
// sheet column for it) — deriveStatus honours `shortage`, so it survives the
// incremental sync. DB-only; nothing is written back to Tencent.
router.post("/markShortage", VIEW, async function (req, res) {
  try {
    const id = String((req.body && req.body.id) || "");
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    let _id;
    try { _id = new ObjectId(id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const db = await connectToDatabase();
    const r = await db.collection(PO_COLLECTION).updateOne(
      { _id },
      { $set: { shortage: true, cancelled: false, status: "shortage", syncedAt: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "PO not found." });
    return res.json({ success: true, status: "shortage" });
  } catch (error) {
    console.error("PO markShortage error:", error);
    return res.status(500).json({ success: false, message: "Failed to mark shortage" });
  }
});

// ── POST /purchaseOrder/cancelOrder ─────────────────────────────────
// Mark a PO as 已取消 (cancelled). Dashboard-only flag (no sheet column) —
// deriveStatus honours `cancelled`, so it survives the incremental sync.
router.post("/cancelOrder", VIEW, async function (req, res) {
  try {
    const id = String((req.body && req.body.id) || "");
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    let _id;
    try { _id = new ObjectId(id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const db = await connectToDatabase();
    const r = await db.collection(PO_COLLECTION).updateOne(
      { _id },
      { $set: { cancelled: true, shortage: false, status: "cancelled", syncedAt: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "PO not found." });
    return res.json({ success: true, status: "cancelled" });
  } catch (error) {
    console.error("PO cancelOrder error:", error);
    return res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
});

// ── POST /purchaseOrder/quotePrice ──────────────────────────────────
// Record a 采购单价 quote for a pending / shortage PO. Stored in a dashboard-only
// `quotedPrice` field — it does NOT change the status (a quote isn't an order),
// isn't written to the sheet, and survives the sync (not a sync-managed field).
router.post("/quotePrice", VIEW, async function (req, res) {
  try {
    const b = req.body || {};
    const id = String(b.id || "");
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    const unitPrice = Number(b.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return res.status(400).json({ success: false, message: "采购单价 must be a valid non-negative number." });
    }
    let _id;
    try { _id = new ObjectId(id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const db = await connectToDatabase();
    const r = await db.collection(PO_COLLECTION).updateOne(
      { _id },
      { $set: { quotedPrice: unitPrice, syncedAt: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "PO not found." });
    return res.json({ success: true, quotedPrice: unitPrice });
  } catch (error) {
    console.error("PO quotePrice error:", error);
    return res.status(500).json({ success: false, message: "Failed to save quote" });
  }
});

// ── POST /purchaseOrder/updateDetail ────────────────────────────────
// Edit an order's 备注 (DB-only — never overwritten by sync) and 订单数量. The
// quantity is part of the row's match key, so a change is mirrored to the sheet
// (non-fatal) to keep the next sync from duplicating the row.
router.post("/updateDetail", VIEW, async function (req, res) {
  try {
    const b = req.body || {};
    const id = String(b.id || "");
    if (!id) return res.status(400).json({ success: false, message: "id is required." });
    let _id;
    try { _id = new ObjectId(id); } catch (e) {
      return res.status(400).json({ success: false, message: "invalid id." });
    }
    const db = await connectToDatabase();
    const col = db.collection(PO_COLLECTION);
    const rec = await col.findOne({ _id });
    if (!rec) return res.status(404).json({ success: false, message: "PO not found." });

    const note = String(b.note || "").trim();
    const hasQty = b.orderQty != null && String(b.orderQty).trim() !== "";
    const orderQty = hasQty ? Number(b.orderQty) : rec.orderQty;
    if (hasQty && (!Number.isFinite(orderQty) || orderQty <= 0)) {
      return res.status(400).json({ success: false, message: "订单数量 must be a positive number." });
    }

    const set = { note, syncedAt: new Date() };
    // 订单数量 can only change while the PO is still 待处理 (pending).
    const qtyChanged = hasQty && orderQty !== rec.orderQty && rec.status === "pending";
    if (qtyChanged) {
      set.orderQty = orderQty;
      set.lineTotal = rec.unitPrice != null ? Math.round(orderQty * rec.unitPrice * 100) / 100 : rec.lineTotal;
    }
    await col.updateOne({ _id }, { $set: set });

    // Quantity is part of the match key → mirror it to the sheet (non-fatal).
    let tencentWritten = null;
    let tencentError = null;
    if (qtyChanged) {
      tencentWritten = false;
      try {
        await updatePurchaseOrderRow(rec, { orderQty });
        tencentWritten = true;
      } catch (e) {
        tencentError = (e && e.message) || String(e);
        console.error("PO updateDetail Tencent write-back failed:", tencentError);
      }
    }
    return res.json({ success: true, orderQty, note, tencentWritten, tencentError });
  } catch (error) {
    console.error("PO updateDetail error:", error);
    return res.status(500).json({ success: false, message: "Failed to update order" });
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
