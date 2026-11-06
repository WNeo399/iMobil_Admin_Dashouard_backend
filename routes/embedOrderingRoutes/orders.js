// Embed Ordering — Orders placed through the ordering widget (Mongo: embed_ordering_orders),
// for iMobile staff (user, 2026-11-06: "iMobile staff first", Admin only for
// now). Demo scope: no prices and no Zoho / InFlow link — staff move an
// order through its statuses and keep a note on it.
//
//   GET  /embed-ordering/orders                     list (status / distributor / customer / q / from / to / page)
//   GET  /embed-ordering/orders/:id                 one
//   POST /embed-ordering/orders/:id/status          { status, note? }   new → processing → completed,
//                                                            new | processing → cancelled, cancelled → new
//   PUT  /embed-ordering/orders/:id/staff-note      { staffNote }
//
// Reading needs embedOrdering:order:view, changing embedOrdering:order:manage — both held only
// by *:*:* (Admin) today. Every order keeps its distributorId, so a
// distributor login scoped to its own orders can be added later.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { escapeRegex, str } = require("./common");
const { ORDERS, STATUSES, STATUS_LABELS, TRANSITIONS, ensureOrderIndexes } = require("./orderStore");

const VIEW = requirePermission("embedOrdering:order:view");
const MANAGE = requirePermission("embedOrdering:order:manage");

const byOf = (req) => (req.user && req.user.username) || "staff";

function dayStart(v) {
  const d = new Date(String(v || ""));
  return Number.isNaN(d.getTime()) ? null : d;
}

// The filter for everything but status (the status counts reuse it).
function baseFilter(q) {
  const f = {};
  if (q.distributorId && ObjectId.isValid(q.distributorId)) f.distributorId = new ObjectId(q.distributorId);
  if (q.customerId && ObjectId.isValid(q.customerId)) f.customerId = new ObjectId(q.customerId);
  const from = dayStart(q.from);
  const to = dayStart(q.to);
  if (from || to) {
    f.createdAt = {};
    if (from) f.createdAt.$gte = from;
    // "to" is a day: everything before the next midnight
    if (to) f.createdAt.$lt = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  }
  const search = str(q.q, 80);
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    f.$or = [
      { orderNo: rx },
      { reference: rx },
      { customerName: rx },
      { customerEmail: rx },
      { distributorName: rx },
      { "lines.sku": rx },
      { "lines.name": rx },
    ];
  }
  return f;
}

// ── GET /embed-ordering/orders ─────────────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    await ensureOrderIndexes(db);
    const col = db.collection(ORDERS);
    const base = baseFilter(req.query);
    const statuses = String(req.query.status || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => STATUSES.includes(s));
    const filter = statuses.length ? { ...base, status: { $in: statuses } } : base;
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const [rows, total, ...counts] = await Promise.all([
      col
        .find(filter, { projection: { history: 0, clientOrderId: 0 } })
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      col.countDocuments(filter),
      ...STATUSES.map((s) => col.countDocuments({ ...base, status: s })),
    ]);
    const byStatus = {};
    STATUSES.forEach((s, i) => { byStatus[s] = counts[i]; });
    return res.json({ success: true, rows, total, page, pageSize, counts: byStatus, statusLabels: STATUS_LABELS });
  } catch (e) {
    console.error("Embed Ordering orders list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the orders" });
  }
});

// ── GET /embed-ordering/orders/:id ─────────────────────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: "Order not found" });
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(req.params.id) }, { projection: { clientOrderId: 0 } });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    return res.json({ success: true, order, next: TRANSITIONS[order.status] || [], statusLabels: STATUS_LABELS });
  } catch (e) {
    console.error("Embed Ordering order read error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the order" });
  }
});

// ── POST /embed-ordering/orders/:id/status ─────────────────────────────────────
router.post("/:id/status", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: "Order not found" });
    const to = str(req.body && req.body.status, 20);
    if (!STATUSES.includes(to)) return res.status(400).json({ success: false, message: "Unknown status" });
    const note = str(req.body && req.body.note, 500);
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const _id = new ObjectId(req.params.id);
    const order = await col.findOne({ _id }, { projection: { status: 1, orderNo: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (!(TRANSITIONS[order.status] || []).includes(to)) {
      return res.status(400).json({
        success: false,
        message: `${order.orderNo} is ${STATUS_LABELS[order.status] || order.status} and can't be set to ${STATUS_LABELS[to]}`,
      });
    }
    const now = new Date();
    // Only from the status just read, so two people clicking at once can't
    // both move it.
    const r = await col.updateOne(
      { _id, status: order.status },
      {
        $set: { status: to, updatedAt: now },
        $push: { history: { at: now, by: byOf(req), action: "status", from: order.status, to, note } },
      },
    );
    if (!r.modifiedCount) return res.status(409).json({ success: false, message: "Someone else just changed this order. Reload it and try again." });
    const updated = await col.findOne({ _id }, { projection: { clientOrderId: 0 } });
    return res.json({ success: true, order: updated, next: TRANSITIONS[updated.status] || [] });
  } catch (e) {
    console.error("Embed Ordering order status error:", e);
    return res.status(500).json({ success: false, message: "Failed to change the status" });
  }
});

// ── PUT /embed-ordering/orders/:id/staff-note ──────────────────────────────────
router.put("/:id/staff-note", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).json({ success: false, message: "Order not found" });
    const staffNote = str(req.body && req.body.staffNote, 1000);
    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const _id = new ObjectId(req.params.id);
    const now = new Date();
    const r = await col.updateOne(
      { _id },
      {
        $set: { staffNote, updatedAt: now },
        $push: { history: { at: now, by: byOf(req), action: "note", note: staffNote ? "Staff note saved" : "Staff note cleared" } },
      },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Order not found" });
    const updated = await col.findOne({ _id }, { projection: { clientOrderId: 0 } });
    return res.json({ success: true, order: updated, next: TRANSITIONS[updated.status] || [] });
  } catch (e) {
    console.error("Embed Ordering order note error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the note" });
  }
});

module.exports = router;
