// Spare Parts Purchase — the in-app purchase process for spare parts
// (2026-09-22). It replaces the Tencent-sheet flow of
// routes/purchaseOrderRoutes: nobody edits a shared spreadsheet any more;
// every step is an action here, with an audit trail on the line. The
// orders still open in the sheet get imported once, when this goes live.
//
// Data
//   imb_spp_orders     one record per item line, SP-10001+
//   imb_spp_batches    one shipment to iMobile, PB-10001+, with copies of its lines
//   imb_spp_order_batches  下单批次: lines placed with one supplier, OB-10001+;
//                      a draft (no number, lines untouched) until confirmed
//   imb_spp_counters   the two number sequences
//
// Line status
//   pending    iMobile asked for it                       POST /orders
//   ordered    the purchase side has bought it            /orders/:id/place (supplier, unit price)
//   shipped    on a batch to iMobile                      POST /batches
//   received   iMobile has it                             /batches/:id/receive
//   shortage   the purchase side cannot get it            /orders/:id/shortage
//   cancelled  iMobile withdrew it                        /orders/:id/cancel
// shortage / cancelled lines can be reopened to pending. A line ships ONCE:
// a short shipment records the smaller quantity and the line closes as
// shipped, and the remainder is carried over automatically as a NEW pending
// line (same item; the supplier and price stay on it as a reference for the
// next placing; `splitFrom` / `splitTo` link the two).
//
// Permissions (constants/roles.js)
//   spp:order:view      read the orders                 admin, iMobile admin, parts supplier
//   spp:order:create    create / edit / cancel          admin, iMobile admin, parts supplier (since 2026-10-14)
//   spp:order:add       add lines (Add Item, New Product — not Special Order)
//                                                       admin, iMobile admin, parts supplier
//   spp:order:supply    quote / place / shortage        admin, iMobile admin, parts supplier
//   spp:order:receive   receive a batch                  admin, iMobile admin (NOT the parts supplier)
//   spp:order:complete  Mark as completed on a line      the parts supplier too (2026-10-15); receivers via spp:*:*
//   spp:product:create  create a New Product line's item in Zoho (also New Products)
//                                                       admin, iMobile admin, iMobile purchase, warehouse, parts supplier
//   spp:batch:view      read the batches                all three
//   spp:batch:create    create a batch                  all three
//   spp:batch:manage    edit tracking / date, cancel    all three
//
// Dates: `*At` timestamps are the server clock; the day-only fields
// (shippedAt, receivedAt) come from the client as YYYY-MM-DD and are stored
// as that day at 00:00 UTC, so the first ten characters read back as the day.

const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { hasPermission } = require("../../constants/roles");
const { connectToDatabase } = require("../../utils/mongodb");
const { imageUrlFromId } = require("../../utils/productImage");
const { createBatchPurchaseOrders, cancelBatchPurchaseOrders, syncBatchReference, syncBatchShipping, ZOHO_VENDORS, vendorById } = require("../../utils/sppZoho");
const { MAX_IMAGES, acceptImage, storeImage, removeImage } = require("../../utils/sppImages");
const { refreshToken } = require("../../utils/zohoRequest");
const zohoItem = require("../../utils/zohoNewItem");
// "Create in Zoho" (2026-10-16): the pricing formula for a typed cost, and the store categories
const { PRICE_FORMULAS, priceRuleFamily } = require("../../utils/priceRules");
const { loadCategories, findCategory } = require("../websiteRoutes/categories");
const { ZOHO_CLASSIFICATIONS, qualitiesByClassification } = require("../../utils/listingQualities");

const ORDERS = "imb_spp_orders";
const BATCHES = "imb_spp_batches";
// 下单批次: a set of pending lines placed with one supplier at once (OB-10001+);
// the supplier's quoted prices come back onto its lines from here.
const ORDER_BATCHES = "imb_spp_order_batches";
const COUNTERS = "imb_spp_counters";
const ITEMS = "imb_stock_items";
// InFlow's Order Dispatch records — read for an Oscar return code scanned
// with no purchase line behind it (the record maps Oscar's SKU to ours)
const DISPATCH_UPLOADS = "inflow_dispatch_uploads";

const VIEW = requirePermission("spp:order:view");
const CREATE = requirePermission("spp:order:create");
const SUPPLY = requirePermission("spp:order:supply");
const RECEIVE = requirePermission("spp:order:receive");
const BATCH_VIEW = requirePermission("spp:batch:view");
const BATCH_CREATE = requirePermission("spp:batch:create");
const BATCH_MANAGE = requirePermission("spp:batch:manage");
// Either side may do it (cancel, reopen).
const requireAny = (...perms) => (req, res, next) => {
  const have = (req.user && req.user.permissions) || [];
  if (perms.some((p) => hasPermission(have, p))) return next();
  return res.status(403).json({ success: false, message: "You do not have permission for this action" });
};
const CREATE_OR_SUPPLY = requireAny("spp:order:create", "spp:order:supply");
// Adding lines: iMobile, or the parts supplier (spp:order:add, 2026-10-07).
const ADD = requireAny("spp:order:create", "spp:order:add");

const STATUSES = ["pending", "toConfirm", "ordered", "shipped", "received", "shortage", "cancelled"];
// "open" = still to arrive
const OPEN = ["pending", "toConfirm", "ordered", "shipped", "shortage"];
// Where a line files in the tree: the register classification of its item
// (set automatically on create, 2026-09-22), or one of the two channels the
// team keeps apart — sea-freight orders (海运) and customer special orders.
// MacBook Screen (2026-10-15, user): MacBook screens are a category of their
// own — a register item classified Screen on a MacBook (device series, or
// the name says so) files there instead of under Screen.
const MACBOOK_SCREEN = "MacBook Screen";
const CLASSIFICATIONS = ["Screen", MACBOOK_SCREEN, "Housing", "Middle Frame", "BackCover", "Battery", "Small Parts", "IC", "Tools", "Other"];
const isMacBookItem = (it) => /macbook/i.test(String((it && it.deviceSeries) || "")) || /macbook/i.test(String((it && it.name) || ""));
// A register item's module category: its classification, MacBook screens
// apart; blank / unknown → Other.
const categoryOfItem = (it) => {
  const c = it && it.classification;
  if (c === "Screen" && isMacBookItem(it)) return MACBOOK_SCREEN;
  return CLASSIFICATIONS.includes(c) ? c : "Other";
};
// Warranty (2026-10-14): replacement parts claimed from the supplier — a
// pinned list on the Purchase Order page; its lines carry price 0 and ship
// as warranty (no charge on the Zoho PO).
const WARRANTY = "Warranty";
const SEA = "海运";
const CHANNELS = [SEA, "Special Order", "New Product", WARRANTY];
// A dispatch batch ships by sea (海运) or by air (空运), chosen before it is
// built (user ask 2026-10-16), and takes only its own kind of line: 海运 =
// the 海运 category, 空运 = every other one (the analytics split). Batches
// from before then carry no freight — they were all air.
const FREIGHTS = ["sea", "air"];
const FREIGHT_LABEL = { sea: SEA, air: "空运" };
const lineFreight = (rec) => (rec && rec.category === SEA ? "sea" : "air");
const freightError = (rec, freight) =>
  `${rec.sku || rec.orderNo || rec.productName} is a ${FREIGHT_LABEL[lineFreight(rec)]} line — it can't go on a ${FREIGHT_LABEL[freight]} batch`;
const CATEGORIES = [...CLASSIFICATIONS, ...CHANNELS];
const isChannel = (c) => CHANNELS.includes(c);
// A New Product or Special Order line (user rules 2026-10-06) is quoted
// first: the supplier quotes it, the quote parks it in To Confirm, and only
// once iMobile confirms it is it placed, put on an order batch or shipped
// like any other line. Until then it "awaits a quote".
const NEW_PRODUCT = "New Product";
const SPECIAL_ORDER = "Special Order";
const QUOTE_FIRST = [NEW_PRODUCT, SPECIAL_ORDER];
// A Special Order raised with "Needs a quote first" unticked (needsQuote:
// false, 2026-10-14) skips the quote step and is ordered like any other line.
const awaitsQuote = (r) => !!r && QUOTE_FIRST.includes(r.category) && ["pending", "shortage"].includes(r.status) && !r.confirmed && r.needsQuote !== false;
// A Special Order says who it is for (a preset name or one typed) and
// whether it is urgent.
const forOf = (v) => str(v).slice(0, 60);
// The register's say on a line's item: its classification as a module
// category (blank / unknown → Other) and its image id.
async function registerFacts(db, itemId) {
  if (!itemId) return { category: "Other", imageId: null };
  const it = await db.collection(ITEMS).findOne({ itemId: String(itemId) }, { projection: { _id: 0, classification: 1, imageId: 1, name: 1, deviceSeries: 1 } });
  return { category: categoryOfItem(it), imageId: (it && it.imageId) || null };
}

// A 海运 line files under 海运, and within it under its item's own category
// (user ask 2026-10-16: 海运 has the same tabs as 空运) — worked out from the
// register once and kept on the line as `itemCategory` (a line without an
// item → Other). Lines that lack it get it here, whichever way they were made.
async function fillSeaCategories(db) {
  const col = db.collection(ORDERS);
  const todo = await col.find({ category: SEA, itemCategory: { $exists: false } }, { projection: { itemId: 1 } }).limit(5000).toArray();
  if (!todo.length) return;
  const ids = [...new Set(todo.map((r) => r.itemId).filter(Boolean).map(String))];
  const items = ids.length ? await db.collection(ITEMS).find({ itemId: { $in: ids } }, { projection: { _id: 0, itemId: 1, classification: 1, name: 1, deviceSeries: 1 } }).toArray() : [];
  const byItem = new Map(items.map((it) => [String(it.itemId), categoryOfItem(it)]));
  await col.bulkWrite(
    todo.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { itemCategory: (r.itemId && byItem.get(String(r.itemId))) || "Other" } } } })),
    { ordered: false },
  );
}

const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const oid = (v) => { try { return new ObjectId(String(v)); } catch (e) { return null; } };
const str = (v) => String(v == null ? "" : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Oscar's return code "SS-<prefix>-<customer SKU>" — the supplier card of the
// Oscar label set; the prefix is the dispatch record's faultyCodePrefix
// (normally six digits). The team scans it on a dispatch batch (user
// 2026-10-14): prefix + customer SKU name the purchase line raised for
// OSCAR from that dispatch.
const OSCAR_CODE = /^SS-(\d+)-(.+)$/i;
// what a line raised for a customer carries onto a batch line (its labels)
const oscarFacts = (rec) => (rec && rec.forCustomer ? {
  forCustomer: rec.forCustomer,
  customerSku: (rec.dispatchRef && rec.dispatchRef.customerSku) || "",
  customerDescription: (rec.dispatchRef && rec.dispatchRef.customerDescription) || "",
  oscarPrefix: (rec.dispatchRef && rec.dispatchRef.faultyCodePrefix) || "",
} : {});
// a not-in-PO line scanned as an Oscar return code: the line it raises is marked for OSCAR
const oscarRefOf = (code) => {
  const m = str(code).match(OSCAR_CODE);
  if (!m) return {};
  return { forCustomer: "OSCAR", dispatchRef: { recordId: "", invoiceNumber: "", customerName: "Oscar Mobile Pty Ltd", faultyCodePrefix: m[1], customerSku: str(m[2]).slice(0, 80), customerDescription: "" } };
};
// the register item as the scan lookup answers it
const ITEM_BRIEF = { _id: 0, itemId: 1, sku: 1, name: 1, classification: 1, imageId: 1 };
const itemBrief = (item) => (item ? { itemId: item.itemId, sku: item.sku, name: item.name || "", classification: item.classification || "", suggestedCategory: categoryOfItem(item), imageId: item.imageId || null, imageUrl: imageUrlFromId(item.imageId) } : null);
// ordered lines before pending ones, oldest first
const openFirst = (a, b) => (a.status === "ordered" ? 0 : 1) - (b.status === "ordered" ? 0 : 1) || new Date(a.orderedAt || a.createdAt) - new Date(b.orderedAt || b.createdAt);
const hasVal = (v) => v !== undefined && v !== null && String(v).trim() !== "";
const bad = (res, message) => res.status(400).json({ success: false, message });

// A day from the client ("YYYY-MM-DD") → that day at 00:00 UTC; blank → today
// in Melbourne, the business day the team works in.
function dayDate(ymd) {
  const s = str(ymd);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`);
  const p = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date())
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
}

// SP-10001 / PB-10001 …: one atomic counter per sequence, holding the last
// number issued. It can never fall behind the records themselves: the next
// number is max(counter, highest seq on file) + 1, so a reset or a hand
// insert cannot produce a duplicate.
async function nextNo(db, key, prefix, start, coll) {
  const last = await db.collection(coll).find({}, { projection: { _id: 0, seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  const floor = Math.max(start - 1, (last[0] && last[0].seq) || 0);
  const r = await db.collection(COUNTERS).findOneAndUpdate(
    { _id: key },
    [{ $set: { seq: { $add: [{ $max: [{ $ifNull: ["$seq", 0] }, floor] }, 1] } } }],
    { upsert: true, returnDocument: "after" },
  );
  const doc = r && r.value !== undefined ? r.value : r;
  const seq = doc.seq;
  return { seq, no: `${prefix}-${seq}` };
}

const hist = (action, by, detail) => ({ at: new Date(), by, action, ...(detail ? { detail } : {}) });

// The 供应商 pick list: suppliers used in this module (busiest first), then
// the ones on the old sheet-synced records, so the list is useful from day
// one. Status words the old purchase team typed into that cell are not
// suppliers, and one-off entries there are mostly typos. Typing a new
// name is still allowed on the page.
const LEGACY_PO = "imb_purchase_order";
const NOT_SUPPLIERS = ["取消", "没货", "缺货", "暂时没货", "暂时缺", "太贵不要", "库存", "市场"];
async function supplierOptions(db) {
  const byUse = (coll, extra) =>
    db
      .collection(coll)
      .aggregate([
        { $match: { supplier: { $nin: ["", null, ...NOT_SUPPLIERS] } } },
        { $group: { _id: "$supplier", n: { $sum: 1 } } },
        ...(extra || []),
        { $sort: { n: -1, _id: 1 } },
        { $limit: 200 },
      ])
      .toArray()
      .catch(() => []);
  const [own, legacy] = await Promise.all([byUse(ORDERS), byUse(LEGACY_PO, [{ $match: { n: { $gte: 2 } } }])]);
  return [...new Set([...own.map((s) => s._id), ...legacy.map((s) => s._id)])];
}

// ── Products (for Create PO) ────────────────────────────────────────
// Live parts from the stock register, by name or SKU. Exact SKU first.
router.get("/products/search", requireAny("spp:order:view", "spp:batch:create"), async (req, res, next) => {
  try {
    const q = str(req.query.q);
    if (!q) return res.json({ success: true, products: [] });
    // every word must appear in the name (any order), or the whole query is
    // the start of a SKU — a bare number like "15" must not sweep up every
    // SKU that happens to contain it
    const words = q.split(/\s+/).filter(Boolean).map((w) => new RegExp(escapeRegex(w), "i"));
    const db = await connectToDatabase();
    const rows = await db
      .collection(ITEMS)
      .find(
        { active: true, scope: "parts", $or: [{ sku: new RegExp("^" + escapeRegex(q), "i") }, { $and: words.map((rx) => ({ name: rx })) }] },
        { projection: { _id: 0, itemId: 1, sku: 1, name: 1, imageId: 1, classification: 1, subClassification: 1, "metrics.available": 1 } },
      )
      .limit(25)
      .toArray();
    const exact = (r) => (String(r.sku).toLowerCase() === q.toLowerCase() ? 0 : 1);
    rows.sort((a, b) => exact(a) - exact(b) || String(a.name).localeCompare(String(b.name)));
    const products = rows.slice(0, 20).map((r) => ({
      itemId: r.itemId,
      sku: r.sku || "",
      name: r.name || "",
      imageId: r.imageId || null,
      imageUrl: imageUrlFromId(r.imageId),
      classification: r.classification || "",
      available: r.metrics ? r.metrics.available : null,
      // where a line for it files (the server derives the same on create)
      suggestedCategory: categoryOfItem(r),
    }));
    return res.json({ success: true, products });
  } catch (error) {
    next(error);
  }
});

// ── Orders ──────────────────────────────────────────────────────────
// The list with everything the page needs: one page of lines, the status
// breakdown (over category / supplier / search, ignoring the status pick),
// per-category totals + open counts for the tree, and the pick lists.
router.get("/orders", VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const base = {};
    if (q.category) {
      base.category = str(q.category);
      // a tab under 海运: its lines of that item category
      if (base.category === SEA && str(q.seaCategory)) base.itemCategory = str(q.seaCategory);
    }
    // categories the list leaves out (the Purchase Order page's 空运 skips
    // the ones pinned above its tree, and 海运)
    else if (str(q.excludeCategory)) base.category = { $nin: str(q.excludeCategory).split(",").map((c) => c.trim()).filter(Boolean) };
    if (q.supplier) base.supplier = str(q.supplier);
    // one item's lines (the Stock Monitoring item drawer)
    if (q.itemId) base.itemId = str(q.itemId);
    const search = str(q.search);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      base.$or = [{ sku: rx }, { productName: rx }, { orderNo: rx }, { supplier: rx }, { tracking: rx }, { batchNo: rx }, { note: rx }, { requestedFor: rx }];
    }
    const match = { ...base };
    const statuses = str(q.status).split(",").map((s) => s.trim()).filter((s) => STATUSES.includes(s));
    if (statuses.length) match.status = { $in: statuses };
    else if (String(q.open) === "1") match.status = { $in: OPEN };
    const dir = String(q.sort) === "oldest" ? 1 : -1;

    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    await fillSeaCategories(db);
    const counts = { total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", OPEN] }, 1, 0] } }, pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } } };
    const [rows, total, statusAgg, catAgg, seaAgg, suppliers] = await Promise.all([
      col.find(match, { projection: { history: 0 } }).sort(String(q.sort) === "received" ? { receivedAt: -1, _id: -1 } : { createdAt: dir, _id: dir }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      col.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
      col.aggregate([{ $group: { _id: "$category", ...counts } }]).toArray(),
      // 海运's tabs: its lines by their item's category
      col.aggregate([{ $match: { category: SEA } }, { $group: { _id: "$itemCategory", ...counts } }]).toArray(),
      supplierOptions(db),
    ]);
    const byStatus = {};
    for (const s of statusAgg) byStatus[s._id] = s.n;
    const byCategory = {};
    for (const c of catAgg) byCategory[c._id || ""] = { total: c.total, open: c.open, pending: c.pending };
    const bySeaCategory = {};
    for (const c of seaAgg) bySeaCategory[c._id || "Other"] = { total: c.total, open: c.open, pending: c.pending };
    // the fixed tree, plus any value a line somehow still carries
    const categories = [...new Set([...CATEGORIES, ...catAgg.map((c) => c._id).filter(Boolean)])];
    return res.json({ success: true, page, pageSize, total, rows, byStatus, byCategory, bySeaCategory, categories, suppliers });
  } catch (error) {
    next(error);
  }
});

// The pick lists on their own (the Batches page needs the suppliers).
router.get("/meta", requireAny("spp:order:view", "spp:batch:create"), async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    return res.json({ success: true, categories: CATEGORIES, suppliers: await supplierOptions(db), zohoVendors: ZOHO_VENDORS });
  } catch (error) {
    next(error);
  }
});

// The ordered (then pending) lines waiting to ship — the Create Batch picker.
// ?freight=sea|air: only the lines a batch of that kind takes.
router.get("/orders/open-lines", BATCH_VIEW, async (req, res, next) => {
  try {
    const search = str(req.query.search);
    const match = { status: { $in: ["ordered", "pending"] } };
    const freight = str(req.query.freight);
    if (freight === "sea") match.category = SEA;
    else if (freight === "air") match.category = { $ne: SEA };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ sku: rx }, { productName: rx }, { orderNo: rx }, { supplier: rx }, { category: rx }];
    }
    const db = await connectToDatabase();
    const rows = await db
      .collection(ORDERS)
      .find(match, { projection: { history: 0 } })
      .sort({ createdAt: 1 })
      // the picker groups every waiting line by category client-side, so
      // no small cap (300 used to hide the newest lines once 400+ waited)
      .limit(search ? 300 : 3000)
      .toArray();
    rows.sort((a, b) => (a.status === "ordered" ? 0 : 1) - (b.status === "ordered" ? 0 : 1) || new Date(a.orderedAt || a.createdAt) - new Date(b.orderedAt || b.createdAt));
    return res.json({ success: true, rows: rows.filter((r) => !awaitsQuote(r)) });
  } catch (error) {
    next(error);
  }
});

// Scan-to-batch: the OLDEST waiting line for a SKU (ordered before pending;
// iMobile's own lines before ones raised for a customer such as OSCAR),
// skipping ids already on the batch being built, so scanning the same SKU
// again walks to its next order. ?freight=sea|air (the batch's kind): only
// lines of that kind match; when the SKU waits only on the other kind the
// reply says so (`otherFreight`) instead of treating the scan as not in PO.
router.get("/orders/lookup", BATCH_VIEW, async (req, res, next) => {
  try {
    const sku = str(req.query.sku);
    if (!sku) return bad(res, "sku is required");
    const exclude = new Set(str(req.query.exclude).split(",").map((s) => s.trim()).filter(Boolean));
    const freight = FREIGHTS.includes(str(req.query.freight)) ? str(req.query.freight) : "";
    const db = await connectToDatabase();
    const usable = (list) => list.filter((r) => !exclude.has(String(r._id)) && !awaitsQuote(r)).sort(openFirst);
    const openOnes = (list) => usable(list).filter((r) => !freight || lineFreight(r) === freight);
    const elsewhere = (list) => {
      if (!freight) return null;
      const other = usable(list).filter((r) => lineFreight(r) !== freight);
      return other.length ? { freight: lineFreight(other[0]), label: FREIGHT_LABEL[lineFreight(other[0])], count: other.length, orderNo: other[0].orderNo } : null;
    };
    const oc = sku.match(OSCAR_CODE);
    if (oc) {
      // Oscar's return code (user 2026-10-14): the line raised for OSCAR
      // from that dispatch record, by prefix + customer SKU
      const prefix = oc[1];
      const customerSku = str(oc[2]);
      const oscar = { prefix, customerSku };
      const ref = { "dispatchRef.faultyCodePrefix": prefix, "dispatchRef.customerSku": new RegExp(`^${escapeRegex(customerSku)}$`, "i") };
      const rows = await db.collection(ORDERS).find({ status: { $in: ["ordered", "pending"] }, ...ref }, { projection: { history: 0 } }).toArray();
      const candidates = openOnes(rows);
      if (candidates.length) return res.json({ success: true, match: candidates[0], remaining: candidates.length - 1, all: candidates, oscar });
      const otherFreight = elsewhere(rows);
      if (otherFreight) return res.json({ success: true, match: null, otherFreight, oscar });
      // no open line behind the code: the product it stands for — from the
      // last line raised for it, else the dispatch record's own SKU mapping
      const prev = await db.collection(ORDERS).find(ref, { projection: { itemId: 1, sku: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).toArray();
      let q = null;
      if (prev[0] && prev[0].itemId) q = { itemId: String(prev[0].itemId) };
      else {
        const rec = await db.collection(DISPATCH_UPLOADS).findOne({ faultyCodePrefix: prefix }, { projection: { lineItems: 1 } });
        const li = rec && (rec.lineItems || []).find((l) => str(l.sku).toLowerCase() === customerSku.toLowerCase());
        const imbSku = li ? str(li.imbSku) : (prev[0] && str(prev[0].sku)) || "";
        if (imbSku) q = { sku: new RegExp(`^${escapeRegex(imbSku)}$`, "i") };
      }
      const item = q ? await db.collection(ITEMS).findOne(q, { projection: ITEM_BRIEF }) : null;
      return res.json({ success: true, match: null, hadWaiting: rows.length > 0, oscar, item: itemBrief(item) });
    }
    const rows = await db
      .collection(ORDERS)
      .find({ status: { $in: ["ordered", "pending"] }, sku: new RegExp(`^${escapeRegex(sku)}$`, "i") }, { projection: { history: 0 } })
      .toArray();
    // A plain SKU scan is iMobile's stock first: lines raised for a customer
    // (OSCAR) only once no iMobile line waits — those answer to their return code.
    const candidates = openOnes(rows).sort((a, b) => (a.forCustomer ? 1 : 0) - (b.forCustomer ? 1 : 0));
    if (!candidates.length) {
      const otherFreight = elsewhere(rows);
      if (otherFreight) return res.json({ success: true, match: null, otherFreight });
      // Not on any order (user ask 2026-10-13: such a scan is kept on the
      // batch for adjustment): the register's name for the SKU, if known.
      const item = await db.collection(ITEMS).findOne({ sku: new RegExp(`^${escapeRegex(sku)}$`, "i") }, { projection: ITEM_BRIEF });
      return res.json({ success: true, match: null, hadWaiting: rows.length > 0, item: itemBrief(item) });
    }
    // `all`: every waiting line for the SKU (oldest first) — the batch form
    // brings the ones for the same destination in together (one row, the
    // shipped count spread over them oldest first; user ask 2026-10-16)
    return res.json({ success: true, match: candidates[0], remaining: candidates.length - 1, all: candidates });
  } catch (error) {
    next(error);
  }
});

router.get("/orders/:id", VIEW, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    return res.json({ success: true, order });
  } catch (error) {
    next(error);
  }
});

// ── Photos on a line ────────────────────────────────────────────────
// Mostly New Product / Special Order lines (no Zoho item to show), added
// from the Order New Product dialog or the details. Either side may add or
// remove one.
router.post("/orders/:id/images", requireAny("spp:order:create", "spp:order:supply"), acceptImage, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    if (!req.file) return bad(res, "An image file is required");
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id }, { projection: { orderNo: 1, images: 1 } });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    if ((rec.images || []).length >= MAX_IMAGES) return bad(res, `A line can carry at most ${MAX_IMAGES} photos`);
    let image;
    try {
      image = await storeImage(req.file, rec.orderNo);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ success: false, message: e.message });
      throw e;
    }
    const by = actor(req);
    image.at = new Date();
    image.by = by;
    await col.updateOne({ _id }, { $push: { images: image, history: hist("photo", by, { added: image.name || image.id }) }, $set: { updatedAt: new Date() } });
    return res.json({ success: true, image });
  } catch (error) {
    next(error);
  }
});

router.delete("/orders/:id/images/:imageId", requireAny("spp:order:create", "spp:order:supply"), async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id }, { projection: { images: 1 } });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    const image = (rec.images || []).find((i) => i.id === req.params.imageId);
    if (!image) return res.status(404).json({ success: false, message: "Photo not found" });
    await col.updateOne({ _id }, { $pull: { images: { id: image.id } }, $push: { history: hist("photo", actor(req), { removed: image.name || image.id }) }, $set: { updatedAt: new Date() } });
    await removeImage(image.key);
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── A New Product line → a Zoho item (user ask 2026-10-08) ──────────
// The line is a product not in Zoho yet; the dialog on the Purchase Order
// page creates it there (set up like the New Products page's items:
// utils/zohoNewItem) and links the line to it.
const PRODUCT_CREATE = requirePermission("spp:product:create");
const jsonOr = (v, fallback) => {
  if (typeof v !== "string") return v === undefined || v === null ? fallback : v;
  if (!v.trim()) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
};
const listOf = (v) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(/[;\n]/)).map((x) => str(x)).filter(Boolean);

// GET /zoho-item/options?brand= — the dialog's pick lists, from the stock
// register: classifications with their sub classifications, device brands
// (by how many parts use them), and for a brand its series and models (each
// model with every series its parts are filed under, most used first).
router.get("/zoho-item/options", PRODUCT_CREATE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const items = db.collection(ITEMS);
    const base = { active: { $ne: false }, scope: "parts" };
    // only Zoho's agreed classifications (the register also holds stray values
    // like "Phones" or "-"; "MacBook Screen" is a purchase category, not a
    // Zoho one), each listed even when no part uses it yet
    const cls = await items.aggregate([
      { $match: { ...base, classification: { $in: ZOHO_CLASSIFICATIONS } } },
      { $group: { _id: { c: "$classification", s: { $ifNull: ["$subClassification", ""] } }, n: { $sum: 1 } } },
    ]).toArray();
    const byClass = new Map(ZOHO_CLASSIFICATIONS.map((c) => [c, { value: c, count: 0, subs: [] }]));
    for (const x of cls) {
      const c = byClass.get(x._id.c) || { value: x._id.c, count: 0, subs: [] };
      c.count += x.n;
      if (x._id.s) c.subs.push({ value: x._id.s, count: x.n });
      byClass.set(x._id.c, c);
    }
    const classifications = [...byClass.values()].sort((a, b) => b.count - a.count);
    classifications.forEach((c) => c.subs.sort((a, b) => b.count - a.count));
    const brands = (await items.aggregate([
      { $match: { ...base, deviceBrand: { $nin: [null, ""] } } },
      { $group: { _id: "$deviceBrand", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray()).map((x) => ({ value: x._id, count: x.n }));

    let series = [];
    let models = [];
    const modelCategories = {};
    const brand = str(req.query.brand);
    if (brand) {
      const rows = await items.find({ ...base, deviceBrand: brand }, { projection: { _id: 0, deviceSeries: 1, compatibleModels: 1 } }).toArray();
      const seriesCount = new Map();
      const modelSeries = new Map();
      for (const r of rows) {
        const ss = listOf(r.deviceSeries);
        ss.forEach((x) => seriesCount.set(x, (seriesCount.get(x) || 0) + 1));
        for (const m of r.compatibleModels || []) {
          if (!modelSeries.has(m)) modelSeries.set(m, new Map());
          ss.forEach((x) => modelSeries.get(m).set(x, (modelSeries.get(m).get(x) || 0) + 1));
        }
      }
      series = [...seriesCount.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
      models = [...modelSeries.entries()]
        .map(([model, sm]) => ({ model, series: [...sm.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x) }))
        .sort((a, b) => a.model.localeCompare(b.model, "en", { numeric: true }));
      // The store category each New Products model of the brand is linked to,
      // by the names the register uses for it ("Motorola Moto G96", its other
      // names too) — the dialog files the item under the first picked one's.
      const linked = await db.collection("imb_spp_new_products")
        .find({ brand: new RegExp(`^${escapeRegex(brand)}$`, "i"), active: { $ne: false }, categoryId: { $nin: [null, ""] } }, { projection: { model: 1, compatibleModel: 1, aliases: 1, categoryId: 1, categoryPath: 1 } })
        .toArray();
      for (const m of linked) {
        const names = [m.compatibleModel, `${brand} ${m.model}`, ...(m.aliases || []).map((a) => `${brand} ${a}`)];
        for (const n of names) {
          const k = str(n).toLowerCase();
          if (k && !modelCategories[k]) modelCategories[k] = { model: m.model, categoryId: m.categoryId, categoryPath: m.categoryPath || "" };
        }
      }
    }
    return res.json({
      success: true,
      classifications,
      brands,
      series,
      models,
      modelCategories,
      qualities: await zohoItem.qualityOptions(db),
      placeholderRate: zohoItem.PLACEHOLDER_RATE,
      priceLists: Object.entries(zohoItem.PRICE_LISTS).map(([key, v]) => ({ key, label: v.label })),
      // the pricing formula and which one each classification takes (a
      // "Service Pack" quality switches to that one, as on New Products)
      priceFormulas: PRICE_FORMULAS,
      priceFamilies: Object.fromEntries(ZOHO_CLASSIFICATIONS.map((c) => [c, priceRuleFamily({ classification: c })])),
      // the qualities each classification comes in (iMobile Listing → Qualities); none = every one
      qualitiesByClass: await qualitiesByClassification(db),
    });
  } catch (error) {
    next(error);
  }
});

// The store categories (Zoho Commerce, the tree Inventory files items under)
// for the dialog's Category picker — the Categories page's minute cache.
router.get("/zoho-item/categories", PRODUCT_CREATE, async (req, res) => {
  try {
    return res.json({ success: true, categories: await loadCategories(req.query.refresh === "1") });
  } catch (e) {
    console.error("Create in Zoho categories error:", e.message);
    return res.status(502).json({ success: false, message: "Could not read the categories from Zoho Commerce" });
  }
});

// POST /orders/:id/zoho-item — create the line's item in Zoho and link it.
// multipart/form-data: name, sku?, quality, cost, categoryId, rate, prices (JSON),
// classification, subClassification, deviceBrand, deviceSeries,
// compatibleModels (JSON), order (JSON photo order: [{ id }] a photo already
// on the line, [{ new: n }] the n-th file sent now) + "images".
router.post("/orders/:id/zoho-item", PRODUCT_CREATE, zohoItem.acceptPhotos, async (req, res, next) => {
  const _id = oid(req.params.id);
  let db = null;
  let claimed = false;
  try {
    if (!_id) return bad(res, "invalid id");
    const b = req.body || {};
    db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.category !== NEW_PRODUCT) return bad(res, "Only a New Product line is created in Zoho from here");
    if (order.itemId) return bad(res, `This line is already linked to SKU ${order.sku || order.itemId}`);
    if (order.status === "cancelled") return bad(res, "This line is cancelled");

    const name = str(b.name).replace(/[\r\n]+/g, " ");
    if (name.length < 5) return bad(res, "Item name is too short");
    const { quality, error: qualityError } = zohoItem.cleanQuality(b.quality);
    if (qualityError) return bad(res, qualityError);
    const rate = hasVal(b.rate) ? Number(b.rate) : zohoItem.PLACEHOLDER_RATE;
    if (!Number.isFinite(rate) || rate < 0) return bad(res, "Selling price must be 0 or more");
    const { rates: listRates, error: priceError } = zohoItem.parsePriceLists(b.prices);
    if (priceError) return bad(res, priceError);
    // the cost price (→ Zoho purchase rate) and the store category, both
    // required as on New Products (user ask 2026-10-16)
    const { cost, error: costError } = zohoItem.readCost(b.cost);
    if (costError) return bad(res, costError);
    if (cost === null) return bad(res, "Enter the cost price");
    const categoryId = str(b.categoryId);
    if (!categoryId) return bad(res, "Pick the store category");
    if (!/^\d{1,30}$/.test(categoryId)) return bad(res, "Bad category");
    const { category, error: categoryError, status: categoryStatus } = await findCategory(categoryId);
    if (categoryError) return res.status(categoryStatus).json({ success: false, message: categoryError });
    const classification = str(b.classification);
    if (!classification) return bad(res, "Pick a classification");
    const subClassification = str(b.subClassification);
    const deviceBrand = str(b.deviceBrand);
    const deviceSeries = [...new Set(listOf(jsonOr(b.deviceSeries, [])))].join("; ");
    const compatibleModels = [...new Set(listOf(jsonOr(b.compatibleModels, [])))];
    let sku = str(b.sku);
    if (sku && !/^\d{4,6}$/.test(sku)) return bad(res, "SKU must be a number");
    const saved = order.images || [];
    let photoOrder = jsonOr(b.order, null);
    if (!Array.isArray(photoOrder)) photoOrder = [...saved.map((im) => ({ id: im.id })), ...(req.files || []).map((x, i) => ({ new: i }))];

    // the SKU first — a refusal leaves the line untouched
    await refreshToken();
    if (sku) {
      if (await zohoItem.skuTaken(sku)) return bad(res, `SKU ${sku} is already used in Zoho`);
    } else {
      sku = await zohoItem.nextFreeSku(db);
    }
    // one at a time per line — a double click must not make two items
    const claim = await db.collection(ORDERS).updateOne(
      { _id, itemId: { $in: [null, ""] }, zohoCreating: { $exists: false } },
      { $set: { zohoCreating: new Date() } },
    );
    if (!claim.modifiedCount) return bad(res, "This line's item is being created already");
    claimed = true;
    const z = await zohoItem.createZohoItem({
      name, sku, rate, quality, classification, subClassification, deviceBrand, deviceSeries,
      compatibleModel: compatibleModels.join("; "),
      purchaseRate: cost,
      categoryId: category.id,
    });
    if (z.error) return res.status(502).json({ success: false, message: `Zoho: ${z.error}` });
    const itemId = String(z.item.item_id);
    // the category: set on the new item when the create call didn't keep it
    const filed = { id: category.id, name: category.name };
    if (String(z.item.category_id || "") !== category.id) {
      const c = await zohoItem.setItemCategory(itemId, category.id);
      if (c.error) filed.error = c.error;
    }
    const finalSku = String(z.item.sku || sku);
    const finalName = z.item.name || name;

    // the photos, in the dialog's order: the line's own (read back from S3) and the new files
    const files = [];
    let unreadable = 0;
    for (const o of photoOrder) {
      if (o && o.id) {
        const im = saved.find((x) => x.id === o.id);
        if (!im) continue;
        const r = await zohoItem.readImagesFromUrls([im]);
        files.push(...r.files);
        unreadable += r.errors.length;
      } else if (o && Number.isInteger(o.new) && req.files && req.files[o.new]) {
        files.push(req.files[o.new]);
      }
    }
    const photos = files.length ? await zohoItem.uploadItemPhotos(itemId, files) : null;
    if (unreadable) {
      const note = `${unreadable} saved photo(s) could not be read`;
      if (photos) photos.error = photos.error ? `${photos.error}; ${note}` : note;
    }
    const prices = Object.keys(listRates).length ? await zohoItem.setPriceLists(itemId, listRates) : null;

    const now = new Date();
    const by = actor(req);
    await db.collection(ORDERS).updateOne(
      { _id },
      {
        $set: {
          itemId, sku: finalSku, imageId: (photos && photos.imageId) || order.imageId || null, updatedAt: now,
          zohoItem: { at: now, by, name: finalName, cost, categoryId: filed.error ? null : filed.id, categoryName: filed.error ? null : filed.name },
        },
        $unset: { zohoCreating: "" },
        $push: { history: hist("created in Zoho", by, { sku: finalSku, name: finalName }) },
      },
    );
    claimed = false;
    return res.json({ success: true, item: { itemId, sku: finalSku, name: finalName }, photos, prices, category: filed });
  } catch (error) {
    next(error);
  } finally {
    if (claimed && db) await db.collection(ORDERS).updateOne({ _id }, { $unset: { zohoCreating: "" } }).catch(() => {});
  }
});

// Create lines — each one its own order (product, quantity, note). A line
// files under its item's register classification unless the client asks
// for a channel (海运 / Special Order). The parts supplier may add lines but
// not Special Orders (those are ordered for someone at iMobile).
router.post("/orders", ADD, async (req, res, next) => {
  try {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    if (!lines.length) return bad(res, "No lines provided");
    if (lines.length > 100) return bad(res, "Too many lines (max 100)");
    if (!hasPermission((req.user && req.user.permissions) || [], "spp:order:create") && lines.some((l) => str(l && l.category) === SPECIAL_ORDER)) {
      return res.status(403).json({ success: false, message: "Special Orders are raised by iMobile" });
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      const qty = num(l.orderQty);
      if (qty == null || qty <= 0) return bad(res, `Line ${i + 1}: a positive quantity is required`);
      if (!str(l.sku) && !str(l.productName)) return bad(res, `Line ${i + 1}: a product is required`);
    }
    const db = await connectToDatabase();
    const now = new Date();
    const by = actor(req);
    const docs = [];
    const skipped = [];
    for (const l of lines) {
      let itemId = str(l.itemId) || null;
      let productName = str(l.productName);
      // Lines raised from InFlow (Order Dispatch / Owing Stocks, 2026-10-14)
      // come with the iMobile SKU only: the register names the item. They
      // also say whose order they serve (forCustomer, e.g. OSCAR) and keep
      // the dispatch line as the customer wrote it, for the labels.
      if (!itemId && str(l.sku)) {
        const it = await db.collection(ITEMS).findOne({ sku: new RegExp(`^${escapeRegex(str(l.sku))}$`, "i") }, { projection: { _id: 0, itemId: 1, name: 1 } });
        if (it) { itemId = it.itemId; if (!productName) productName = it.name || ""; }
      }
      const forCustomer = str(l.forCustomer).toUpperCase().slice(0, 40);
      const dr = l.dispatchRef && typeof l.dispatchRef === "object" ? l.dispatchRef : null;
      const dispatchRef = dr ? {
        recordId: str(dr.recordId).slice(0, 40), invoiceNumber: str(dr.invoiceNumber).slice(0, 80), customerName: str(dr.customerName).slice(0, 120),
        faultyCodePrefix: str(dr.faultyCodePrefix).slice(0, 40), customerSku: str(dr.customerSku).slice(0, 80), customerDescription: str(dr.customerDescription).slice(0, 200),
      } : null;
      // the same dispatch line raised twice: the open line stands
      if (dispatchRef && dispatchRef.recordId && dispatchRef.customerSku) {
        const open = await db.collection(ORDERS).findOne(
          { "dispatchRef.recordId": dispatchRef.recordId, "dispatchRef.customerSku": dispatchRef.customerSku, status: { $nin: ["cancelled", "received"] } },
          { projection: { orderNo: 1 } },
        );
        if (open) { skipped.push({ sku: str(l.sku), customerSku: dispatchRef.customerSku, orderNo: open.orderNo }); continue; }
      }
      const { seq, no } = await nextNo(db, "order", "SP", 10001, ORDERS);
      const orderQty = Math.round(num(l.orderQty));
      const asked = str(l.category);
      const reg = itemId ? await registerFacts(db, itemId) : null;
      const category = isChannel(asked) ? asked : reg ? reg.category : CLASSIFICATIONS.includes(asked) ? asked : "Other";
      docs.push({
        orderNo: no,
        seq,
        itemId,
        sku: str(l.sku),
        productName,
        ...(forCustomer ? { forCustomer } : {}),
        ...(dispatchRef ? { dispatchRef } : {}),
        imageId: str(l.imageId) || (reg && reg.imageId) || null,
        category,
        orderQty,
        note: str(l.note),
        ...(category === SPECIAL_ORDER ? { requestedFor: forOf(l.requestedFor), urgent: !!l.urgent, needsQuote: l.needsQuote === undefined ? true : !!l.needsQuote } : {}),
        ...(category === WARRANTY ? { warranty: true } : {}),
        status: "pending",
        quotedPrice: null,
        supplier: "",
        unitPrice: category === WARRANTY ? 0 : null,
        lineTotal: category === WARRANTY ? 0 : null,
        orderedAt: null,
        orderedBy: null,
        shippedQty: null,
        shippedAt: null,
        batchId: null,
        batchNo: "",
        tracking: "",
        receivedQty: null,
        receivedAt: null,
        receivedBy: null,
        source: "app",
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        history: [hist("created", by, { orderQty })],
      });
    }
    await db.collection(ORDERS).insertMany(docs);
    return res.json({ success: true, created: docs.length, orderNos: docs.map((d) => d.orderNo), ids: docs.map((d) => String(d._id)), skipped });
  } catch (error) {
    next(error);
  }
});

// Edit the note any time; quantity and category only while pending.
router.put("/orders/:id", CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const b = req.body || {};
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    const by = actor(req);
    const set = { updatedAt: new Date() };
    const changes = {};
    if (b.note !== undefined && str(b.note) !== rec.note) { set.note = str(b.note); changes.note = set.note; }
    if (hasVal(b.orderQty) && rec.status === "pending") {
      const qty = num(b.orderQty);
      if (qty == null || qty <= 0) return bad(res, "Quantity must be a positive number");
      if (Math.round(qty) !== rec.orderQty) {
        set.orderQty = Math.round(qty);
        set.lineTotal = rec.unitPrice != null ? round2(set.orderQty * rec.unitPrice) : rec.lineTotal;
        changes.orderQty = { from: rec.orderQty, to: set.orderQty };
      }
    }
    if (rec.category === SPECIAL_ORDER || str(b.category) === SPECIAL_ORDER) {
      if (b.requestedFor !== undefined && forOf(b.requestedFor) !== (rec.requestedFor || "")) {
        set.requestedFor = forOf(b.requestedFor);
        changes.requestedFor = { from: rec.requestedFor || "", to: set.requestedFor };
      }
      if (b.urgent !== undefined && !!b.urgent !== !!rec.urgent) {
        set.urgent = !!b.urgent;
        changes.urgent = set.urgent;
      }
      // the name can be corrected after creation (user ask 2026-10-14) while the line is still open
      if (b.productName !== undefined && !["received", "cancelled"].includes(rec.status)) {
        const name = str(b.productName).slice(0, 200);
        if (!name) return bad(res, "The product name cannot be empty");
        if (name !== rec.productName) {
          set.productName = name;
          changes.productName = { from: rec.productName, to: name };
        }
      }
      // whether it must be quoted before it is ordered — while it still waits
      if (b.needsQuote !== undefined && ["pending", "shortage"].includes(rec.status) && !rec.confirmed && !!b.needsQuote !== (rec.needsQuote !== false)) {
        set.needsQuote = !!b.needsQuote;
        changes.needsQuote = set.needsQuote;
      }
    }
    if (hasVal(b.category) && rec.status === "pending" && str(b.category) !== rec.category) {
      if (!CATEGORIES.includes(str(b.category))) return bad(res, "Unknown category");
      set.category = str(b.category);
      changes.category = { from: rec.category, to: set.category };
    }
    const update = { $set: set };
    if (Object.keys(changes).length) update.$push = { history: hist("edited", by, changes) };
    await col.updateOne({ _id }, update);
    return res.json({ success: true, changed: Object.keys(changes) });
  } catch (error) {
    next(error);
  }
});

// One status move, guarded by where the line is now.
async function transition(req, res, next, { from, to, action, build }) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    if (!from.includes(rec.status)) {
      return bad(res, `${rec.orderNo} is ${rec.status}; this action needs ${from.join(" / ")}`);
    }
    const by = actor(req);
    const built = build ? build(rec, req.body || {}, by) : {};
    if (built && built.error) return bad(res, built.error);
    const set = { ...((built && built.set) || {}), updatedAt: new Date() };
    // `to` may depend on the record (a confirmed line goes back where it came from)
    const target = typeof to === "function" ? to(rec, req.body || {}) : to;
    if (target) set.status = target;
    await col.updateOne({ _id }, { $set: set, $push: { history: hist(action, by, (built && built.detail) || null) } });
    return res.json({ success: true, status: target || rec.status, ...((built && built.reply) || {}) });
  } catch (error) {
    next(error);
  }
}

// A quote — the price the supplier can get it for. Does not move the line,
// unless asked to park it in To Confirm with the quote (a price iMobile has
// to agree to first). A New Product awaiting its quote always parks there.
const parksOnQuote = (rec, b) => (b.toConfirm || awaitsQuote(rec)) && rec.status !== "toConfirm";
router.post("/orders/:id/quote", SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "shortage", "ordered", "toConfirm"],
    to: (rec, b) => (parksOnQuote(rec, b) ? "toConfirm" : null),
    action: "quoted",
    build: (rec, b) => {
      const price = num(b.unitPrice);
      if (price == null || price < 0) return { error: "Unit price must be 0 or more" };
      const set = { quotedPrice: round2(price) };
      const detail = { quotedPrice: round2(price) };
      if (parksOnQuote(rec, b)) {
        const note = str(b.note) || (awaitsQuote(rec) ? `${rec.category} quoted ¥${round2(price).toFixed(2)} — confirm to order` : "");
        set.confirmFrom = rec.status;
        set.confirmNote = note;
        detail.toConfirm = true;
        if (note) detail.note = note;
      }
      return { set, detail, reply: { quotedPrice: round2(price) } };
    },
  }),
);

// The unit price of a line already placed with the supplier, changed from
// the Purchase Order page (user ask 2026-09-30). Ordered lines only: a
// pending line gets a quote, and a shipped one keeps the price it shipped
// with (its Zoho PO carries it). The order batch's copy follows.
router.post("/orders/:id/price", SUPPLY, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const price = num(req.body && req.body.unitPrice);
    if (price == null || price < 0) return bad(res, "Unit price must be 0 or more");
    const unitPrice = round2(price);
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id }, { projection: { status: 1, orderQty: 1, unitPrice: 1, orderNo: 1, orderBatchId: 1 } });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    if (rec.status !== "ordered") return bad(res, `${rec.orderNo} is ${rec.status}; only an ordered line's price is changed here`);
    const lineTotal = round2(rec.orderQty * unitPrice);
    if (rec.unitPrice !== unitPrice) {
      const now = new Date();
      const r = await col.updateOne(
        { _id, status: "ordered" },
        {
          $set: { unitPrice, lineTotal, updatedAt: now },
          $push: { history: hist("priced", actor(req), { from: rec.unitPrice == null ? null : rec.unitPrice, unitPrice }) },
        },
      );
      if (!r.modifiedCount) return bad(res, "The line has just changed — refresh and try again");
      if (rec.orderBatchId) {
        const batch = await db.collection(ORDER_BATCHES).findOne({ _id: rec.orderBatchId }, { projection: { lines: 1 } });
        if (batch && Array.isArray(batch.lines)) {
          const lines = batch.lines.map((l) => (String(l.orderId) === String(_id) ? { ...l, unitPrice } : l));
          await db.collection(ORDER_BATCHES).updateOne(
            { _id: batch._id },
            { $set: { lines, pricedCount: lines.filter((l) => l.unitPrice != null).length, updatedAt: now } },
          );
        }
      }
    }
    return res.json({ success: true, unitPrice, lineTotal });
  } catch (error) {
    next(error);
  }
});

// 待确认: parked for a decision (a special order, a doubtful price…) before
// it is placed or shipped. The note says what needs confirming. Either side
// can park a line; either side can confirm it.
router.post("/orders/:id/to-confirm", CREATE_OR_SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "ordered", "shortage"],
    to: "toConfirm",
    action: "toConfirm",
    build: (rec, b) => {
      if (awaitsQuote(rec) && rec.quotedPrice == null) return { error: `Quote this ${rec.category} line first — the quote moves it to To Confirm` };
      const note = str(b.note);
      if (!note) return { error: "Say what needs confirming" };
      // parked again: an earlier Confirmed mark no longer applies
      return { set: { confirmFrom: rec.status, confirmNote: note, confirmed: null }, detail: { from: rec.status, note } };
    },
  }),
);

// Confirmed: back to Pending (the user's rule — it is placed afresh), and the
// line carries a "Confirmed" mark from then on: what was asked, what was
// answered, when and by whom.
router.post("/orders/:id/confirm", CREATE_OR_SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["toConfirm"],
    to: "pending",
    action: "confirmed",
    build: (rec, b, by) => {
      if (QUOTE_FIRST.includes(rec.category) && rec.needsQuote !== false && rec.quotedPrice == null) return { error: `Quote this ${rec.category} line before confirming it` };
      const note = str(b.note);
      return {
        set: {
          confirmFrom: null,
          confirmNote: "",
          orderedAt: null,
          orderedBy: null,
          confirmed: { at: new Date(), by, question: rec.confirmNote || "", answer: note },
        },
        detail: { to: "pending", ...(rec.confirmNote ? { question: rec.confirmNote } : {}), ...(note ? { note } : {}) },
      };
    },
  }),
);

// Placed with a supplier: supplier (required), unit price (optional).
router.post("/orders/:id/place", SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "shortage"],
    to: "ordered",
    action: "ordered",
    build: (rec, b, by) => {
      if (awaitsQuote(rec)) return { error: `A ${rec.category} line is quoted and confirmed before it is ordered` };
      const supplier = str(b.supplier);
      if (!supplier) return { error: "Supplier is required" };
      const set = { supplier, orderedAt: new Date(), orderedBy: by, shortageNote: "" };
      const detail = { supplier };
      if (hasVal(b.unitPrice)) {
        const price = num(b.unitPrice);
        if (price == null || price < 0) return { error: "Unit price must be 0 or more" };
        set.unitPrice = round2(price);
        set.lineTotal = round2(rec.orderQty * price);
        detail.unitPrice = set.unitPrice;
      }
      return { set, detail };
    },
  }),
);

// ── Order batches (下单批次) ─────────────────────────────────────────
// Pending / shortage lines placed with one supplier in one go. A new batch
// is a DRAFT (user ask 2026-09-29): no number yet and the lines are not
// touched — they stay pending — so it can be changed (supplier, note, which
// lines) or discarded. Confirming places the lines with the supplier
// (status ordered) and issues the OB number. The confirmed batch keeps the
// list that was sent to the supplier; when the quote comes back the prices
// are keyed in here and written onto the lines.
//
//   POST   /order-batches              save a new draft
//   PUT    /order-batches/:id          edit a draft
//   POST   /order-batches/:id/confirm  confirm (optionally with the form's
//                                      latest supplier / note / lines)
//   DELETE /order-batches/:id          discard a draft
//   PUT    /order-batches/:id/prices   the supplier's prices (confirmed only)
//
// Batches saved before drafts existed have no status: they count as confirmed.
// A confirmed batch turned back into a draft (by hand, e.g. OB-10011 on
// 2026-09-29) keeps its batchNo / seq, and confirming reuses them.
const isDraft = (batch) => batch && batch.status === "draft";

router.get("/order-batches", VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const match = {};
    if (q.supplier) match.supplier = str(q.supplier);
    if (q.status === "draft") match.status = "draft";
    else if (q.status === "confirmed") match.status = { $ne: "draft" };
    const search = str(q.search);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ batchNo: rx }, { supplier: rx }, { note: rx }, { "lines.sku": rx }, { "lines.productName": rx }];
    }
    const db = await connectToDatabase();
    const col = db.collection(ORDER_BATCHES);
    // drafts (work in progress) on top, newest first — a new draft has no
    // number yet — then confirmed batches by number, newest first
    const [rows, total] = await Promise.all([
      col.aggregate([
        { $match: match },
        { $addFields: {
          _draft: { $cond: [{ $eq: ["$status", "draft"] }, 1, 0] },
          _key: { $cond: [{ $eq: ["$status", "draft"] }, "$createdAt", "$seq"] },
        } },
        { $sort: { _draft: -1, _key: -1, createdAt: -1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        { $project: { _draft: 0, _key: 0 } },
      ]).toArray(),
      col.countDocuments(match),
    ]);
    return res.json({ success: true, page, pageSize, total, rows });
  } catch (error) {
    next(error);
  }
});

router.get("/order-batches/:id", VIEW, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const batch = await db.collection(ORDER_BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Order batch not found" });
    // the lines' current state rides along (status, price, shipment)
    const orders = await db.collection(ORDERS).find({ _id: { $in: batch.lines.map((l) => l.orderId) } }, { projection: { history: 0 } }).toArray();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    batch.lines = batch.lines.map((l) => {
      const o = byId.get(String(l.orderId));
      return { ...l, status: o ? o.status : "missing", currentPrice: o ? o.unitPrice : null, batchNo: o ? o.batchNo : "", shippedQty: o ? o.shippedQty : null };
    });
    return res.json({ success: true, batch });
  } catch (error) {
    next(error);
  }
});

// A line as the batch keeps it (the list sent to the supplier).
const orderBatchLine = (r) => ({
  orderId: r._id,
  orderNo: r.orderNo,
  itemId: r.itemId || null,
  sku: r.sku || "",
  productName: r.productName || "",
  category: r.category || "",
  orderQty: r.orderQty,
  note: r.note || "",
  unitPrice: null,
});
const placeable = (r) => r && (r.status === "pending" || r.status === "shortage") && !awaitsQuote(r);
const qtyOf = (lines) => lines.reduce((t, l) => t + (l.orderQty || 0), 0);

// The draft's lines from the picked ids: still pending / shortage and not
// already in another draft. Returns { lines, skipped } or { error }.
async function draftLines(db, rawIds, selfId) {
  const ids = (Array.isArray(rawIds) ? rawIds : []).map(oid).filter(Boolean);
  if (!ids.length) return { error: "No lines selected" };
  if (ids.length > 300) return { error: "Too many lines (max 300)" };
  const recs = await db.collection(ORDERS).find({ _id: { $in: ids } }, { projection: { history: 0 } }).toArray();
  const ok = recs.filter(placeable);
  if (!ok.length) return { error: "None of the selected lines is still pending" };
  const others = await db.collection(ORDER_BATCHES).find(
    { status: "draft", ...(selfId ? { _id: { $ne: selfId } } : {}), "lines.orderId": { $in: ok.map((r) => r._id) } },
    { projection: { "lines.orderId": 1, createdBy: 1 } },
  ).toArray();
  const taken = new Set(others.flatMap((d) => d.lines.map((l) => String(l.orderId))));
  const clash = ok.filter((r) => taken.has(String(r._id)));
  if (clash.length) {
    return { error: `Already in another draft: ${clash.slice(0, 5).map((r) => r.orderNo).join(", ")}${clash.length > 5 ? " …" : ""}` };
  }
  // in the order they were picked
  const byId = new Map(ok.map((r) => [String(r._id), r]));
  const lines = ids.map((id) => byId.get(String(id))).filter(Boolean).map(orderBatchLine);
  const skipped = recs.filter((r) => !placeable(r)).map((r) => ({ orderNo: r.orderNo, sku: r.sku, status: r.status }));
  return { lines, skipped };
}

// Save a new draft: the picked lines and (optionally) the supplier.
router.post("/order-batches", SUPPLY, async (req, res, next) => {
  try {
    const b = req.body || {};
    const db = await connectToDatabase();
    const d = await draftLines(db, b.orderIds, null);
    if (d.error) return bad(res, d.error);
    const now = new Date();
    const batch = {
      _id: new ObjectId(),
      batchNo: "",
      seq: null,
      status: "draft",
      supplier: str(b.supplier),
      note: str(b.note),
      lines: d.lines,
      lineCount: d.lines.length,
      totalQty: qtyOf(d.lines),
      pricedCount: 0,
      createdAt: now,
      createdBy: actor(req),
      updatedAt: now,
    };
    await db.collection(ORDER_BATCHES).insertOne(batch);
    return res.json({ success: true, batch, skipped: d.skipped });
  } catch (error) {
    next(error);
  }
});

// Supplier / note / lines of a draft, from the edit form.
async function applyDraftEdit(db, req, draft, b) {
  const set = { updatedAt: new Date(), updatedBy: actor(req) };
  let skipped = [];
  if (b.supplier !== undefined) set.supplier = str(b.supplier);
  if (b.note !== undefined) set.note = str(b.note);
  if (b.orderIds !== undefined) {
    const d = await draftLines(db, b.orderIds, draft._id);
    if (d.error) return { error: d.error };
    set.lines = d.lines;
    set.lineCount = d.lines.length;
    set.totalQty = qtyOf(d.lines);
    skipped = d.skipped;
  }
  await db.collection(ORDER_BATCHES).updateOne({ _id: draft._id, status: "draft" }, { $set: set });
  return { batch: { ...draft, ...set }, skipped };
}

async function loadDraft(res, id) {
  const _id = oid(id);
  if (!_id) { bad(res, "invalid id"); return null; }
  const db = await connectToDatabase();
  const batch = await db.collection(ORDER_BATCHES).findOne({ _id });
  if (!batch) { res.status(404).json({ success: false, message: "Order batch not found" }); return null; }
  if (!isDraft(batch)) { bad(res, "This order batch is already confirmed"); return null; }
  return { db, batch };
}

router.put("/order-batches/:id", SUPPLY, async (req, res, next) => {
  try {
    const ctx = await loadDraft(res, req.params.id);
    if (!ctx) return;
    const out = await applyDraftEdit(ctx.db, req, ctx.batch, req.body || {});
    if (out.error) return bad(res, out.error);
    return res.json({ success: true, batch: out.batch, skipped: out.skipped });
  } catch (error) {
    next(error);
  }
});

// Confirm: the lines still pending / shortage are placed with the supplier
// (status ordered) and the batch gets its OB number; lines that moved on
// meanwhile (cancelled, placed on their own…) are left out and reported.
router.post("/order-batches/:id/confirm", SUPPLY, async (req, res, next) => {
  try {
    const ctx = await loadDraft(res, req.params.id);
    if (!ctx) return;
    const { db } = ctx;
    let draft = ctx.batch;
    const b = req.body || {};
    if (b.supplier !== undefined || b.note !== undefined || b.orderIds !== undefined) {
      const out = await applyDraftEdit(db, req, draft, b);
      if (out.error) return bad(res, out.error);
      draft = out.batch;
    }
    if (!draft.supplier) return bad(res, "Supplier is required");

    // claim the draft so a second click can't confirm it twice
    const claim = await db.collection(ORDER_BATCHES).updateOne({ _id: draft._id, status: "draft" }, { $set: { status: "confirming" } });
    if (!claim.modifiedCount) return bad(res, "This order batch is already confirmed");
    try {
      const col = db.collection(ORDERS);
      const recs = await col.find({ _id: { $in: draft.lines.map((l) => l.orderId) } }, { projection: { history: 0 } }).toArray();
      const byId = new Map(recs.map((r) => [String(r._id), r]));
      const ready = draft.lines.map((l) => byId.get(String(l.orderId))).filter(placeable);
      if (!ready.length) {
        await db.collection(ORDER_BATCHES).updateOne({ _id: draft._id }, { $set: { status: "draft" } });
        return bad(res, "None of the lines is still pending");
      }
      const by = actor(req);
      const now = new Date();
      // A batch turned back into a draft keeps its number (the supplier may
      // know it by it); a new draft gets the next one.
      const { seq, no: batchNo } = draft.seq && draft.batchNo
        ? { seq: draft.seq, no: draft.batchNo }
        : await nextNo(db, "orderBatch", "OB", 10001, ORDER_BATCHES);
      const placed = [];
      for (const rec of ready) {
        const r = await col.updateOne(
          { _id: rec._id, status: { $in: ["pending", "shortage"] } },
          {
            $set: { supplier: draft.supplier, orderedAt: now, orderedBy: by, shortageNote: "", status: "ordered", orderBatchId: draft._id, orderBatchNo: batchNo, updatedAt: now },
            $push: { history: hist("ordered", by, { supplier: draft.supplier, orderBatch: batchNo }) },
          },
        );
        if (r.modifiedCount) placed.push(rec);
      }
      const placedIds = new Set(placed.map((r) => String(r._id)));
      const skipped = draft.lines
        .filter((l) => !placedIds.has(String(l.orderId)))
        .map((l) => ({ orderNo: l.orderNo, sku: l.sku, status: (byId.get(String(l.orderId)) || {}).status || "missing" }));
      const lines = placed.map(orderBatchLine);
      const set = {
        status: "confirmed",
        batchNo,
        seq,
        lines,
        lineCount: lines.length,
        totalQty: qtyOf(lines),
        pricedCount: 0,
        confirmedAt: now,
        confirmedBy: by,
        updatedAt: now,
      };
      await db.collection(ORDER_BATCHES).updateOne({ _id: draft._id }, { $set: set });
      return res.json({ success: true, batch: { ...draft, ...set }, skipped });
    } catch (e) {
      // not placed: back to a draft
      await db.collection(ORDER_BATCHES).updateOne({ _id: draft._id, status: "confirming" }, { $set: { status: "draft" } });
      throw e;
    }
  } catch (error) {
    next(error);
  }
});

// A draft can be discarded — nothing has been placed with the supplier.
router.delete("/order-batches/:id", SUPPLY, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const r = await db.collection(ORDER_BATCHES).deleteOne({ _id, status: "draft" });
    if (!r.deletedCount) return bad(res, "Only a draft can be discarded");
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// The supplier's prices, back onto the lines. A line that has already
// shipped keeps the price it shipped with (its Zoho PO carries it). Drafts
// have not been sent to the supplier yet, so they take no prices.
router.put("/order-batches/:id/prices", SUPPLY, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const given = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    const db = await connectToDatabase();
    const batch = await db.collection(ORDER_BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Order batch not found" });
    if (batch.status === "draft" || batch.status === "confirming") return bad(res, "Confirm the order batch before entering prices");
    const wanted = new Map();
    for (const g of given) {
      if (!hasVal(g.unitPrice)) continue;
      const price = num(g.unitPrice);
      if (price == null || price < 0) return bad(res, "Unit price must be 0 or more");
      wanted.set(String(g.orderId), round2(price));
    }
    const col = db.collection(ORDERS);
    const by = actor(req);
    const now = new Date();
    let updated = 0;
    const skipped = [];
    for (const l of batch.lines) {
      const key = String(l.orderId);
      if (!wanted.has(key)) continue;
      const price = wanted.get(key);
      const rec = await col.findOne({ _id: l.orderId }, { projection: { status: 1, orderQty: 1, unitPrice: 1, orderNo: 1, sku: 1 } });
      if (!rec) { skipped.push({ orderNo: l.orderNo, reason: "line missing" }); continue; }
      if (rec.status !== "ordered" && rec.status !== "pending" && rec.status !== "shortage") { skipped.push({ orderNo: rec.orderNo, sku: rec.sku, reason: rec.status }); continue; }
      if (rec.unitPrice !== price) {
        await col.updateOne({ _id: l.orderId }, { $set: { unitPrice: price, lineTotal: round2(rec.orderQty * price), updatedAt: now }, $push: { history: hist("priced", by, { unitPrice: price, orderBatch: batch.batchNo }) } });
      }
      l.unitPrice = price;
      updated++;
    }
    const pricedCount = batch.lines.filter((l) => l.unitPrice != null).length;
    await db.collection(ORDER_BATCHES).updateOne({ _id }, { $set: { lines: batch.lines, pricedCount, pricedAt: now, pricedBy: by, updatedAt: now } });
    return res.json({ success: true, updated, skipped, pricedCount });
  } catch (error) {
    next(error);
  }
});

router.post("/orders/:id/shortage", SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "ordered"],
    to: "shortage",
    action: "shortage",
    build: (rec, b) => ({ set: { shortageNote: str(b.note), orderedAt: null }, detail: str(b.note) ? { note: str(b.note) } : null }),
  }),
);

router.post("/orders/:id/cancel", CREATE_OR_SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "shortage", "toConfirm"],
    to: "cancelled",
    action: "cancelled",
    build: (rec, b) => ({ set: { cancelNote: str(b.note), confirmFrom: null, confirmNote: "" }, detail: str(b.note) ? { note: str(b.note) } : null }),
  }),
);

router.post("/orders/:id/reopen", CREATE_OR_SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["shortage", "cancelled"],
    to: "pending",
    action: "reopened",
    build: () => ({ set: { shortageNote: "", cancelNote: "", orderedAt: null } }),
  }),
);

// ── Mark a line as completed (user ask 2026-10-13) ─────────────────────
// For lines that were sent and received before the system tracked them:
// the line closes as received on its ordered quantity — no batch, no Zoho
// purchase order — and sits under Received, flagged `completed`. Anyone who
// can receive (spp:order:receive) or complete (spp:order:complete — the parts
// supplier since 2026-10-15). A shipped line is received through its batch
// instead.
//   POST /orders/:id/complete  { receivedAt?: "YYYY-MM-DD", note? }
router.post("/orders/:id/complete", requireAny("spp:order:receive", "spp:order:complete"), async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const b = req.body || {};
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const rec = await col.findOne({ _id });
    if (!rec) return res.status(404).json({ success: false, message: "Order not found" });
    if (!["pending", "toConfirm", "ordered", "shortage"].includes(rec.status)) {
      return bad(res, rec.status === "shipped" ? `${rec.orderNo} is on batch ${rec.batchNo || ""} — receive the batch instead` : `${rec.orderNo} is ${rec.status}`);
    }
    const now = new Date();
    const receivedAt = dayDate(b.receivedAt) || now;
    const note = str(b.note).slice(0, 200);
    const by = actor(req);
    const set = {
      status: "received",
      shippedQty: rec.orderQty,
      shippedAt: receivedAt,
      receivedQty: rec.orderQty,
      receivedAt,
      receivedBy: by,
      completed: true,
      completedAt: now,
      completedBy: by,
      updatedAt: now,
      receivedVia: { completed: true, note: note || "Marked as completed from the Purchase Order page (received outside the system, no batch)" },
    };
    if (!rec.orderedAt) { set.orderedAt = receivedAt; set.orderedBy = by; }
    await col.updateOne({ _id, status: rec.status }, { $set: set, $push: { history: hist("completed", by, { from: rec.status, receivedQty: rec.orderQty, ...(note ? { note } : {}) }) } });
    // a draft batch still listing the line could no longer ship it
    const drafts = await db.collection(BATCHES).find({ status: "draft", "lines.orderId": _id }, { projection: { createdBy: 1, tracking: 1 } }).toArray();
    return res.json({
      success: true,
      warnings: drafts.map((d) => `Also listed on a draft batch by ${d.createdBy || "?"}${d.tracking ? " (" + d.tracking + ")" : ""} — take it off there`),
    });
  } catch (error) {
    next(error);
  }
});

// Device Brand / Device Series of register items, for the part labels:
// they print the product name without them (user ask 2026-09-30). Either
// page's viewers print labels (Purchase Order, Order Batches, Batches).
router.post("/device-terms", requireAny("spp:order:view", "spp:batch:view"), async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body && req.body.itemIds) ? req.body.itemIds : []).map(String))]
      .filter((v) => /^[0-9]{6,25}$/.test(v))
      .slice(0, 1000);
    if (!ids.length) return res.json({ success: true, terms: {} });
    const db = await connectToDatabase();
    const rows = await db.collection(ITEMS).find({ itemId: { $in: ids } }, { projection: { _id: 0, itemId: 1, deviceBrand: 1, deviceSeries: 1 } }).toArray();
    const terms = {};
    for (const r of rows) terms[r.itemId] = { brand: r.deviceBrand || "", series: r.deviceSeries || "" };
    return res.json({ success: true, terms });
  } catch (error) {
    next(error);
  }
});

// Open purchases per register item, by stage — the Stock Monitoring On
// order column (pending / ordered / shipped quantities; shortage on the
// side). orderQty / shippedQty / trackings keep the shape of the old
// sheet-based /purchaseOrder/byZohoIds for the cut-over.
router.post("/byItemIds", VIEW, async (req, res, next) => {
  try {
    const ids = [...new Set((Array.isArray(req.body && req.body.itemIds) ? req.body.itemIds : []).map((x) => str(x)).filter(Boolean))];
    if (!ids.length) return res.json({ success: true, data: {} });
    const db = await connectToDatabase();
    const qtyIf = (status, field) => ({ $sum: { $cond: [{ $eq: ["$status", status] }, { $ifNull: [field, 0] }, 0] } });
    // The same, for the 海运 (sea freight) lines only — 空运 (air) is the rest.
    const isSea = { $eq: ["$category", "海运"] };
    const seaIf = (status, field) => ({ $sum: { $cond: [{ $and: [{ $eq: ["$status", status] }, isSea] }, { $ifNull: [field, 0] }, 0] } });
    const rows = await db
      .collection(ORDERS)
      .aggregate([
        { $match: { itemId: { $in: ids }, status: { $in: OPEN } } },
        {
          $group: {
            _id: "$itemId",
            orderQty: { $sum: { $ifNull: ["$orderQty", 0] } },
            shippedQty: { $sum: { $ifNull: ["$shippedQty", 0] } },
            pending: qtyIf("pending", "$orderQty"),
            toConfirm: qtyIf("toConfirm", "$orderQty"),
            ordered: qtyIf("ordered", "$orderQty"),
            shipped: qtyIf("shipped", "$shippedQty"),
            shortage: qtyIf("shortage", "$orderQty"),
            seaPending: seaIf("pending", "$orderQty"),
            seaToConfirm: seaIf("toConfirm", "$orderQty"),
            seaOrdered: seaIf("ordered", "$orderQty"),
            seaShipped: seaIf("shipped", "$shippedQty"),
            seaShortage: seaIf("shortage", "$orderQty"),
            trackings: { $addToSet: "$tracking" },
            count: { $sum: 1 },
            // the pending lines themselves — the dashboard edits one inline
            pendingLines: { $push: { $cond: [{ $eq: ["$status", "pending"] }, { id: { $toString: "$_id" }, orderQty: "$orderQty", sea: isSea }, null] } },
          },
        },
      ])
      .toArray();
    const data = {};
    const STAGES = ["pending", "toConfirm", "ordered", "shipped", "shortage"];
    const cap = (k) => k[0].toUpperCase() + k.slice(1);
    for (const r of rows) {
      const sea = Object.fromEntries(STAGES.map((k) => [k, r["sea" + cap(k)] || 0]));
      const air = Object.fromEntries(STAGES.map((k) => [k, (r[k] || 0) - sea[k]]));
      data[r._id] = {
        orderQty: r.orderQty || 0,
        shippedQty: r.shippedQty || 0,
        pending: r.pending || 0,
        toConfirm: r.toConfirm || 0,
        ordered: r.ordered || 0,
        shipped: r.shipped || 0,
        shortage: r.shortage || 0,
        count: r.count || 0,
        trackings: (r.trackings || []).map((t) => str(t)).filter(Boolean),
        pendingLines: (r.pendingLines || []).filter(Boolean),
        // by channel: 海运 (sea) and 空运 (air, every other category)
        sea,
        air,
      };
    }
    return res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// ── Batches ─────────────────────────────────────────────────────────
router.get("/batches", BATCH_VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const match = {};
    if (q.status && ["draft", "shipped", "received", "cancelled"].includes(String(q.status))) match.status = String(q.status);
    if (q.freight === "sea") match.freight = "sea";
    else if (q.freight === "air") match.freight = { $ne: "sea" };
    const search = str(q.search);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ batchNo: rx }, { tracking: rx }, { "lines.sku": rx }, { "lines.productName": rx }, { "lines.orderNo": rx }];
    }
    const db = await connectToDatabase();
    const col = db.collection(BATCHES);
    const [rows, total, statusAgg] = await Promise.all([
      // newest first; drafts (no number yet) sit with the day they were saved
      col.find(match).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      col.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    ]);
    const byStatus = {};
    for (const s of statusAgg) byStatus[s._id] = s.n;
    return res.json({ success: true, page, pageSize, total, rows, byStatus });
  } catch (error) {
    next(error);
  }
});

router.get("/batches/:id", BATCH_VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const _id = oid(req.params.id);
    const batch = _id ? await db.collection(BATCHES).findOne({ _id }) : await db.collection(BATCHES).findOne({ batchNo: str(req.params.id).toUpperCase() });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });
    return res.json({ success: true, batch });
  } catch (error) {
    next(error);
  }
});

// The freight for the parcel (CNY), typed on the batch form — optional. It
// goes on the batch's Zoho PO as its own line (utils/sppZoho). Blank = none.
function shippingCostOf(b) {
  if (!hasVal(b.shippingCost)) return { value: null };
  const n = num(b.shippingCost);
  if (n == null || n < 0) return { error: "Shipping cost must be 0 or more" };
  return { value: round2(n) };
}

// A draft batch is the Create Batch form saved for later: lines with or
// without a quantity, tracking, date, note, shipping cost. Nothing ships and no PB number
// is issued until it is shipped — its lines stay ordered / pending and can
// still board another batch (the ship step re-checks them). `freight` is the
// batch's kind: its lines are checked against it here too.
async function draftPayload(db, b, freight) {
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (rawLines.length > 300) return { error: "Too many lines (max 300)" };
  const parsed = [];
  for (const l of rawLines) {
    // Special Orders and warranty claims are air lines
    if (freight === "sea" && l.special === true) return { error: `Special Orders go on a ${FREIGHT_LABEL.air} batch` };
    if (freight === "sea" && l.warranty === true) return { error: `Warranty lines go on a ${FREIGHT_LABEL.air} batch` };
    // A scan that matched no order (user ask 2026-10-13: "leave it as it
    // is for future adjustment"): kept on the draft by SKU with no order
    // behind it, until someone removes it or finds its order. It cannot
    // ship (shipBatch refuses).
    // A Special Order typed straight into the batch (user ask 2026-10-14): no
    // order yet — kept on the draft by its description; it becomes an SP-
    // line (category Special Order) as the batch ships.
    if (l.special === true) {
      const productName = str(l.productName).slice(0, 200);
      if (!productName) return { error: "A Special Order line needs a description" };
      let sqty = null;
      if (hasVal(l.qty)) {
        sqty = num(l.qty);
        if (sqty == null || sqty <= 0) return { error: "Shipped quantity must be a positive number" };
        sqty = Math.round(sqty);
      }
      let sprice = null;
      if (hasVal(l.unitPrice)) {
        sprice = num(l.unitPrice);
        if (sprice == null || sprice < 0) return { error: "Unit price must be 0 or more" };
      }
      parsed.push({ special: true, productName, requestedFor: forOf(l.requestedFor), supplier: str(l.supplier), price: sprice, qty: sqty, key: str(l.key).slice(0, 40) });
      continue;
    }
    if (l.unmatched === true || !l.orderId) {
      const sku = str(l.sku).slice(0, 80);
      if (!sku && !str(l.itemId) && !str(l.productName)) return { error: "A not-in-PO line needs a product or a SKU" };
      let uqty = null;
      if (hasVal(l.qty)) {
        uqty = num(l.qty);
        if (uqty == null || uqty <= 0) return { error: "Shipped quantity must be a positive number" };
        uqty = Math.round(uqty);
      }
      let uprice = null;
      if (hasVal(l.unitPrice)) {
        uprice = num(l.unitPrice);
        if (uprice == null || uprice < 0) return { error: "Unit price must be 0 or more" };
      }
      // since 2026-10-14 the line can carry the product picked for it (register itemId), a supplier and a price
      parsed.push({ unmatched: true, sku, productName: str(l.productName).slice(0, 200), category: str(l.category).slice(0, 40), reason: l.reason === "over" ? "over" : "none", qty: uqty,
        itemId: str(l.itemId) || null, imageId: str(l.imageId) || null, supplier: str(l.supplier), price: l.warranty === true ? 0 : uprice, warranty: l.warranty === true, oscarCode: str(l.oscarCode).slice(0, 80), key: str(l.key).slice(0, 40) });
      continue;
    }
    const _id = oid(l.orderId);
    if (!_id) return { error: `invalid order id: ${l.orderId}` };
    let qty = null;
    if (hasVal(l.qty)) {
      qty = num(l.qty);
      if (qty == null || qty <= 0) return { error: "Shipped quantity must be a positive number" };
      qty = Math.round(qty);
    }
    let price = null;
    if (hasVal(l.unitPrice)) {
      price = num(l.unitPrice);
      if (price == null || price < 0) return { error: "Unit price must be 0 or more" };
    }
    parsed.push({ _id, qty, supplier: str(l.supplier), price });
  }
  const ids = parsed.filter((p) => !p.unmatched).map((p) => p._id);
  const recs = ids.length ? await db.collection(ORDERS).find({ _id: { $in: ids } }, { projection: { history: 0 } }).toArray() : [];
  const byId = new Map(recs.map((r) => [String(r._id), r]));
  const lines = [];
  for (const p of parsed) {
    if (p.special) {
      lines.push({ orderId: null, orderNo: "", itemId: null, sku: "", productName: p.productName, category: SPECIAL_ORDER, status: "special", supplier: p.supplier, requestedFor: p.requestedFor, orderedAt: null, orderQty: null, qty: p.qty, unitPrice: p.price != null ? round2(p.price) : null, special: true, key: p.key });
      continue;
    }
    if (p.unmatched) {
      lines.push({ orderId: null, orderNo: "", itemId: p.itemId, imageId: p.imageId, imageUrl: imageUrlFromId(p.imageId), sku: p.sku, productName: p.productName, category: p.category, status: "unmatched", supplier: p.supplier, orderedAt: null, orderQty: null, qty: p.qty, unitPrice: p.price != null ? round2(p.price) : null, unmatched: true, reason: p.reason, warranty: !!p.warranty, oscarCode: p.oscarCode || "", key: p.key });
      continue;
    }
    const rec = byId.get(String(p._id));
    if (!rec) return { error: `Order not found: ${p._id}` };
    if (lineFreight(rec) !== freight) return { error: freightError(rec, freight) };
    lines.push({
      orderId: p._id,
      orderNo: rec.orderNo,
      itemId: rec.itemId || null,
      sku: rec.sku || "",
      productName: rec.productName || "",
      category: rec.category || "",
      status: rec.status,
      supplier: p.supplier || rec.supplier || "",
      orderedAt: rec.orderedAt || null,
      orderQty: rec.orderQty,
      qty: p.qty,
      unitPrice: p.price != null ? round2(p.price) : rec.unitPrice != null ? rec.unitPrice : rec.quotedPrice != null ? rec.quotedPrice : null,
      // a line raised for OSCAR: the return code answers to it on re-scans
      ...oscarFacts(rec),
    });
  }
  const ship = shippingCostOf(b);
  if (ship.error) return { error: ship.error };
  const vendor = vendorById(b.zohoVendorId);
  return { freight, lines, unmatchedCount: lines.filter((l) => l.unmatched).length, tracking: str(b.tracking), shippedAt: dayDate(b.shippedAt), note: str(b.note), shippingCost: ship.value, zohoVendorId: vendor ? vendor.id : "", zohoVendorName: vendor ? vendor.name : "" };
}

// The kind a batch being made is: the body's (required on a new batch), or
// the draft's own (a draft from before 2026-10-16 has none → air).
function batchFreight(b, draft) {
  if (draft && FREIGHTS.includes(draft.freight)) return draft.freight;
  if (FREIGHTS.includes(str(b && b.freight))) return str(b.freight);
  return draft ? "air" : null;
}

// Straight away, or a saved draft
router.post("/batches", BATCH_CREATE, async (req, res, next) => {
  try {
    const b = req.body || {};
    const freight = batchFreight(b, null);
    if (!freight) return bad(res, `Choose ${FREIGHT_LABEL.sea} or ${FREIGHT_LABEL.air} for the batch`);
    const db = await connectToDatabase();
    if (b.draft === true) {
      const d = await draftPayload(db, b, freight);
      if (d.error) return bad(res, d.error);
      const now = new Date();
      const doc = { batchNo: "", seq: null, status: "draft", ...d, lineCount: d.lines.length, totalQty: d.lines.reduce((t, l) => t + (l.qty || 0), 0), createdAt: now, createdBy: actor(req), updatedAt: now };
      const r = await db.collection(BATCHES).insertOne(doc);
      return res.json({ success: true, batch: { _id: r.insertedId, ...doc } });
    }
    const out = await shipBatch(db, req, b, null);
    if (out.error) return res.status(out.status || 400).json({ success: false, message: out.error });
    return res.json({ success: true, ...out });
  } catch (error) {
    next(error);
  }
});

// Edit a draft (lines, quantities, tracking, date, note).
router.put("/batches/:id/draft", BATCH_CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const draft = await db.collection(BATCHES).findOne({ _id });
    if (!draft) return res.status(404).json({ success: false, message: "Batch not found" });
    if (draft.status !== "draft") return bad(res, "Only a draft can be edited this way");
    const d = await draftPayload(db, req.body || {}, batchFreight(req.body, draft));
    if (d.error) return bad(res, d.error);
    const set = { ...d, lineCount: d.lines.length, totalQty: d.lines.reduce((t, l) => t + (l.qty || 0), 0), updatedAt: new Date() };
    await db.collection(BATCHES).updateOne({ _id }, { $set: set });
    return res.json({ success: true, batch: { ...draft, ...set } });
  } catch (error) {
    next(error);
  }
});

// Ship a draft: the form as it stands now becomes the shipment.
router.post("/batches/:id/ship", BATCH_CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const draft = await db.collection(BATCHES).findOne({ _id });
    if (!draft) return res.status(404).json({ success: false, message: "Batch not found" });
    if (draft.status !== "draft") return bad(res, "This batch has already shipped");
    const out = await shipBatch(db, req, req.body || {}, draft);
    if (out.error) return res.status(out.status || 400).json({ success: false, message: out.error });
    return res.json({ success: true, ...out });
  } catch (error) {
    next(error);
  }
});

// A draft can be discarded (nothing has shipped); a shipped batch cannot be
// deleted from the page for now.
router.delete("/batches/:id", BATCH_CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const r = await db.collection(BATCHES).deleteOne({ _id, status: "draft" });
    if (!r.deletedCount) return bad(res, "Only a draft can be discarded");
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// A shipment: the lines on it go shipped (each once, whatever the quantity),
// carrying the batch number and tracking; a pending line boards with the
// supplier / price picked on the line. `draft` is the draft document being
// shipped (converted in place), or null. Returns { batch, remainders, zoho }
// or { error, status }.
async function shipBatch(db, req, b, draft) {
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (!rawLines.length) return { error: "No lines selected" };
  if (rawLines.length > 300) return { error: "Too many lines (max 300)" };
  const freight = batchFreight(b, draft);
  if (!freight) return { error: `Choose ${FREIGHT_LABEL.sea} or ${FREIGHT_LABEL.air} for the batch` };
  // Lines scanned with no order behind them (user ask 2026-10-14): once a
  // product, a supplier, a price and a quantity are on them, they ship too —
  // each becomes an SP- line of its own as the batch ships. Without a
  // product the batch cannot ship.
  const extras = [];
  for (const l of rawLines) {
    if (!(l.unmatched === true || l.special === true || !l.orderId)) continue;
    // Special Orders and warranty claims are air lines
    if (freight === "sea" && l.special === true) return { error: `Special Orders go on a ${FREIGHT_LABEL.air} batch` };
    if (freight === "sea" && l.warranty === true) return { error: `Warranty lines go on a ${FREIGHT_LABEL.air} batch` };
    if (l.special === true) {
      const productName = str(l.productName).slice(0, 200);
      if (!productName) return { error: "A Special Order line needs a description before it ships" };
      const sq = num(l.qty);
      if (sq == null || sq <= 0) return { error: `${productName}: shipped quantity must be a positive number` };
      const ssupplier = str(l.supplier); // optional on a Special Order (user 2026-10-14)
      const sprice = hasVal(l.unitPrice) ? num(l.unitPrice) : null;
      if (sprice == null || sprice < 0) return { error: `${productName}: unit price is required to ship` };
      extras.push({ special: true, itemId: null, sku: "", productName, requestedFor: forOf(l.requestedFor), qty: Math.round(sq), supplier: ssupplier, price: sprice });
      continue;
    }
    const label = str(l.sku) || str(l.productName) || "A scanned line";
    const itemId = str(l.itemId);
    if (!itemId) return { error: `${label} is not on any order — pick a product for it or remove it before shipping` };
    const xq = num(l.qty);
    if (xq == null || xq <= 0) return { error: `${label}: shipped quantity must be a positive number` };
    const supplier = str(l.supplier);
    if (!supplier) return { error: `${label} needs a supplier before it ships` };
    const warranty = l.warranty === true; // a warranty replacement: no charge (user 2026-10-14)
    const price = warranty ? 0 : hasVal(l.unitPrice) ? num(l.unitPrice) : null;
    if (price == null || price < 0) return { error: `${label}: unit price is required to ship` };
    extras.push({ itemId, sku: str(l.sku).slice(0, 80), productName: str(l.productName).slice(0, 200), qty: Math.round(xq), supplier, price, warranty, oscarCode: str(l.oscarCode).slice(0, 80) });
  }
  const zohoVendor = vendorById(b.zohoVendorId);
  if (!zohoVendor) return { error: "Pick the Zoho vendor for this batch" };
  // the form's shipping cost; a caller that leaves the field out of the body
  // altogether keeps what the draft had
  const ship = b.shippingCost === undefined && draft && draft.shippingCost != null ? { value: draft.shippingCost } : shippingCostOf(b);
  if (ship.error) return { error: ship.error };
  const parsed = [];
  for (const l of rawLines) {
    if (l.unmatched === true || l.special === true || !l.orderId) continue; // handled above
    const _id = oid(l.orderId);
    if (!_id) return { error: `invalid order id: ${l.orderId}` };
    const qty = num(l.qty);
    if (qty == null || qty <= 0) return { error: "Shipped quantity must be a positive number on every line" };
    let price = null;
    if (hasVal(l.unitPrice)) {
      price = num(l.unitPrice);
      if (price == null || price < 0) return { error: "Unit price must be 0 or more" };
    }
    parsed.push({ _id, qty: Math.round(qty), supplier: str(l.supplier), price });
  }
  const col = db.collection(ORDERS);
  const recs = await col.find({ _id: { $in: parsed.map((p) => p._id) } }).toArray();
  const byId = new Map(recs.map((r) => [String(r._id), r]));
  for (const p of parsed) {
    const rec = byId.get(String(p._id));
    if (!rec) return { error: `Order not found: ${p._id}`, status: 404 };
    if (rec.status !== "ordered" && rec.status !== "pending") {
      return { error: `${rec.sku || rec.orderNo} is ${rec.status}; only ordered or pending lines can ship` };
    }
    if (lineFreight(rec) !== freight) return { error: freightError(rec, freight) };
    if (awaitsQuote(rec)) return { error: `${rec.productName || rec.orderNo}: a ${rec.category} line is quoted and confirmed before it ships` };
    if (rec.status === "pending" && !p.supplier && !rec.supplier && rec.category !== SPECIAL_ORDER && rec.category !== WARRANTY) return { error: `${rec.sku || rec.orderNo} needs a supplier before it ships` };
    // The price may be left off when placing, but every shipped line must
    // carry one — from the batch form or already on the line.
    if (p.price == null && rec.unitPrice == null) return { error: `${rec.sku || rec.orderNo}: unit price is required to ship` };
  }

  {
    const now = new Date();
    const by = actor(req);
    const shippedAt = dayDate(b.shippedAt);
    const tracking = str(b.tracking);
    const { seq, no: batchNo } = await nextNo(db, "batch", "PB", 10001, BATCHES);
    const batchId = draft ? draft._id : new ObjectId();
    // the not-in-PO lines become SP- lines of their own, then ship like the rest
    for (const x of extras) {
      const facts = x.special ? { category: SPECIAL_ORDER, imageId: null } : await registerFacts(db, x.itemId);
      if (x.warranty) facts.category = WARRANTY; // on the Warranty list, like one added there
      if (freight === "sea") facts.category = SEA; // came by sea: a 海运 line, like the rest of the batch
      const { seq: xSeq, no: xNo } = await nextNo(db, "order", "SP", 10001, ORDERS);
      const doc = {
        // a typed Special Order: no quote step (needsQuote false), so it ships in this same pass
        ...(x.special ? { requestedFor: x.requestedFor || "", urgent: false, needsQuote: false } : {}),
        ...(x.warranty ? { warranty: true } : {}),
        // scanned as an Oscar return code: marked for OSCAR with the code's facts (labels)
        ...oscarRefOf(x.oscarCode),
        orderNo: xNo, seq: xSeq, itemId: x.itemId, sku: x.sku, productName: x.productName, imageId: facts.imageId, category: facts.category,
        orderQty: x.qty, note: x.warranty ? "Warranty replacement" : "", status: "pending", quotedPrice: null, supplier: x.supplier, unitPrice: round2(x.price), lineTotal: round2(x.qty * x.price),
        orderedAt: null, orderedBy: null, shippedQty: null, shippedAt: null, batchId: null, batchNo: "", tracking: "",
        receivedQty: null, receivedAt: null, receivedBy: null, source: "app", createdFrom: { batch: batchNo },
        createdAt: now, createdBy: by, updatedAt: now,
        history: [hist("created", by, { orderQty: x.qty, batchNo, reason: x.special ? "Special Order typed into the batch" : "scanned into the batch without an order" })],
      };
      const ins = await col.insertOne(doc);
      doc._id = ins.insertedId;
      byId.set(String(ins.insertedId), { ...doc }); // a copy: the ship loop reads prevStatus from it
      parsed.push({ _id: ins.insertedId, qty: x.qty, supplier: x.supplier, price: x.price, warranty: !!x.warranty });
    }
    const lines = [];
    const remainders = [];
    for (const p of parsed) {
      const rec = byId.get(String(p._id));
      const set = { status: "shipped", shippedQty: p.qty, shippedAt, batchId, batchNo, tracking, updatedAt: now };
      if (p.supplier) set.supplier = p.supplier;
      if (p.price != null) { set.unitPrice = round2(p.price); set.lineTotal = round2(rec.orderQty * p.price); }
      if (rec.status === "pending") { set.orderedAt = now; set.orderedBy = by; }
      const detail = { batchNo, shippedQty: p.qty };
      // Short shipment: the rest becomes its own PENDING line (the user's
      // rule), so nothing is lost and the On order figures stay right.
      if (p.qty < rec.orderQty) {
        const remainder = rec.orderQty - p.qty;
        const { seq: rSeq, no: rNo } = await nextNo(db, "order", "SP", 10001, ORDERS);
        const supplier = p.supplier || rec.supplier || "";
        const unitPrice = p.price != null ? round2(p.price) : rec.unitPrice != null ? rec.unitPrice : null;
        await col.insertOne({
          orderNo: rNo,
          seq: rSeq,
          itemId: rec.itemId || null,
          sku: rec.sku || "",
          productName: rec.productName || "",
          imageId: rec.imageId || null,
          category: rec.category || "Other",
          orderQty: remainder,
          note: rec.note || "",
          status: "pending",
          quotedPrice: rec.quotedPrice != null ? rec.quotedPrice : null,
          supplier,
          unitPrice,
          lineTotal: unitPrice != null ? round2(remainder * unitPrice) : null,
          orderedAt: null,
          orderedBy: null,
          shippedQty: null,
          shippedAt: null,
          batchId: null,
          batchNo: "",
          tracking: "",
          receivedQty: null,
          receivedAt: null,
          receivedBy: null,
          source: "app",
          splitFrom: rec.orderNo,
          createdAt: now,
          createdBy: by,
          updatedAt: now,
          history: [hist("created", by, { orderQty: remainder, splitFrom: rec.orderNo, reason: "short shipment" })],
        });
        set.splitTo = rNo;
        detail.short = remainder;
        detail.remainderTo = rNo;
        remainders.push({ from: rec.orderNo, to: rNo, sku: rec.sku, qty: remainder });
      }
      await col.updateOne({ _id: p._id }, { $set: set, $push: { history: hist("shipped", by, detail) } });
      lines.push({
        orderId: p._id,
        orderNo: rec.orderNo,
        itemId: rec.itemId || null,
        sku: rec.sku || "",
        productName: rec.productName || "",
        category: rec.category || "",
        supplier: p.supplier || rec.supplier || "",
        orderQty: rec.orderQty,
        shippedQty: p.qty,
        unitPrice: p.price != null ? round2(p.price) : rec.unitPrice != null ? rec.unitPrice : null,
        receivedQty: null,
        ...(p.warranty || rec.warranty || rec.category === WARRANTY ? { warranty: true } : {}),
        ...oscarFacts(rec),
        // where the line came from — a cancelled batch puts it back there
        prevStatus: rec.status,
      });
    }
    const batch = {
      _id: batchId,
      batchNo,
      seq,
      status: "shipped",
      freight,
      tracking,
      shippedAt,
      note: str(b.note),
      shippingCost: ship.value,
      zohoVendorId: zohoVendor.id,
      zohoVendorName: zohoVendor.name,
      lines,
      lineCount: lines.length,
      totalQty: lines.reduce((t, l) => t + l.shippedQty, 0),
      createdAt: now,
      createdBy: by,
      receivedAt: null,
      receivedBy: null,
      receiveNote: "",
      discrepancy: false,
      ...(draft ? { draftedAt: draft.createdAt, draftedBy: draft.createdBy } : {}),
    };
    if (draft) await db.collection(BATCHES).replaceOne({ _id: batchId }, batch);
    else await db.collection(BATCHES).insertOne(batch);

    // The Zoho Inventory purchase order(s) for the shipment — one per
    // vendor. Non-fatal: the batch stands, the outcome is stored and can
    // be retried from the Batches page (POST /batches/:id/zoho).
    const zoho = await createBatchPurchaseOrders(db, batch, null);
    await db.collection(BATCHES).updateOne({ _id: batchId }, { $set: { zoho } });
    batch.zoho = zoho;
    return { batch, remainders, zoho };
  }
}

// Tracking / ship date / note can be fixed after the fact (a tracking number
// often arrives later). Mirrored onto the lines. The shipping cost too, while
// the batch is shipped but not yet received (user 2026-10-15) — and onto the
// Zoho PO's shipping line.
router.put("/batches/:id", BATCH_MANAGE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const b = req.body || {};
    const db = await connectToDatabase();
    const batch = await db.collection(BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });
    if (batch.status === "cancelled") return bad(res, "This batch was cancelled");
    const set = {};
    const lineSet = { updatedAt: new Date() };
    const prevTracking = str(batch.tracking); // before the write — the PO sync keys on a change
    const prevShipping = batch.shippingCost == null ? null : round2(Number(batch.shippingCost));
    if (b.tracking !== undefined) { set.tracking = str(b.tracking); lineSet.tracking = set.tracking; }
    if (b.shippingCost !== undefined) {
      if (batch.status !== "shipped") return bad(res, "The shipping cost can only be changed while the batch is shipped and not yet received");
      const ship = shippingCostOf(b);
      if (ship.error) return bad(res, ship.error);
      set.shippingCost = ship.value;
    }
    if (hasVal(b.shippedAt)) { set.shippedAt = dayDate(b.shippedAt); lineSet.shippedAt = set.shippedAt; }
    if (b.note !== undefined) set.note = str(b.note);
    if (!Object.keys(set).length) return bad(res, "Nothing to change");
    await db.collection(BATCHES).updateOne({ _id }, { $set: set });
    if (lineSet.tracking !== undefined || lineSet.shippedAt !== undefined) {
      await db.collection(ORDERS).updateMany({ _id: { $in: (batch.lines || []).map((l) => l.orderId) } }, { $set: lineSet });
    }
    // A tracking number entered or changed after the Zoho PO exists goes
    // onto the PO's Reference# (user 2026-10-15). Non-fatal: the batch is
    // saved either way, the outcome rides back for the page to say.
    let zohoReference = null;
    if (set.tracking !== undefined && set.tracking !== prevTracking && batch.zoho && (batch.zoho.pos || []).some((p) => p.purchaseorderId)) {
      zohoReference = await syncBatchReference({ ...batch, tracking: set.tracking });
      await db.collection(BATCHES).updateOne({ _id }, { $set: { "zoho.reference": { ...zohoReference, at: new Date() } } });
    }
    // A changed shipping cost goes onto the PO's shipping line (CNY vendors);
    // the batch's PO summary follows (total, shippingCost). Non-fatal too.
    let zohoShipping = null;
    if (set.shippingCost !== undefined && set.shippingCost !== prevShipping && batch.zoho && (batch.zoho.pos || []).some((p) => p.purchaseorderId)) {
      zohoShipping = await syncBatchShipping({ ...batch, shippingCost: set.shippingCost });
      const pos = (batch.zoho.pos || []).map((p) => {
        const u = zohoShipping.updated.find((x) => x.number === p.number);
        if (!u) return p;
        const { shippingCost: _old, ...rest } = p;
        return { ...rest, ...(u.total != null ? { total: u.total } : {}), ...(set.shippingCost > 0 ? { shippingCost: set.shippingCost } : {}) };
      });
      await db.collection(BATCHES).updateOne({ _id }, { $set: { "zoho.pos": pos, "zoho.shipping": { ...zohoShipping, at: new Date() } } });
    }
    return res.json({ success: true, ...set, ...(zohoReference ? { zohoReference } : {}), ...(zohoShipping ? { zohoShipping } : {}) });
  } catch (error) {
    next(error);
  }
});

// Create the Zoho PO(s) a batch is still missing (a retry after a Zoho
// hiccup, or for vendor groups that failed the first time).
router.post("/batches/:id/zoho", BATCH_MANAGE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const batch = await db.collection(BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });
    if (batch.status === "cancelled") return bad(res, "This batch was cancelled");
    const zoho = await createBatchPurchaseOrders(db, batch, batch.zoho || null);
    await db.collection(BATCHES).updateOne({ _id }, { $set: { zoho } });
    return res.json({ success: zoho.status !== "error", zoho });
  } catch (error) {
    next(error);
  }
});

// iMobile has the parcel: every line on the batch is received, with the
// quantity actually found (defaults to what was shipped).
router.post("/batches/:id/receive", RECEIVE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const b = req.body || {};
    const db = await connectToDatabase();
    const batch = await db.collection(BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });
    if (batch.status !== "shipped") return bad(res, `This batch is ${batch.status}`);
    const given = new Map();
    for (const l of Array.isArray(b.lines) ? b.lines : []) {
      if (!hasVal(l.receivedQty)) continue;
      const n = num(l.receivedQty);
      if (n == null || n < 0) return bad(res, "Received quantity must be 0 or more");
      given.set(String(l.orderId), Math.round(n));
    }
    const now = new Date();
    const by = actor(req);
    const receivedAt = dayDate(b.receivedAt);
    const note = str(b.note);
    let discrepancy = false;
    const lines = [];
    for (const l of batch.lines || []) {
      const receivedQty = given.has(String(l.orderId)) ? given.get(String(l.orderId)) : l.shippedQty;
      if (receivedQty !== l.shippedQty) discrepancy = true;
      lines.push({ ...l, receivedQty });
      await db.collection(ORDERS).updateOne(
        { _id: l.orderId, status: "shipped" },
        {
          $set: { status: "received", receivedQty, receivedAt, receivedBy: by, updatedAt: now },
          $push: { history: hist("received", by, { batchNo: batch.batchNo, receivedQty, ...(receivedQty !== l.shippedQty ? { shippedQty: l.shippedQty } : {}) }) },
        },
      );
    }
    await db.collection(BATCHES).updateOne({ _id }, { $set: { status: "received", receivedAt, receivedBy: by, receiveNote: note, discrepancy, lines } });
    return res.json({ success: true, batchNo: batch.batchNo, discrepancy });
  } catch (error) {
    next(error);
  }
});

// A batch made by mistake: its lines go back to where they were.
router.post("/batches/:id/cancel", BATCH_MANAGE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const batch = await db.collection(BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Batch not found" });
    if (batch.status !== "shipped") return bad(res, `A ${batch.status} batch cannot be cancelled`);
    const now = new Date();
    const by = actor(req);
    for (const l of batch.lines || []) {
      await db.collection(ORDERS).updateOne(
        { _id: l.orderId, batchId: _id },
        {
          $set: { status: l.prevStatus || "ordered", shippedQty: null, shippedAt: null, batchId: null, batchNo: "", tracking: "", updatedAt: now },
          $push: { history: hist("unshipped", by, { batchNo: batch.batchNo }) },
        },
      );
    }
    // Its Zoho PO(s) are cancelled too; anything Zoho refuses is reported, not fatal.
    const zohoFailed = await cancelBatchPurchaseOrders(batch);
    await db.collection(BATCHES).updateOne(
      { _id },
      { $set: { status: "cancelled", cancelledAt: now, cancelledBy: by, ...(batch.zoho ? { "zoho.cancelled": zohoFailed.length === 0, "zoho.cancelErrors": zohoFailed } : {}) } },
    );
    return res.json({ success: true, batchNo: batch.batchNo, zohoFailed });
  } catch (error) {
    next(error);
  }
});

// New Products — the models we want parts for, and creating the missing
// Zoho items (its own file; user ask 2026-10-06).
router.use("/new-products", require("./newProducts"));

module.exports = router;
