// InFlow — sales orders + customers, ingested via the public webhook
// (routes/inflowWebhookRoutes). Read-only listing plus admin payment recording.
//
//   GET  /inflow/salesorders            paginated, filterable list
//   GET  /inflow/salesorders/:id        one order (line items + payments)
//   POST /inflow/salesorders/:id/payment   record a payment  (inflow:order:payment)
//   GET  /inflow/customers              per-customer aggregates
//   GET  /inflow/filters                distinct customers / vendors
//
// balance = totalAmount - paidAmount. status is derived:
//   totalAmount < 0 → "credit"  (a credit note under the customer)
//   paidAmount <= 0 → "unpaid"; paid < total → "partial"; else "paid".

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const VIEW_ORDERS = requirePermission("inflow:order:view");
const VIEW_CUSTOMERS = requirePermission("inflow:customer:view");
const PAY = requirePermission("inflow:order:payment");

const ORDERS = "inflow_salesorders";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The webhook stores just the invoice PDF's S3 object key; join it to a base
// URL (override with INFLOW_INVOICE_BASE_URL) so the UI can preview it.
const INVOICE_BASE = (
  process.env.INFLOW_INVOICE_BASE_URL ||
  "https://imobile-airtable-files.s3.us-east-1.amazonaws.com/"
).replace(/\/?$/, "/");

function withPdf(o) {
  if (!o) return o;
  const u = o.invoiceUrl;
  o.invoicePdfUrl = u
    ? /^https?:\/\//i.test(u)
      ? u
      : INVOICE_BASE + String(u).replace(/^\/+/, "")
    : null;
  return o;
}

// Derived balance + status, added via aggregation so we can also filter on them.
const DERIVED = {
  balance: { $subtract: [{ $ifNull: ["$totalAmount", 0] }, { $ifNull: ["$paidAmount", 0] }] },
  status: {
    $switch: {
      branches: [
        { case: { $lt: [{ $ifNull: ["$totalAmount", 0] }, 0] }, then: "credit" },
        { case: { $lte: [{ $ifNull: ["$paidAmount", 0] }, 0] }, then: "unpaid" },
        { case: { $lt: [{ $ifNull: ["$paidAmount", 0] }, "$totalAmount"] }, then: "partial" },
      ],
      default: "paid",
    },
  },
};

function statusOf(total, paid) {
  if (total < 0) return "credit";
  if (paid <= 0) return "unpaid";
  if (paid < total) return "partial";
  return "paid";
}

// ── GET /inflow/salesorders ─────────────────────────────────────────
router.get("/salesorders", VIEW_ORDERS, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const match = {};
    if (req.query.customer) match.customerName = String(req.query.customer);
    if (req.query.vendor) match.vendor = String(req.query.vendor);
    const type = String(req.query.type || "");
    if (type === "credit") match.totalAmount = { $lt: 0 };
    else if (type === "invoice") match.totalAmount = { $gte: 0 };
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ invoiceNumber: rx }, { customerName: rx }, { vendor: rx }];
    }
    if (req.query.dateFrom || req.query.dateTo) {
      match.invoiceDate = {};
      if (req.query.dateFrom) match.invoiceDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const d = new Date(req.query.dateTo);
        d.setHours(23, 59, 59, 999);
        match.invoiceDate.$lte = d;
      }
    }

    const statusFilter = ["unpaid", "partial", "paid", "credit"].includes(req.query.status)
      ? req.query.status
      : null;
    const sortField = ["invoiceDate", "totalAmount", "paidAmount", "balance", "customerName", "invoiceNumber"].includes(req.query.sort)
      ? req.query.sort
      : "invoiceDate";
    const sortDir = String(req.query.order).toLowerCase() === "asc" ? 1 : -1;

    const [agg] = await db
      .collection(ORDERS)
      .aggregate([
        { $match: match },
        { $addFields: DERIVED },
        ...(statusFilter ? [{ $match: { status: statusFilter } }] : []),
        { $sort: { [sortField]: sortDir, _id: -1 } },
        {
          $facet: {
            rows: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              { $project: { lineItems: 0, payments: 0 } },
            ],
            total: [{ $count: "n" }],
          },
        },
      ])
      .toArray();

    return res.json({
      success: true,
      page,
      pageSize,
      total: agg && agg.total && agg.total[0] ? agg.total[0].n : 0,
      rows: ((agg && agg.rows) || []).map(withPdf),
    });
  } catch (e) {
    console.error("InFlow orders list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load sales orders" });
  }
});

// ── GET /inflow/salesorders/:id ─────────────────────────────────────
router.get("/salesorders/:id", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const [order] = await db
      .collection(ORDERS)
      .aggregate([{ $match: { _id: new ObjectId(req.params.id) } }, { $addFields: DERIVED }])
      .toArray();
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, order: withPdf(order) });
  } catch (e) {
    console.error("InFlow order detail error:", e);
    return res.status(500).json({ success: false, message: "Failed to load order" });
  }
});

// ── POST /inflow/salesorders/:id/payment ────────────────────────────
router.post("/salesorders/:id/payment", PAY, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const amount = Number(req.body && req.body.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      return res
        .status(400)
        .json({ success: false, message: "A non-zero payment amount is required." });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const now = new Date();
    let date = now;
    if (req.body && req.body.date) {
      const d = new Date(req.body.date);
      if (!isNaN(d.getTime())) date = d;
    }
    const payment = {
      _id: new ObjectId(),
      amount,
      date,
      note: String((req.body && req.body.note) || "").trim(),
      recordedBy: (req.user && (req.user.username || req.user.email)) || null,
      recordedById: req.user ? req.user._id : null,
      recordedAt: now,
    };

    const r = await db.collection(ORDERS).findOneAndUpdate(
      { _id },
      { $push: { payments: payment }, $inc: { paidAmount: amount }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    const doc = r ? r.value || r : null;
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    const total = num(doc.totalAmount);
    const paid = num(doc.paidAmount);
    doc.balance = total - paid;
    doc.status = statusOf(total, paid);
    return res.json({ success: true, order: withPdf(doc) });
  } catch (e) {
    console.error("InFlow payment error:", e);
    return res.status(500).json({ success: false, message: "Failed to record payment" });
  }
});

// ── GET /inflow/customers ───────────────────────────────────────────
router.get("/customers", VIEW_CUSTOMERS, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const match = { customerName: { $nin: [null, ""] } };
    const search = String(req.query.search || "").trim();
    if (search) match.customerName = { $regex: escapeRegex(search), $options: "i" };

    const rows = await db
      .collection(ORDERS)
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: "$customerName",
            orderCount: { $sum: 1 },
            totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            invoiced: { $sum: { $cond: [{ $gt: ["$totalAmount", 0] }, "$totalAmount", 0] } },
            credits: { $sum: { $cond: [{ $lt: ["$totalAmount", 0] }, "$totalAmount", 0] } },
            paid: { $sum: { $ifNull: ["$paidAmount", 0] } },
            lastInvoiceDate: { $max: "$invoiceDate" },
          },
        },
        { $addFields: { name: "$_id", outstanding: { $subtract: ["$totalAmount", "$paid"] } } },
        { $sort: { outstanding: -1, name: 1 } },
        { $limit: 1000 },
      ])
      .toArray();

    return res.json({ success: true, rows });
  } catch (e) {
    console.error("InFlow customers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load customers" });
  }
});

// ── GET /inflow/filters ─────────────────────────────────────────────
router.get("/filters", VIEW_ORDERS, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const distinct = async (field) =>
      (
        await db
          .collection(ORDERS)
          .aggregate([
            { $match: { [field]: { $nin: [null, ""] } } },
            { $group: { _id: `$${field}` } },
            { $sort: { _id: 1 } },
            { $limit: 2000 },
          ])
          .toArray()
      ).map((r) => r._id);
    const [customers, vendors] = await Promise.all([distinct("customerName"), distinct("vendor")]);
    return res.json({ success: true, customers, vendors });
  } catch (e) {
    console.error("InFlow filters error:", e);
    return res.status(500).json({ success: false, message: "Failed to load filters" });
  }
});

module.exports = router;
