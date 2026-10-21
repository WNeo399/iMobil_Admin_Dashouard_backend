// New Products (user ask 2026-10-21) — every product created in the
// dashboard, to review its details and prices and order it from the
// supplier. Admin, iMobile Admin and iMobile Warehouse (newproduct:*).
//
// The products are read where the dashboard records them — no list of its
// own to keep in step:
//   · Listing's Create: the `created` entries on the Listing models
//     (imb_spp_new_products), one item can sit on several models — and items
//     made by hand in Zoho filed there afterwards (source "zoho");
//   · Purchase Order's "Create in Zoho": the line's `zohoItem` (imb_spp_orders);
//   · the register rows those two insert at once (addedBy "dashboard create",
//     since 2026-10-20) — a fallback for when and where.
// Their CURRENT details and prices come from the stock register
// (imb_stock_items — the Edit dialog and the price pushes mirror into it);
// the price checks are worked out here from the formula (utils/priceRules),
// since the rows the dashboard inserts start with blank flags.
//
// Reviewed (the user's pick): approved per product in imb_new_item_reviews
// {itemId, sku, reviewedAt, reviewedBy, seen, store}, `seen` = the details and
// prices as they were when approved — the list says what has changed since.
// Approving also shows the product in the online store (user 2026-10-21):
// Zoho Commerce show_in_storefront on (utils/zohoCommerce showItemInStore,
// read back) — a product the store can't show isn't approved. Undoing an
// approval leaves the store as it is.
//
//   GET  /sparePartsPurchase/new-items?search=&reviewed=yes|no|changed&by=&brand=&issues=1&order=yes|no&page=&pageSize=
//   POST /sparePartsPurchase/new-items/review { itemIds: [...], reviewed: true | false, dryRun? }
//
// Ordering: the page adds Spare Parts Purchase lines with POST /orders (the
// Purchase Order page's Add Item) — its own permission, spp:order:create / add.
const express = require("express");
const router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const { imageUrlFromId } = require("../../utils/productImage");
const { PRICE_PLACEHOLDERS, evaluatePriceRule } = require("../../utils/priceRules");
const { productOfItem, showItemInStore } = require("../../utils/zohoCommerce");

const VIEW = requirePermission("newproduct:item:view");
const REVIEW = requirePermission("newproduct:item:review");

const MODELS = "imb_spp_new_products";
const ORDERS = "imb_spp_orders";
const ITEMS = "imb_stock_items";
const REVIEWS = "imb_new_item_reviews";
// a line still on its way (Spare Parts Purchase's OPEN)
const OPEN = ["pending", "toConfirm", "ordered", "shipped", "shortage"];

const str = (v) => String(v == null ? "" : v).trim();
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const time = (d) => (d ? new Date(d).getTime() || 0 : 0);
// where a Spare Parts Purchase line for it files — the same rule as
// sparePartsPurchaseRoutes categoryOfItem (MacBook screens apart; the server
// works it out again when the line is created)
const CLASSIFICATIONS = ["Screen", "MacBook Screen", "Housing", "Middle Frame", "BackCover", "Battery", "Small Parts", "IC", "Tools", "Other"];
const orderCategoryOf = (it) => {
  const c = it && it.classification;
  if (c === "Screen" && (/macbook/i.test(String(it.deviceSeries || "")) || /macbook/i.test(String(it.name || "")))) return "MacBook Screen";
  return CLASSIFICATIONS.includes(c) ? c : "Other";
};

// The price checks — the same as Price Monitoring's (stockMonitorRoutes
// priceHealthFlags) plus the formula verdict.
function priceChecks(row) {
  const real = (v) => (v != null && !PRICE_PLACEHOLDERS.has(v) ? v : null);
  const rates = [row.priceWholesale, row.priceSvip, row.priceVip, row.pricePlatinum];
  const realRates = rates.filter((v) => v != null && !PRICE_PLACEHOLDERS.has(v));
  const s = real(row.priceSvip), w = real(row.priceWholesale), v = real(row.priceVip), p = real(row.pricePlatinum);
  const lte = (a, b) => a == null || b == null || a <= b + 1e-9;
  const rule = evaluatePriceRule(row);
  return {
    priceMissing: rates.some((x) => x == null),
    pricePlaceholder: rates.some((x) => x != null && PRICE_PLACEHOLDERS.has(x)),
    priceBelowCost: row.purchasePrice > 0 && realRates.some((x) => x < row.purchasePrice),
    priceOrderBroken: !(lte(s, v) && lte(w, v) && lte(v, p) && lte(s, p) && lte(w, p)),
    priceRuleBroken: rule.broken,
    priceRule: rule.rule,
    priceExpected: rule.expected,
  };
}

// What a review looked at — compared with the row later ("changed since").
const SEEN_FIELDS = {
  name: "Name",
  quality: "Quality",
  classification: "Classification",
  compatibleModels: "Compatible Models",
  zohoCategoryId: "Category",
  purchasePrice: "Cost",
  pricePlatinum: "Platinum",
  priceVip: "VIP",
  priceSvip: "SVIP",
  priceWholesale: "Wholesale",
};
const seenOf = (row) => Object.fromEntries(Object.keys(SEEN_FIELDS).map((k) => [k, row[k] === undefined ? null : row[k]]));
const changedSince = (seen, row) => (seen
  ? Object.keys(SEEN_FIELDS).filter((k) => k in seen && JSON.stringify(seen[k] === undefined ? null : seen[k]) !== JSON.stringify(row[k] === undefined ? null : row[k])).map((k) => SEEN_FIELDS[k])
  : []);

const REGISTER_FIELDS = {
  _id: 0, itemId: 1, sku: 1, name: 1, imageId: 1, active: 1, te: 1, scope: 1, category: 1,
  classification: 1, subClassification: 1, quality: 1, deviceBrand: 1, deviceSeries: 1, compatibleModels: 1,
  zohoCategoryId: 1, zohoCategory: 1, purchasePrice: 1, showInStore: 1,
  pricePlatinum: 1, priceVip: 1, priceSvip: 1, priceWholesale: 1,
  "metrics.available": 1, firstSeenAt: 1, addedBy: 1,
};

// Every dashboard-created product: itemId → { createdAt, createdBy, via, models, orderNo }.
async function createdProducts(db) {
  const out = new Map();
  const note = (itemId, at, by, via, extra) => {
    const id = str(itemId);
    if (!id) return null;
    let e = out.get(id);
    if (!e) { e = { itemId: id, createdAt: null, createdBy: "", via: [], models: [], orderNo: "" }; out.set(id, e); }
    // the earliest record names when and by whom
    if (at && (!e.createdAt || time(at) < time(e.createdAt))) { e.createdAt = new Date(at); if (by) e.createdBy = by; }
    if (!e.createdBy && by) e.createdBy = by;
    if (via && !e.via.includes(via)) e.via.push(via);
    if (extra) Object.assign(e, extra);
    return e;
  };
  // the three reads at once (the live DB is ~0.2–0.3 s a round trip)
  const [listing, po, reg] = await Promise.all([
    db.collection(MODELS).aggregate([
      { $match: { "created.0": { $exists: true } } },
      { $unwind: "$created" },
      { $project: { _id: 1, brand: 1, model: 1, itemId: "$created.itemId", at: "$created.at", by: "$created.by", source: "$created.source" } },
    ]).toArray(),
    db.collection(ORDERS)
      .find({ "zohoItem.at": { $exists: true }, itemId: { $nin: [null, ""] } }, { projection: { itemId: 1, orderNo: 1, zohoItem: 1 } })
      .toArray(),
    db.collection(ITEMS).find({ addedBy: "dashboard create" }, { projection: { _id: 0, itemId: 1, firstSeenAt: 1 } }).toArray(),
  ]);
  for (const c of listing) {
    // source "zoho": made by hand in Zoho, then filed under the model (2026-10-21)
    const e = note(c.itemId, c.at, c.by, c.source === "zoho" ? "Zoho" : "Listing");
    if (e && !e.models.some((m) => m.id === String(c._id))) e.models.push({ id: String(c._id), brand: c.brand || "", model: c.model || "" });
  }
  for (const o of po) note(o.itemId, o.zohoItem.at, o.zohoItem.by, "Purchase Order", { orderNo: o.orderNo || "" });
  for (const r of reg) note(r.itemId, r.firstSeenAt, "", "");
  return out;
}

// Open Spare Parts Purchase lines per item, by stage.
async function openLinesOf(db, ids) {
  if (!ids.length) return {};
  const qtyIf = (status) => ({ $sum: { $cond: [{ $eq: ["$status", status] }, { $ifNull: [status === "shipped" ? "$shippedQty" : "$orderQty", 0] }, 0] } });
  const rows = await db.collection(ORDERS).aggregate([
    { $match: { itemId: { $in: ids }, status: { $in: OPEN } } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$itemId",
        lines: { $sum: 1 },
        pending: qtyIf("pending"), toConfirm: qtyIf("toConfirm"), ordered: qtyIf("ordered"), shipped: qtyIf("shipped"), shortage: qtyIf("shortage"),
        lastNo: { $first: "$orderNo" },
      },
    },
  ]).toArray();
  return Object.fromEntries(rows.map((r) => [r._id, { lines: r.lines, pending: r.pending, toConfirm: r.toConfirm, ordered: r.ordered, shipped: r.shipped, shortage: r.shortage, lastNo: r.lastNo || "" }]));
}

const ISSUES = [
  ["noCost", "No cost"],
  ["missingPrice", "Missing price"],
  ["belowCost", "Below cost"],
  ["wrongOrder", "Wrong order"],
  ["offFormula", "Off formula"],
  ["noPhoto", "No photo"],
  ["noCategory", "No category"],
];

router.get("/", VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 50));
    const db = await connectToDatabase();
    // two rounds of reads: what was created (+ every review — a small
    // collection), then those items' register rows and open lines
    const [made, reviews] = await Promise.all([createdProducts(db), db.collection(REVIEWS).find({}).toArray()]);
    const ids = [...made.keys()];
    const [regRows, open] = await Promise.all([
      db.collection(ITEMS).find({ itemId: { $in: ids } }, { projection: REGISTER_FIELDS }).toArray(),
      openLinesOf(db, ids),
    ]);
    const regOf = new Map(regRows.map((r) => [r.itemId, r]));
    const reviewOf = new Map(reviews.map((r) => [r.itemId, r]));

    let rows = ids.map((id) => {
      const m = made.get(id);
      const r = regOf.get(id) || { itemId: id };
      const checks = priceChecks(r);
      const issues = {
        noCost: !(r.purchasePrice > 0),
        missingPrice: checks.priceMissing || checks.pricePlaceholder,
        belowCost: checks.priceBelowCost,
        wrongOrder: checks.priceOrderBroken,
        offFormula: checks.priceRuleBroken,
        noPhoto: !r.imageId,
        noCategory: !r.zohoCategoryId,
      };
      const rv = reviewOf.get(id);
      return {
        itemId: id,
        sku: r.sku || "",
        name: r.name || "",
        imageId: r.imageId || null,
        imageUrl: imageUrlFromId(r.imageId),
        inRegister: regOf.has(id),
        active: r.active !== false,
        classification: r.classification || "",
        subClassification: r.subClassification || "",
        quality: r.quality || "",
        deviceBrand: r.deviceBrand || "",
        deviceSeries: r.deviceSeries || "",
        compatibleModels: r.compatibleModels || [],
        zohoCategoryId: r.zohoCategoryId || "",
        zohoCategory: r.zohoCategory || "",
        showInStore: !!r.showInStore,
        suggestedCategory: orderCategoryOf(r),
        available: r.metrics ? r.metrics.available : null,
        purchasePrice: r.purchasePrice == null ? null : r.purchasePrice,
        pricePlatinum: r.pricePlatinum == null ? null : r.pricePlatinum,
        priceVip: r.priceVip == null ? null : r.priceVip,
        priceSvip: r.priceSvip == null ? null : r.priceSvip,
        priceWholesale: r.priceWholesale == null ? null : r.priceWholesale,
        ...checks,
        issues: ISSUES.filter(([k]) => issues[k]).map(([k]) => k),
        createdAt: m.createdAt,
        createdBy: m.createdBy,
        via: m.via,
        orderNo: m.orderNo,
        models: m.models,
        onOrder: open[id] || null,
        reviewed: rv ? { at: rv.reviewedAt, by: rv.reviewedBy || "" } : null,
        changedSinceReview: rv ? changedSince(rv.seen, r) : [],
      };
    });

    // the filters' options and counts, before the filters themselves
    const creators = [...new Set(rows.map((r) => r.createdBy).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const brands = [...new Set(rows.map((r) => r.deviceBrand).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    const search = str(q.search);
    if (search) {
      const words = search.split(/\s+/).filter(Boolean).map((w) => new RegExp(escapeRegex(w), "i"));
      rows = rows.filter((r) => {
        if (String(r.sku).toLowerCase().startsWith(search.toLowerCase())) return true;
        const hay = [r.name, r.classification, r.subClassification, r.quality, r.zohoCategory, ...r.compatibleModels, ...r.models.map((m) => m.model)].join(" ");
        return words.every((rx) => rx.test(hay));
      });
    }
    if (str(q.by)) rows = rows.filter((r) => r.createdBy === str(q.by));
    if (str(q.brand)) rows = rows.filter((r) => r.deviceBrand === str(q.brand));
    if (q.issues === "1" || q.issues === "true") rows = rows.filter((r) => r.issues.length);
    // on order = an open Spare Parts Purchase line for it
    if (q.order === "no") rows = rows.filter((r) => !r.onOrder);
    else if (q.order === "yes") rows = rows.filter((r) => r.onOrder);
    const counts = {
      all: rows.length,
      notReviewed: rows.filter((r) => !r.reviewed).length,
      reviewed: rows.filter((r) => r.reviewed).length,
      changed: rows.filter((r) => r.reviewed && r.changedSinceReview.length).length,
    };
    if (q.reviewed === "no") rows = rows.filter((r) => !r.reviewed);
    else if (q.reviewed === "yes") rows = rows.filter((r) => r.reviewed);
    else if (q.reviewed === "changed") rows = rows.filter((r) => r.reviewed && r.changedSinceReview.length);

    // newest first (the SKU breaks a tie — one create batch shares a minute)
    rows.sort((a, b) => time(b.createdAt) - time(a.createdAt) || String(b.sku).localeCompare(String(a.sku), undefined, { numeric: true }));
    const total = rows.length;
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    return res.json({ success: true, total, page, pageSize, counts, creators, brands, issueLabels: Object.fromEntries(ISSUES), rows: pageRows });
  } catch (error) {
    next(error);
  }
});

router.post("/review", REVIEW, async (req, res, next) => {
  try {
    const b = req.body || {};
    const itemIds = [...new Set((Array.isArray(b.itemIds) ? b.itemIds : []).map(str).filter((x) => /^\d{6,30}$/.test(x)))];
    if (!itemIds.length) return res.status(400).json({ success: false, message: "No products picked" });
    if (itemIds.length > 200) return res.status(400).json({ success: false, message: "At most 200 products at a time" });
    if (typeof b.reviewed !== "boolean") return res.status(400).json({ success: false, message: "Say whether they are reviewed" });
    // approving is 2–3 Zoho Commerce calls a product
    if (b.reviewed && itemIds.length > 50) return res.status(400).json({ success: false, message: "Approve at most 50 products at a time" });
    const db = await connectToDatabase();
    // only products the dashboard created
    const made = await createdProducts(db);
    const unknown = itemIds.filter((id) => !made.has(id));
    if (unknown.length) return res.status(400).json({ success: false, message: `${unknown.length} of these weren't created in the dashboard` });
    const col = db.collection(REVIEWS);
    await col.createIndex({ itemId: 1 }, { unique: true });
    if (!b.reviewed) {
      await col.deleteMany({ itemId: { $in: itemIds } });
      return res.json({ success: true, reviewed: Object.fromEntries(itemIds.map((id) => [id, null])) });
    }
    const regRows = await db.collection(ITEMS).find({ itemId: { $in: itemIds } }, { projection: REGISTER_FIELDS }).toArray();
    const regOf = new Map(regRows.map((r) => [r.itemId, r]));
    // dryRun: only what the store has now (nothing changed)
    if (b.dryRun) {
      const plan = [];
      for (const itemId of itemIds) {
        const sku = (regOf.get(itemId) || {}).sku || "";
        try {
          const p = await productOfItem(itemId, sku);
          plan.push({ itemId, sku, productId: p ? p.productId : null, shown: p ? p.shown : null, would: !p ? "refuse: not in the store" : p.shown ? "approve (already shown)" : "show in store, then approve" });
        } catch (e) {
          plan.push({ itemId, sku, error: e.message });
        }
      }
      return res.json({ success: true, dryRun: true, plan });
    }
    // the store first, one product at a time; only the ones it shows are approved
    const at = new Date();
    const by = actor(req);
    const store = {};
    const failed = [];
    for (const itemId of itemIds) {
      const sku = (regOf.get(itemId) || {}).sku || "";
      try {
        const r = await showItemInStore(itemId, sku);
        store[itemId] = { productId: r.productId, already: r.already };
      } catch (e) {
        failed.push({ itemId, sku, message: e.message });
      }
    }
    const ok = itemIds.filter((id) => store[id]);
    if (ok.length) {
      await col.bulkWrite(ok.map((itemId) => {
        const r = regOf.get(itemId) || {};
        return {
          updateOne: {
            filter: { itemId },
            update: { $set: { itemId, sku: r.sku || "", reviewedAt: at, reviewedBy: by, seen: seenOf(r), store: { ...store[itemId], at } } },
            upsert: true,
          },
        };
      }));
      // the register follows the store at once (the refresh would, later)
      await db.collection(ITEMS).updateMany({ itemId: { $in: ok } }, { $set: { showInStore: true } });
    }
    return res.json({
      success: true,
      reviewed: Object.fromEntries(ok.map((id) => [id, { at, by }])),
      store,
      failed,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
