// Refurbished Device — Chat Orders, the staff side (2026-11-25).
// Orders placed from the WhatsApp chat bot (POST /stock-chat/orders), kept
// apart from Sales Orders. See utils/stockChatOrders.js for the rules.
//
//   GET  /refurbished/chat-orders                 ?status=&q=&page=&pageSize= → { rows, total, counts }
//   GET  /refurbished/chat-orders/:id             one order (with history)
//   POST /refurbished/chat-orders/:id/reopen      expired → pending (stock re-checked, prices re-read)
//   POST /refurbished/chat-orders/:id/scan        { code, picks } → { device, lineIndex } (one scan while picking; nothing saved)
//   POST /refurbished/chat-orders/:id/confirm     { picks: [{ deviceId, lineIndex }], note? }  pending → confirmed, every unit scanned
//   POST /refurbished/chat-orders/:id/complete    { salesOrderNo?, note? }  confirmed → completed
//   POST /refurbished/chat-orders/:id/cancel      { reason }  pending / confirmed / expired → cancelled
//   PUT  /refurbished/chat-orders/:id/note        { staffNote }
//
// Reading needs refurb:sale:view, the rest refurb:sale:manage — as Sales
// Orders.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const CO = require("../../utils/stockChatOrders");

const VIEW = requirePermission("refurb:sale:view");
const MANAGE = requirePermission("refurb:sale:manage");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function idOf(req, res) {
  if (!ObjectId.isValid(String(req.params.id || ""))) {
    res.status(400).json({ success: false, message: "Invalid id" });
    return null;
  }
  return new ObjectId(String(req.params.id));
}

function fail(res, e, what) {
  if (e instanceof CO.OrderError) return res.status(e.status).json({ success: false, message: e.message, ...e.extra });
  console.error(`Chat orders ${what} error:`, e);
  return res.status(500).json({ success: false, message: `Failed to ${what} the chat order` });
}

// ── list ─────────────────────────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    await CO.ensureOrderIndexes(db);
    await CO.expireOrders(db);
    const col = db.collection(CO.ORDERS);
    const q = {};
    const status = String(req.query.status || "");
    if (status && status !== "all") {
      if (status === "open") q.status = { $in: ["pending", "confirmed"] };
      else if (CO.STATUSES.includes(status)) q.status = status;
      else return res.status(400).json({ success: false, message: "Unknown status" });
    }
    const text = String(req.query.q || "").trim();
    if (text) {
      const re = new RegExp(escapeRe(text), "i");
      const digits = text.replace(/\D/g, "");
      const or = [{ orderNo: re }, { customerName: re }, { "items.model": re }, { note: re }];
      if (digits.length >= 4) or.push({ phone: new RegExp(escapeRe(digits.replace(/^0/, ""))) });
      q.$or = or;
    }
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [rows, total, byStatus] = await Promise.all([
      col.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(q),
      col.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    ]);
    const counts = Object.fromEntries(CO.STATUSES.map((s) => [s, 0]));
    for (const c of byStatus) if (c._id in counts) counts[c._id] = c.n;
    return res.json({ success: true, rows, total, page, pageSize, counts });
  } catch (e) {
    return fail(res, e, "list");
  }
});

router.get("/:id", VIEW, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffOrder(db, id) });
  } catch (e) {
    return fail(res, e, "load");
  }
});

router.post("/:id/reopen", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffReopen(db, id, req.user) });
  } catch (e) {
    return fail(res, e, "re-check");
  }
});

router.post("/:id/scan", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const b = req.body || {};
    const db = await connectToDatabase();
    return res.json({ success: true, ...(await CO.staffScan(db, id, b.code, b.picks)) });
  } catch (e) {
    // a refused scan is an answer, shown under the scan box — 200, so the
    // dashboard doesn't also pop an error for every wrong scan (no `code`
    // key: the axios layer reads that as a status)
    if (e instanceof CO.OrderError) return res.json({ success: false, message: e.message, reason: e.code });
    return fail(res, e, "scan for");
  }
});

router.post("/:id/confirm", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const b = req.body || {};
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffConfirm(db, id, req.user, b.note, b.picks) });
  } catch (e) {
    return fail(res, e, "confirm");
  }
});

router.post("/:id/complete", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const b = req.body || {};
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffComplete(db, id, req.user, b.salesOrderNo, b.note) });
  } catch (e) {
    return fail(res, e, "complete");
  }
});

router.post("/:id/cancel", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffCancel(db, id, req.user, (req.body || {}).reason) });
  } catch (e) {
    return fail(res, e, "cancel");
  }
});

router.put("/:id/note", MANAGE, async (req, res) => {
  try {
    const id = idOf(req, res);
    if (!id) return;
    const db = await connectToDatabase();
    return res.json({ success: true, order: await CO.staffNote(db, id, req.user, (req.body || {}).staffNote) });
  } catch (e) {
    return fail(res, e, "save the note on");
  }
});

module.exports = router;
