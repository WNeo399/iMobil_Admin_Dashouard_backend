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
const { hashPassword } = require("../../utils/authToken");

const VIEW_ORDERS = requirePermission("inflow:order:view");
const VIEW_CUSTOMERS = requirePermission("inflow:customer:view");
const PAY = requirePermission("inflow:order:payment");
const PORTAL = requirePermission("inflow:portal:manage");
const STATEMENT = requirePermission("inflow:statement:view");

const ORDERS = "inflow_salesorders";
const CUSTOMERS = "inflow_customers";
const USERS = "users";

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
  lineItemCount: { $size: { $ifNull: ["$lineItems", []] } },
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

// ── DELETE /inflow/salesorders/:id/payment/:paymentId ───────────────
// Remove a recorded payment and recompute paidAmount from what remains
// (so it stays exact — no accumulated drift). Admin-only.
router.delete("/salesorders/:id/payment/:paymentId", PAY, async (req, res) => {
  try {
    const { id, paymentId } = req.params;
    if (!ObjectId.isValid(id) || !ObjectId.isValid(paymentId)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(id);
    const pid = new ObjectId(paymentId);

    const order = await db
      .collection(ORDERS)
      .findOne({ _id }, { projection: { payments: 1, totalAmount: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    const exists = (order.payments || []).some((p) => p && p._id && String(p._id) === paymentId);
    if (!exists) return res.status(404).json({ success: false, message: "Payment not found" });

    const r = await db.collection(ORDERS).findOneAndUpdate(
      { _id },
      [
        {
          $set: {
            payments: {
              $filter: {
                input: { $ifNull: ["$payments", []] },
                cond: { $ne: ["$$this._id", pid] },
              },
            },
          },
        },
        { $set: { paidAmount: { $sum: "$payments.amount" }, updatedAt: new Date() } },
      ],
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
    console.error("InFlow delete payment error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete payment" });
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

    // Annotate each customer with portal status + login count.
    const names = rows.map((r) => r.name).filter(Boolean);
    if (names.length) {
      const enabledDocs = await db
        .collection(CUSTOMERS)
        .find({ name: { $in: names }, portalEnabled: true }, { projection: { name: 1 } })
        .toArray();
      const enabled = new Set(enabledDocs.map((c) => c.name));
      const countDocs = await db
        .collection(USERS)
        .aggregate([
          { $match: { role: "inflow-customer", inflowCustomerName: { $in: names } } },
          { $group: { _id: "$inflowCustomerName", n: { $sum: 1 } } },
        ])
        .toArray();
      const counts = {};
      countDocs.forEach((c) => { counts[c._id] = c.n; });
      rows.forEach((r) => {
        r.portalEnabled = enabled.has(r.name);
        r.portalUserCount = counts[r.name] || 0;
      });
    }

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

// ── Customer portal management (Admin — inflow:portal:manage) ───────
// Portal logins live in `users` with role "inflow-customer" + inflowCustomerName.
function shapeUser(u) {
  if (!u) return u;
  const { passwordHash, ...rest } = u;
  return rest;
}

// GET /inflow/customers/:name/portal → { portalEnabled, users }
router.get("/customers/:name/portal", PORTAL, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Customer required" });
    const db = await connectToDatabase();
    const cust = await db.collection(CUSTOMERS).findOne({ nameLower: name.toLowerCase() });
    const users = await db
      .collection(USERS)
      .find({ role: "inflow-customer", inflowCustomerName: name }, { projection: { passwordHash: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    return res.json({
      success: true,
      customerName: name,
      portalEnabled: !!(cust && cust.portalEnabled),
      users,
    });
  } catch (e) {
    console.error("InFlow portal get error:", e);
    return res.status(500).json({ success: false, message: "Failed to load portal" });
  }
});

// POST /inflow/customers/:name/portal/users → create a login (enables the portal)
router.post("/customers/:name/portal/users", PORTAL, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    const username = String((req.body && req.body.username) || "").trim();
    const password = req.body && req.body.password;
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    if (!name) return res.status(400).json({ success: false, message: "Customer required" });
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username and password are required." });
    }
    const db = await connectToDatabase();
    const dupOr = [{ username }];
    if (email) dupOr.push({ email });
    const dup = await db.collection(USERS).findOne({ $or: dupOr });
    if (dup) return res.status(409).json({ success: false, message: "Username or email already in use." });

    const now = new Date();
    await db.collection(CUSTOMERS).updateOne(
      { nameLower: name.toLowerCase() },
      {
        $set: { name, nameLower: name.toLowerCase(), portalEnabled: true, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    const cust = await db.collection(CUSTOMERS).findOne({ nameLower: name.toLowerCase() });

    const doc = {
      username,
      email: email || null,
      passwordHash: await hashPassword(password),
      role: "inflow-customer",
      inflowCustomerId: cust ? cust._id : null,
      inflowCustomerName: name,
      shopIds: [],
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    const r = await db.collection(USERS).insertOne(doc);
    return res.json({ success: true, user: shapeUser({ _id: r.insertedId, ...doc }) });
  } catch (e) {
    console.error("InFlow portal create user error:", e);
    return res.status(500).json({ success: false, message: "Failed to create portal user" });
  }
});

// PUT /inflow/customers/:name/portal/users/:userId → toggle active / reset password
router.put("/customers/:name/portal/users/:userId", PORTAL, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: "Bad id" });
    const set = { updatedAt: new Date() };
    if (req.body && typeof req.body.active === "boolean") set.active = req.body.active;
    if (req.body && req.body.password) set.passwordHash = await hashPassword(req.body.password);
    if (Object.keys(set).length === 1) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }
    const db = await connectToDatabase();
    const r = await db.collection(USERS).findOneAndUpdate(
      { _id: new ObjectId(req.params.userId), role: "inflow-customer", inflowCustomerName: name },
      { $set: set },
      { returnDocument: "after", projection: { passwordHash: 0 } },
    );
    const doc = r ? r.value || r : null;
    if (!doc) return res.status(404).json({ success: false, message: "User not found" });
    return res.json({ success: true, user: doc });
  } catch (e) {
    console.error("InFlow portal update user error:", e);
    return res.status(500).json({ success: false, message: "Failed to update portal user" });
  }
});

// DELETE /inflow/customers/:name/portal/users/:userId → remove a login
router.delete("/customers/:name/portal/users/:userId", PORTAL, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!ObjectId.isValid(req.params.userId)) return res.status(400).json({ success: false, message: "Bad id" });
    const db = await connectToDatabase();
    const r = await db.collection(USERS).deleteOne({
      _id: new ObjectId(req.params.userId),
      role: "inflow-customer",
      inflowCustomerName: name,
    });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "User not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("InFlow portal delete user error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove portal user" });
  }
});

// ── Customer statement ──────────────────────────────────────────────
// Build { summary, orders } for one customer name.
async function buildStatement(db, name) {
  const orders = await db
    .collection(ORDERS)
    .aggregate([
      { $match: { customerName: name } },
      { $addFields: DERIVED },
      { $sort: { invoiceDate: -1, _id: -1 } },
      { $project: { payments: 0, lineItems: 0 } },
    ])
    .toArray();
  orders.forEach(withPdf);
  let invoiced = 0, credits = 0, paid = 0, totalAmount = 0;
  orders.forEach((o) => {
    const t = num(o.totalAmount);
    totalAmount += t;
    paid += num(o.paidAmount);
    if (t < 0) credits += t; else invoiced += t;
  });
  return {
    orders,
    summary: { orderCount: orders.length, invoiced, credits, paid, outstanding: totalAmount - paid },
  };
}

// The logged-in customer's OWN statement (portal — inflow:statement:view).
router.get("/statement", STATEMENT, async (req, res) => {
  try {
    const name = req.user && req.user.inflowCustomerName;
    if (!name) return res.json({ success: true, customerName: null, summary: {}, orders: [] });
    const db = await connectToDatabase();
    const { orders, summary } = await buildStatement(db, name);
    return res.json({ success: true, customerName: name, summary, orders });
  } catch (e) {
    console.error("InFlow statement error:", e);
    return res.status(500).json({ success: false, message: "Failed to load statement" });
  }
});

// A NAMED customer's statement, for admins viewing from the Customer page.
router.get("/customers/:name/statement", VIEW_CUSTOMERS, async (req, res) => {
  try {
    const name = String(req.params.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Customer required" });
    const db = await connectToDatabase();
    const { orders, summary } = await buildStatement(db, name);
    return res.json({ success: true, customerName: name, summary, orders });
  } catch (e) {
    console.error("InFlow customer statement error:", e);
    return res.status(500).json({ success: false, message: "Failed to load statement" });
  }
});

// GET /inflow/statement/order/:id → one of the customer's own orders (scoped)
router.get("/statement/order/:id", STATEMENT, async (req, res) => {
  try {
    const name = req.user && req.user.inflowCustomerName;
    if (!name || !ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    const db = await connectToDatabase();
    const [order] = await db
      .collection(ORDERS)
      .aggregate([
        { $match: { _id: new ObjectId(req.params.id), customerName: name } },
        { $addFields: DERIVED },
        { $project: { payments: 0 } },
      ])
      .toArray();
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, order: withPdf(order) });
  } catch (e) {
    console.error("InFlow statement order error:", e);
    return res.status(500).json({ success: false, message: "Failed to load order" });
  }
});

module.exports = router;
