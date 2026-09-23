// Spare Parts Purchase — the in-app purchase process for spare parts
// (2026-09-22). It replaces the Tencent-sheet flow of
// routes/purchaseOrderRoutes: nobody edits a shared spreadsheet any more;
// every step is an action here, with an audit trail on the line. The
// orders still open in the sheet get imported once, when this goes live.
//
// Data
//   imb_spp_orders     one record per item line, SP-10001+
//   imb_spp_batches    one shipment to iMobile, PB-10001+, with copies of its lines
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
//   spp:order:create    create / edit / cancel          admin, iMobile admin
//   spp:order:supply    quote / place / shortage        admin, iMobile admin, parts supplier
//   spp:order:receive   receive a batch                 admin, iMobile admin
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
const { createBatchPurchaseOrders, cancelBatchPurchaseOrders, ZOHO_VENDORS, vendorById } = require("../../utils/sppZoho");

const ORDERS = "imb_spp_orders";
const BATCHES = "imb_spp_batches";
// 下单批次: a set of pending lines placed with one supplier at once (OB-10001+);
// the supplier's quoted prices come back onto its lines from here.
const ORDER_BATCHES = "imb_spp_order_batches";
const COUNTERS = "imb_spp_counters";
const ITEMS = "imb_stock_items";

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

const STATUSES = ["pending", "toConfirm", "ordered", "shipped", "received", "shortage", "cancelled"];
// "open" = still to arrive
const OPEN = ["pending", "toConfirm", "ordered", "shipped", "shortage"];
// Where a line files in the tree: the register classification of its item
// (set automatically on create, 2026-09-22), or one of the two channels the
// team keeps apart — sea-freight orders (海运) and customer special orders.
const CLASSIFICATIONS = ["Screen", "Housing", "Middle Frame", "BackCover", "Battery", "Small Parts", "Tools", "Other"];
const CHANNELS = ["海运", "Special Order", "New Product"];
const CATEGORIES = [...CLASSIFICATIONS, ...CHANNELS];
const isChannel = (c) => CHANNELS.includes(c);
// The classification of an item as the register has it, "Other" when blank.
// The register's say on a line's item: its classification as a module
// category (blank / unknown → Other) and its image id.
async function registerFacts(db, itemId) {
  if (!itemId) return { category: "Other", imageId: null };
  const it = await db.collection(ITEMS).findOne({ itemId: String(itemId) }, { projection: { _id: 0, classification: 1, imageId: 1 } });
  const c = it && it.classification;
  return { category: CLASSIFICATIONS.includes(c) ? c : "Other", imageId: (it && it.imageId) || null };
}

const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const oid = (v) => { try { return new ObjectId(String(v)); } catch (e) { return null; } };
const str = (v) => String(v == null ? "" : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
router.get("/products/search", VIEW, async (req, res, next) => {
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
      suggestedCategory: CLASSIFICATIONS.includes(r.classification) ? r.classification : "Other",
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
    if (q.category) base.category = str(q.category);
    if (q.supplier) base.supplier = str(q.supplier);
    const search = str(q.search);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      base.$or = [{ sku: rx }, { productName: rx }, { orderNo: rx }, { supplier: rx }, { tracking: rx }, { batchNo: rx }, { note: rx }];
    }
    const match = { ...base };
    const statuses = str(q.status).split(",").map((s) => s.trim()).filter((s) => STATUSES.includes(s));
    if (statuses.length) match.status = { $in: statuses };
    else if (String(q.open) === "1") match.status = { $in: OPEN };
    const dir = String(q.sort) === "oldest" ? 1 : -1;

    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const [rows, total, statusAgg, catAgg, suppliers] = await Promise.all([
      col.find(match, { projection: { history: 0 } }).sort({ createdAt: dir, _id: dir }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      col.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
      col.aggregate([{ $group: { _id: "$category", total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", OPEN] }, 1, 0] } }, pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } } } }]).toArray(),
      supplierOptions(db),
    ]);
    const byStatus = {};
    for (const s of statusAgg) byStatus[s._id] = s.n;
    const byCategory = {};
    for (const c of catAgg) byCategory[c._id || ""] = { total: c.total, open: c.open, pending: c.pending };
    // the fixed tree, plus any value a line somehow still carries
    const categories = [...new Set([...CATEGORIES, ...catAgg.map((c) => c._id).filter(Boolean)])];
    return res.json({ success: true, page, pageSize, total, rows, byStatus, byCategory, categories, suppliers });
  } catch (error) {
    next(error);
  }
});

// The pick lists on their own (the Batches page needs the suppliers).
router.get("/meta", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    return res.json({ success: true, categories: CATEGORIES, suppliers: await supplierOptions(db), zohoVendors: ZOHO_VENDORS });
  } catch (error) {
    next(error);
  }
});

// The ordered (then pending) lines waiting to ship — the Create Batch picker.
router.get("/orders/open-lines", BATCH_VIEW, async (req, res, next) => {
  try {
    const search = str(req.query.search);
    const match = { status: { $in: ["ordered", "pending"] } };
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ sku: rx }, { productName: rx }, { orderNo: rx }, { supplier: rx }, { category: rx }];
    }
    const db = await connectToDatabase();
    const rows = await db
      .collection(ORDERS)
      .find(match, { projection: { history: 0 } })
      .sort({ createdAt: 1 })
      .limit(300)
      .toArray();
    rows.sort((a, b) => (a.status === "ordered" ? 0 : 1) - (b.status === "ordered" ? 0 : 1) || new Date(a.orderedAt || a.createdAt) - new Date(b.orderedAt || b.createdAt));
    return res.json({ success: true, rows });
  } catch (error) {
    next(error);
  }
});

// Scan-to-batch: the OLDEST waiting line for a SKU (ordered before pending),
// skipping ids already on the batch being built, so scanning the same SKU
// again walks to its next order.
router.get("/orders/lookup", BATCH_VIEW, async (req, res, next) => {
  try {
    const sku = str(req.query.sku);
    if (!sku) return bad(res, "sku is required");
    const exclude = new Set(str(req.query.exclude).split(",").map((s) => s.trim()).filter(Boolean));
    const db = await connectToDatabase();
    const rows = await db
      .collection(ORDERS)
      .find({ status: { $in: ["ordered", "pending"] }, sku: new RegExp(`^${escapeRegex(sku)}$`, "i") }, { projection: { history: 0 } })
      .toArray();
    const candidates = rows.filter((r) => !exclude.has(String(r._id)));
    if (!candidates.length) return res.json({ success: true, match: null, hadWaiting: rows.length > 0 });
    candidates.sort((a, b) => (a.status === "ordered" ? 0 : 1) - (b.status === "ordered" ? 0 : 1) || new Date(a.orderedAt || a.createdAt) - new Date(b.orderedAt || b.createdAt));
    return res.json({ success: true, match: candidates[0], remaining: candidates.length - 1 });
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

// Create lines — each one its own order (product, quantity, note). A line
// files under its item's register classification unless the client asks
// for a channel (海运 / Special Order).
router.post("/orders", CREATE, async (req, res, next) => {
  try {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    if (!lines.length) return bad(res, "No lines provided");
    if (lines.length > 100) return bad(res, "Too many lines (max 100)");
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
    for (const l of lines) {
      const { seq, no } = await nextNo(db, "order", "SP", 10001, ORDERS);
      const orderQty = Math.round(num(l.orderQty));
      const itemId = str(l.itemId) || null;
      const asked = str(l.category);
      const reg = itemId ? await registerFacts(db, itemId) : null;
      const category = isChannel(asked) ? asked : reg ? reg.category : CLASSIFICATIONS.includes(asked) ? asked : "Other";
      docs.push({
        orderNo: no,
        seq,
        itemId,
        sku: str(l.sku),
        productName: str(l.productName),
        imageId: str(l.imageId) || (reg && reg.imageId) || null,
        category,
        orderQty,
        note: str(l.note),
        status: "pending",
        quotedPrice: null,
        supplier: "",
        unitPrice: null,
        lineTotal: null,
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
    return res.json({ success: true, created: docs.length, orderNos: docs.map((d) => d.orderNo) });
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
// to agree to first).
router.post("/orders/:id/quote", SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "shortage", "ordered", "toConfirm"],
    to: (rec, b) => (b.toConfirm && rec.status !== "toConfirm" ? "toConfirm" : null),
    action: "quoted",
    build: (rec, b) => {
      const price = num(b.unitPrice);
      if (price == null || price < 0) return { error: "Unit price must be 0 or more" };
      const set = { quotedPrice: round2(price) };
      const detail = { quotedPrice: round2(price) };
      if (b.toConfirm && rec.status !== "toConfirm") {
        const note = str(b.note);
        set.confirmFrom = rec.status;
        set.confirmNote = note;
        detail.toConfirm = true;
        if (note) detail.note = note;
      }
      return { set, detail, reply: { quotedPrice: round2(price) } };
    },
  }),
);

// 待确认: parked for a decision (a special order, a doubtful price…) before
// it is placed or shipped. The note says what needs confirming. Either side
// can park a line; either side can confirm it.
router.post("/orders/:id/to-confirm", CREATE_OR_SUPPLY, (req, res, next) =>
  transition(req, res, next, {
    from: ["pending", "ordered", "shortage"],
    to: "toConfirm",
    action: "toConfirm",
    build: (rec, b) => {
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
// Pending / shortage lines placed with one supplier in one go. The batch
// keeps the list that was sent to the supplier; when the quote comes back
// the prices are keyed in here and written onto the lines.
router.get("/order-batches", VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const match = {};
    if (q.supplier) match.supplier = str(q.supplier);
    const search = str(q.search);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ batchNo: rx }, { supplier: rx }, { note: rx }, { "lines.sku": rx }, { "lines.productName": rx }];
    }
    const db = await connectToDatabase();
    const col = db.collection(ORDER_BATCHES);
    const [rows, total] = await Promise.all([
      col.find(match).sort({ seq: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
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

// Place the selected lines with a supplier as one batch.
router.post("/order-batches", SUPPLY, async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = (Array.isArray(b.orderIds) ? b.orderIds : []).map(oid).filter(Boolean);
    if (!ids.length) return bad(res, "No lines selected");
    if (ids.length > 300) return bad(res, "Too many lines (max 300)");
    const supplier = str(b.supplier);
    if (!supplier) return bad(res, "Supplier is required");
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const recs = await col.find({ _id: { $in: ids } }, { projection: { history: 0 } }).toArray();
    const placeable = recs.filter((r) => r.status === "pending" || r.status === "shortage");
    if (!placeable.length) return bad(res, "None of the selected lines is still pending");
    const skipped = recs.filter((r) => !placeable.includes(r)).map((r) => ({ orderNo: r.orderNo, sku: r.sku, status: r.status }));

    const by = actor(req);
    const now = new Date();
    const { seq, no: batchNo } = await nextNo(db, "orderBatch", "OB", 10001, ORDER_BATCHES);
    const batchId = new ObjectId();
    for (const rec of placeable) {
      await col.updateOne(
        { _id: rec._id },
        {
          $set: { supplier, orderedAt: now, orderedBy: by, shortageNote: "", status: "ordered", orderBatchId: batchId, orderBatchNo: batchNo, updatedAt: now },
          $push: { history: hist("ordered", by, { supplier, orderBatch: batchNo }) },
        },
      );
    }
    const lines = placeable.map((r) => ({
      orderId: r._id,
      orderNo: r.orderNo,
      itemId: r.itemId || null,
      sku: r.sku || "",
      productName: r.productName || "",
      category: r.category || "",
      orderQty: r.orderQty,
      note: r.note || "",
      unitPrice: null,
    }));
    const batch = {
      _id: batchId,
      batchNo,
      seq,
      supplier,
      note: str(b.note),
      lines,
      lineCount: lines.length,
      totalQty: lines.reduce((t, l) => t + (l.orderQty || 0), 0),
      pricedCount: 0,
      createdAt: now,
      createdBy: by,
      updatedAt: now,
    };
    await db.collection(ORDER_BATCHES).insertOne(batch);
    return res.json({ success: true, batch, skipped });
  } catch (error) {
    next(error);
  }
});

// The supplier's prices, back onto the lines. A line that has already
// shipped keeps the price it shipped with (its Zoho PO carries it).
router.put("/order-batches/:id/prices", SUPPLY, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const given = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    const db = await connectToDatabase();
    const batch = await db.collection(ORDER_BATCHES).findOne({ _id });
    if (!batch) return res.status(404).json({ success: false, message: "Order batch not found" });
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
            trackings: { $addToSet: "$tracking" },
            count: { $sum: 1 },
            // the pending lines themselves — the dashboard edits one inline
            pendingLines: { $push: { $cond: [{ $eq: ["$status", "pending"] }, { id: { $toString: "$_id" }, orderQty: "$orderQty" }, null] } },
          },
        },
      ])
      .toArray();
    const data = {};
    for (const r of rows) {
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

// A draft batch is the Create Batch form saved for later: lines with or
// without a quantity, tracking, date, note. Nothing ships and no PB number
// is issued until it is shipped — its lines stay ordered / pending and can
// still board another batch (the ship step re-checks them).
async function draftPayload(db, b) {
  const rawLines = Array.isArray(b.lines) ? b.lines : [];
  if (rawLines.length > 300) return { error: "Too many lines (max 300)" };
  const parsed = [];
  for (const l of rawLines) {
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
  const recs = parsed.length ? await db.collection(ORDERS).find({ _id: { $in: parsed.map((p) => p._id) } }, { projection: { history: 0 } }).toArray() : [];
  const byId = new Map(recs.map((r) => [String(r._id), r]));
  const lines = [];
  for (const p of parsed) {
    const rec = byId.get(String(p._id));
    if (!rec) return { error: `Order not found: ${p._id}` };
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
    });
  }
  const vendor = vendorById(b.zohoVendorId);
  return { lines, tracking: str(b.tracking), shippedAt: dayDate(b.shippedAt), note: str(b.note), zohoVendorId: vendor ? vendor.id : "", zohoVendorName: vendor ? vendor.name : "" };
}

// Straight away, or a saved draft
router.post("/batches", BATCH_CREATE, async (req, res, next) => {
  try {
    const b = req.body || {};
    const db = await connectToDatabase();
    if (b.draft === true) {
      const d = await draftPayload(db, b);
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
    const d = await draftPayload(db, req.body || {});
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
  const zohoVendor = vendorById(b.zohoVendorId);
  if (!zohoVendor) return { error: "Pick the Zoho vendor for this batch" };
  const parsed = [];
  for (const l of rawLines) {
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
    if (rec.status === "pending" && !p.supplier && !rec.supplier) return { error: `${rec.sku || rec.orderNo} needs a supplier before it ships` };
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
        // where the line came from — a cancelled batch puts it back there
        prevStatus: rec.status,
      });
    }
    const batch = {
      _id: batchId,
      batchNo,
      seq,
      status: "shipped",
      tracking,
      shippedAt,
      note: str(b.note),
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
// often arrives later). Mirrored onto the lines.
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
    if (b.tracking !== undefined) { set.tracking = str(b.tracking); lineSet.tracking = set.tracking; }
    if (hasVal(b.shippedAt)) { set.shippedAt = dayDate(b.shippedAt); lineSet.shippedAt = set.shippedAt; }
    if (b.note !== undefined) set.note = str(b.note);
    if (!Object.keys(set).length) return bad(res, "Nothing to change");
    await db.collection(BATCHES).updateOne({ _id }, { $set: set });
    if (lineSet.tracking !== undefined || lineSet.shippedAt !== undefined) {
      await db.collection(ORDERS).updateMany({ _id: { $in: (batch.lines || []).map((l) => l.orderId) } }, { $set: lineSet });
    }
    return res.json({ success: true, ...set });
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

module.exports = router;
