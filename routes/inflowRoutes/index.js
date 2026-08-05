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
// Manually uploaded dispatch lists (Order Dispatch → Upload List). Kept in
// their own collection — NOT inflow_salesorders — so they can never leak
// into the Sales Orders page or customer aggregates. Each doc carries a
// hand-typed invoiceNumber and pre-mapped lineItems. A record can be
// linked to a sales order (at upload time or later) — the link is PURELY a
// relationship (linkedOrderId + linkedInvoiceNumber); nothing is
// transferred and the record stays on the dispatch list, where the
// warehouse keeps dispatching from it.
const DISPATCH_UPLOADS = "inflow_dispatch_uploads";

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

// ── GET /inflow/salesorders/:id/credits ─────────────────────────────
// Credit notes for THIS order's customer that still have credit to apply.
// available = paidAmount - totalAmount  (credit consumed lowers paidAmount).
router.get("/salesorders/:id/credits", PAY, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const order = await db
      .collection(ORDERS)
      .findOne({ _id: new ObjectId(req.params.id) }, { projection: { customerName: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    const name = order.customerName;
    if (!name) return res.json({ success: true, credits: [] });

    const docs = await db
      .collection(ORDERS)
      .find(
        { customerName: name, totalAmount: { $lt: 0 } },
        { projection: { invoiceNumber: 1, invoiceDate: 1, invoiceDateRaw: 1, vendor: 1, totalAmount: 1, paidAmount: 1 } },
      )
      .toArray();

    const credits = docs
      .map((c) => {
        const creditAmount = -num(c.totalAmount);
        const available = num(c.paidAmount) - num(c.totalAmount);
        return {
          _id: c._id,
          invoiceNumber: c.invoiceNumber,
          invoiceDate: c.invoiceDate,
          invoiceDateRaw: c.invoiceDateRaw,
          vendor: c.vendor || null,
          creditAmount,
          applied: creditAmount - available,
          available,
        };
      })
      .filter((c) => c.available > 0.005)
      .sort((a, b) => new Date(a.invoiceDate || 0) - new Date(b.invoiceDate || 0));

    return res.json({ success: true, credits });
  } catch (e) {
    console.error("InFlow credits list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load credits" });
  }
});

// ── POST /inflow/salesorders/:id/payment ────────────────────────────
// Records a cash payment and/or applies available credit notes against the
// order balance. Body: { amount, date, note, credits: [{ creditNoteId, amount }] }.
// Applying credit is a transfer: the invoice's paidAmount goes up, and the
// credit note's paidAmount goes down (consuming its available credit), so the
// customer's overall balance is unchanged.
router.post("/salesorders/:id/payment", PAY, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const body = req.body || {};
    const amount = Number(body.amount) || 0;
    const hasCash = Number.isFinite(amount) && amount !== 0;

    // Parse + sanitise the requested credit applications.
    const credits = [];
    for (const c of Array.isArray(body.credits) ? body.credits : []) {
      if (!c || !ObjectId.isValid(c.creditNoteId)) continue;
      const amt = Math.round((Number(c.amount) || 0) * 100) / 100;
      if (amt > 0) credits.push({ creditNoteId: new ObjectId(c.creditNoteId), amount: amt });
    }
    if (!hasCash && credits.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Enter a payment amount or a credit to apply." });
    }

    const db = await connectToDatabase();
    const col = db.collection(ORDERS);
    const _id = new ObjectId(req.params.id);
    const now = new Date();
    let date = now;
    if (body.date) {
      const d = new Date(body.date);
      if (!isNaN(d.getTime())) date = d;
    }
    const by = (req.user && (req.user.username || req.user.email)) || null;
    const byId = req.user ? req.user._id : null;

    const order = await col.findOne({ _id }, { projection: { customerName: 1, invoiceNumber: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });

    const payments = [];
    const cnUpdates = [];
    let paidInc = 0;

    if (hasCash) {
      payments.push({
        _id: new ObjectId(),
        amount,
        date,
        note: String(body.note || "").trim(),
        method: "cash",
        recordedBy: by,
        recordedById: byId,
        recordedAt: now,
      });
      paidInc += amount;
    }

    if (credits.length) {
      const cnDocs = await col
        .find(
          { _id: { $in: credits.map((c) => c.creditNoteId) } },
          { projection: { invoiceNumber: 1, customerName: 1, totalAmount: 1, paidAmount: 1 } },
        )
        .toArray();
      const cnMap = new Map(cnDocs.map((d) => [String(d._id), d]));
      for (const c of credits) {
        const cn = cnMap.get(String(c.creditNoteId));
        if (!cn) return res.status(400).json({ success: false, message: "Credit note not found." });
        if (num(cn.totalAmount) >= 0) {
          return res.status(400).json({ success: false, message: `${cn.invoiceNumber} is not a credit note.` });
        }
        if (cn.customerName !== order.customerName) {
          return res.status(400).json({ success: false, message: "Credit note belongs to another customer." });
        }
        const available = num(cn.paidAmount) - num(cn.totalAmount);
        if (c.amount > available + 0.005) {
          return res
            .status(400)
            .json({ success: false, message: `Only ${available.toFixed(2)} available on ${cn.invoiceNumber}.` });
        }
        const applicationId = new ObjectId();
        payments.push({
          _id: new ObjectId(),
          amount: c.amount,
          date,
          note: "",
          method: "credit",
          creditNoteId: c.creditNoteId,
          creditNoteNumber: cn.invoiceNumber,
          applicationId,
          recordedBy: by,
          recordedById: byId,
          recordedAt: now,
        });
        paidInc += c.amount;
        cnUpdates.push({
          cnId: c.creditNoteId,
          amount: c.amount,
          application: {
            applicationId,
            invoiceId: _id,
            invoiceNumber: order.invoiceNumber,
            amount: c.amount,
            date,
            appliedAt: now,
            appliedBy: by,
          },
        });
      }
    }

    const r = await col.findOneAndUpdate(
      { _id },
      { $push: { payments: { $each: payments } }, $inc: { paidAmount: paidInc }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    const doc = r ? r.value || r : null;
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });

    // Consume each credit note (lower its paidAmount + record the application).
    for (const u of cnUpdates) {
      await col.updateOne(
        { _id: u.cnId },
        { $inc: { paidAmount: -u.amount }, $push: { creditApplications: u.application }, $set: { updatedAt: now } },
      );
    }

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
    const removed = (order.payments || []).find((p) => p && p._id && String(p._id) === paymentId);
    if (!removed) return res.status(404).json({ success: false, message: "Payment not found" });

    // If this payment applied a credit note, hand the credit back: raise the
    // credit note's paidAmount by the amount and drop its application record.
    if (removed.method === "credit" && removed.creditNoteId) {
      await db.collection(ORDERS).updateOne(
        { _id: new ObjectId(removed.creditNoteId) },
        {
          $inc: { paidAmount: num(removed.amount) },
          $pull: { creditApplications: { applicationId: removed.applicationId } },
          $set: { updatedAt: new Date() },
        },
      );
    }

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

// ── POST /inflow/salesorders/:id/skumap ─────────────────────────────
// Map THIS order's line items to real iMobile warehouse SKUs from the
// user's Excel upload. Body: { rows: [{ barcode, sku }] } where barcode is
// the line item's current `sku` value. A fresh upload replaces the order's
// whole mapping (lines not covered by the new file lose their imbSku);
// dispatch progress on the lines is untouched.
router.post("/salesorders/:id/skumap", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ success: false, message: "No mapping rows provided" });
    }
    if (rows.length > 10000) {
      return res.status(400).json({ success: false, message: "Too many rows (max 10,000)" });
    }

    // Last occurrence of a barcode wins within one upload.
    const skuByBarcode = new Map();
    let skipped = 0;
    for (const r of rows) {
      const barcode = String((r && r.barcode) || "").trim();
      const sku = String((r && r.sku) || "").trim();
      if (!barcode || !sku) { skipped++; continue; }
      skuByBarcode.set(barcode, sku);
    }
    if (!skuByBarcode.size) {
      return res.status(400).json({ success: false, message: "No usable rows — every row needs both Barcode and SKU" });
    }

    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const order = await db.collection(ORDERS).findOne({ _id }, { projection: { lineItems: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    const items = Array.isArray(order.lineItems) ? order.lineItems : [];

    const set = { skuMappedAt: new Date() };
    const unset = {};
    let linesMapped = 0;
    items.forEach((li, i) => {
      const mapped = li && li.sku ? skuByBarcode.get(li.sku) : undefined;
      if (mapped) {
        set[`lineItems.${i}.imbSku`] = mapped;
        linesMapped++;
      } else if (li && li.imbSku !== undefined) {
        unset[`lineItems.${i}.imbSku`] = "";
      }
    });

    await db.collection(ORDERS).updateOne(
      { _id },
      Object.keys(unset).length ? { $set: set, $unset: unset } : { $set: set },
    );

    return res.json({
      success: true,
      linesMapped,
      linesTotal: items.length,
      skipped,
    });
  } catch (e) {
    console.error("InFlow SKU map upload error:", e);
    return res.status(500).json({ success: false, message: "Failed to map SKUs" });
  }
});

// ── GET /inflow/dispatch ────────────────────────────────────────────
// Orders that have at least one line item mapped to an iMobile SKU, plus
// unlinked manual dispatch uploads, with full line items so the warehouse
// can record dispatched quantities. Manual records sort by their upload
// time (surfaced as invoiceDate) and carry recordType: "manual".
router.get("/dispatch", VIEW_ORDERS, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const match = { lineItems: { $elemMatch: { imbSku: { $type: "string", $ne: "" } } } };
    // Manual records stay listed whether linked or not — the link is just a
    // relationship to a sales order, not a hand-off.
    const manualMatch = {};
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [
        { invoiceNumber: rx },
        { customerName: rx },
        { "lineItems.imbSku": rx },
        { "lineItems.sku": rx },
      ];
      manualMatch.$or = [
        { invoiceNumber: rx },
        { linkedInvoiceNumber: rx },
        { "lineItems.imbSku": rx },
        { "lineItems.sku": rx },
        { "lineItems.description": rx },
      ];
    }

    const [agg] = await db
      .collection(ORDERS)
      .aggregate([
        { $match: match },
        { $addFields: { recordType: "order" } },
        {
          $unionWith: {
            coll: DISPATCH_UPLOADS,
            pipeline: [
              { $match: manualMatch },
              { $addFields: { recordType: "manual", invoiceDate: "$createdAt" } },
            ],
          },
        },
        { $sort: { invoiceDate: -1, _id: -1 } },
        {
          $facet: {
            rows: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              { $project: { payments: 0 } },
            ],
            total: [{ $count: "n" }],
          },
        },
      ])
      .toArray();

    const rows = ((agg && agg.rows) || []).map((o) => {
      const items = Array.isArray(o.lineItems) ? o.lineItems : [];
      const orderedQty = items.reduce((s, li) => s + num(li && li.quantity), 0);
      const dispatchedQty = items.reduce((s, li) => s + num(li && li.dispatchedQty), 0);
      o.orderedQty = orderedQty;
      o.dispatchedQty = dispatchedQty;
      o.dispatchStatus =
        dispatchedQty <= 0 ? "pending" : dispatchedQty < orderedQty ? "partial" : "dispatched";
      return withPdf(o);
    });

    return res.json({
      success: true,
      page,
      pageSize,
      total: agg && agg.total && agg.total[0] ? agg.total[0].n : 0,
      rows,
    });
  } catch (e) {
    console.error("InFlow dispatch list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load dispatch orders" });
  }
});

// ── POST /inflow/dispatch/:id/qty ───────────────────────────────────
// Record the dispatched quantity on one line item. Body: { lineIndex, qty,
// type? }. type: "manual" targets an uploaded dispatch record instead of a
// sales order — the two live in different collections but share the shape.
router.post("/dispatch/:id/qty", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const lineIndex = Number(req.body && req.body.lineIndex);
    const qty = Number(req.body && req.body.qty);
    if (!Number.isInteger(lineIndex) || lineIndex < 0) {
      return res.status(400).json({ success: false, message: "Bad line index" });
    }
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ success: false, message: "Dispatched qty must be 0 or more" });
    }
    const coll =
      String((req.body && req.body.type) || "") === "manual" ? DISPATCH_UPLOADS : ORDERS;

    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const order = await db.collection(coll).findOne({ _id }, { projection: { lineItems: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Not found" });
    if (!Array.isArray(order.lineItems) || lineIndex >= order.lineItems.length) {
      return res.status(400).json({ success: false, message: "Line item not found" });
    }

    await db.collection(coll).updateOne(
      { _id },
      {
        $set: {
          [`lineItems.${lineIndex}.dispatchedQty`]: qty,
          [`lineItems.${lineIndex}.dispatchedAt`]: new Date(),
        },
      },
    );
    return res.json({ success: true });
  } catch (e) {
    console.error("InFlow dispatch qty error:", e);
    return res.status(500).json({ success: false, message: "Failed to save dispatched qty" });
  }
});

// ── POST /inflow/dispatch/:id/batch ─────────────────────────────────
// Record one warehouse dispatch batch (scanned picks). Body: { lines:
// [{ lineIndex, qty }], type? } — type "manual" targets an uploaded
// record. Appends a numbered batch (snapshotting sku/description per line
// so packing lists can be reprinted later) and adds the quantities onto
// the lines' dispatchedQty. Rejects a batch that would push any line past
// its ordered quantity.
router.post("/dispatch/:id/batch", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const incoming = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    // Merge duplicate lineIndex entries so each line gets ONE $set below.
    const qtyByIndex = new Map();
    for (const l of incoming) {
      const idx = Number(l && l.lineIndex);
      const qty = Number(l && l.qty);
      if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(qty) || qty <= 0) continue;
      qtyByIndex.set(idx, (qtyByIndex.get(idx) || 0) + qty);
    }
    if (!qtyByIndex.size) {
      return res.status(400).json({ success: false, message: "No lines in this batch" });
    }
    const coll =
      String((req.body && req.body.type) || "") === "manual" ? DISPATCH_UPLOADS : ORDERS;

    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const doc = await db
      .collection(coll)
      .findOne({ _id }, { projection: { lineItems: 1, dispatchBatches: 1, invoiceNumber: 1 } });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    const items = Array.isArray(doc.lineItems) ? doc.lineItems : [];

    const now = new Date();
    const set = { updatedAt: now };
    const batchLines = [];
    for (const [idx, qty] of qtyByIndex) {
      const li = items[idx];
      if (!li) {
        return res.status(400).json({ success: false, message: `Line ${idx + 1} not found` });
      }
      const next = (Number(li.dispatchedQty) || 0) + qty;
      if (Number(li.quantity) > 0 && next > Number(li.quantity)) {
        return res.status(400).json({
          success: false,
          message: `"${li.imbSku || li.sku || `line ${idx + 1}`}" would exceed its ordered quantity (${li.quantity})`,
        });
      }
      set[`lineItems.${idx}.dispatchedQty`] = next;
      set[`lineItems.${idx}.dispatchedAt`] = now;
      batchLines.push({
        lineIndex: idx,
        imbSku: li.imbSku || "",
        sku: li.sku || "",
        description: li.description || "",
        qty,
      });
    }

    const batch = {
      // max+1 (not count+1) so numbering stays unique even after a batch
      // is deleted via the edit endpoint below.
      batchNo:
        (Array.isArray(doc.dispatchBatches)
          ? doc.dispatchBatches.reduce((m, b) => Math.max(m, Number(b && b.batchNo) || 0), 0)
          : 0) + 1,
      at: now,
      by: (req.user && req.user.username) || null,
      units: batchLines.reduce((s, l) => s + l.qty, 0),
      lines: batchLines,
    };

    await db.collection(coll).updateOne({ _id }, { $set: set, $push: { dispatchBatches: batch } });
    const updated = await db.collection(coll).findOne({ _id }, { projection: { payments: 0 } });
    return res.json({ success: true, batch, record: updated });
  } catch (e) {
    console.error("InFlow dispatch batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to record dispatch batch" });
  }
});

// ── PUT /inflow/dispatch/:id/batch/:batchNo ─────────────────────────
// Update a recorded batch's quantities. Body: { lines: [{ lineIndex,
// qty }], type? } covering the batch's lines — qty 0 removes a line, and
// a batch whose every line hits 0 is deleted. The difference against the
// old quantities is applied to the affected lineItems' dispatchedQty, so
// the order's totals stay truthful. Same over-dispatch guard as recording.
router.put("/dispatch/:id/batch/:batchNo", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const batchNo = Number(req.params.batchNo);
    if (!Number.isInteger(batchNo) || batchNo <= 0) {
      return res.status(400).json({ success: false, message: "Bad batch number" });
    }
    const incoming = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    const qtyByIndex = new Map();
    for (const l of incoming) {
      const idx = Number(l && l.lineIndex);
      const qty = Number(l && l.qty);
      if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(qty) || qty < 0) {
        return res.status(400).json({ success: false, message: "Bad line quantities" });
      }
      qtyByIndex.set(idx, (qtyByIndex.get(idx) || 0) + qty);
    }
    const coll =
      String((req.body && req.body.type) || "") === "manual" ? DISPATCH_UPLOADS : ORDERS;

    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const doc = await db
      .collection(coll)
      .findOne({ _id }, { projection: { lineItems: 1, dispatchBatches: 1 } });
    if (!doc) return res.status(404).json({ success: false, message: "Not found" });
    const batches = Array.isArray(doc.dispatchBatches) ? doc.dispatchBatches : [];
    const bIdx = batches.findIndex((b) => b && Number(b.batchNo) === batchNo);
    if (bIdx === -1) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }
    const batch = batches[bIdx];
    const items = Array.isArray(doc.lineItems) ? doc.lineItems : [];

    const now = new Date();
    const set = { updatedAt: now };
    const newLines = [];
    for (const bl of batch.lines || []) {
      if (!bl) continue;
      const idx = Number(bl.lineIndex);
      // Lines not covered by the payload keep their recorded quantity.
      const newQty = qtyByIndex.has(idx) ? qtyByIndex.get(idx) : Number(bl.qty) || 0;
      const delta = newQty - (Number(bl.qty) || 0);
      if (delta !== 0) {
        const li = items[idx];
        if (!li) {
          return res.status(400).json({ success: false, message: `Line ${idx + 1} not found` });
        }
        const next = (Number(li.dispatchedQty) || 0) + delta;
        if (next < 0) {
          return res.status(400).json({
            success: false,
            message: `"${li.imbSku || li.sku || `line ${idx + 1}`}" would drop below 0 dispatched`,
          });
        }
        if (Number(li.quantity) > 0 && next > Number(li.quantity)) {
          return res.status(400).json({
            success: false,
            message: `"${li.imbSku || li.sku || `line ${idx + 1}`}" would exceed its ordered quantity (${li.quantity})`,
          });
        }
        set[`lineItems.${idx}.dispatchedQty`] = next;
        set[`lineItems.${idx}.dispatchedAt`] = now;
      }
      if (newQty > 0) newLines.push({ ...bl, qty: newQty });
    }

    if (newLines.length) {
      set[`dispatchBatches.${bIdx}.lines`] = newLines;
      set[`dispatchBatches.${bIdx}.units`] = newLines.reduce((s, l) => s + l.qty, 0);
      set[`dispatchBatches.${bIdx}.editedAt`] = now;
      set[`dispatchBatches.${bIdx}.editedBy`] = (req.user && req.user.username) || null;
      await db.collection(coll).updateOne({ _id }, { $set: set });
    } else {
      // Every line zeroed — the batch itself goes away. Two steps because
      // $pull can't run alongside a positional $set on the same array.
      await db.collection(coll).updateOne({ _id }, { $set: set });
      await db
        .collection(coll)
        .updateOne({ _id }, { $pull: { dispatchBatches: { batchNo } } });
    }

    const updated = await db.collection(coll).findOne({ _id }, { projection: { payments: 0 } });
    return res.json({
      success: true,
      removed: !newLines.length,
      record: updated,
    });
  } catch (e) {
    console.error("InFlow dispatch batch update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update batch" });
  }
});

// ── GET /inflow/dispatch/manual ─────────────────────────────────────
// Unlinked manual dispatch records, for the Sales Orders page's "Link
// Dispatch" picker (the reverse direction of the dispatch page's Link
// action — same underlying link endpoint either way).
router.get("/dispatch/manual", VIEW_ORDERS, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const match = { linkedOrderId: null };
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ invoiceNumber: rx }, { "lineItems.imbSku": rx }, { "lineItems.sku": rx }];
    }
    const rows = await db
      .collection(DISPATCH_UPLOADS)
      .find(match)
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    return res.json({
      success: true,
      rows: rows.map((r) => ({
        _id: r._id,
        invoiceNumber: r.invoiceNumber,
        createdAt: r.createdAt,
        createdBy: r.createdBy || null,
        lineCount: Array.isArray(r.lineItems) ? r.lineItems.length : 0,
        units: (r.lineItems || []).reduce((s, li) => s + (num(li && li.quantity) || 0), 0),
        dispatchedUnits: (r.lineItems || []).reduce((s, li) => s + (num(li && li.dispatchedQty) || 0), 0),
      })),
    });
  } catch (e) {
    console.error("InFlow dispatch manual list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load dispatch records" });
  }
});

// ── POST /inflow/dispatch/manual ────────────────────────────────────
// Create a dispatch record from an uploaded Excel list. The invoice number
// is typed by the user; rows come pre-mapped ({ barcode, sku, description,
// quantity } where sku is the real iMobile warehouse SKU). The record can
// be linked to a real sales order later.
router.post("/dispatch/manual", VIEW_ORDERS, async (req, res) => {
  try {
    const invoiceNumber = String((req.body && req.body.invoiceNumber) || "").trim();
    if (!invoiceNumber) {
      return res.status(400).json({ success: false, message: "Invoice # is required" });
    }
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ success: false, message: "No rows provided" });
    }
    if (rows.length > 2000) {
      return res.status(400).json({ success: false, message: "Too many rows (max 2,000)" });
    }

    let skipped = 0;
    const lineItems = [];
    for (const r of rows) {
      const imbSku = String((r && r.sku) || "").trim();
      const quantity = Number(r && r.quantity);
      if (!imbSku || !Number.isFinite(quantity) || quantity <= 0) { skipped++; continue; }
      lineItems.push({
        // Same line shape as a sales order: sku = the barcode, imbSku = the
        // warehouse SKU — so the dispatch page (and the link step) treat
        // manual lines exactly like mapped order lines.
        sku: String((r && r.barcode) || "").trim(),
        imbSku,
        description: String((r && r.description) || "").trim(),
        quantity,
      });
    }
    if (!lineItems.length) {
      return res.status(400).json({ success: false, message: "No usable rows — every row needs a SKU and a positive Quantity" });
    }

    const db = await connectToDatabase();
    const now = new Date();

    // Optional: link the record to a sales order right at upload time.
    let linked = { linkedOrderId: null, linkedInvoiceNumber: null };
    const rawOrderId = req.body && req.body.orderId;
    if (rawOrderId) {
      if (!ObjectId.isValid(rawOrderId)) {
        return res.status(400).json({ success: false, message: "Bad order id" });
      }
      const order = await db
        .collection(ORDERS)
        .findOne({ _id: new ObjectId(rawOrderId) }, { projection: { invoiceNumber: 1 } });
      if (!order) {
        return res.status(404).json({ success: false, message: "Sales order not found" });
      }
      linked = {
        linkedOrderId: order._id,
        linkedInvoiceNumber: order.invoiceNumber || null,
        linkedAt: now,
        linkedBy: (req.user && req.user.username) || null,
      };
    }

    const doc = {
      invoiceNumber,
      source: "upload",
      lineItems,
      ...linked,
      createdAt: now,
      createdBy: (req.user && req.user.username) || null,
      updatedAt: now,
    };
    const r = await db.collection(DISPATCH_UPLOADS).insertOne(doc);
    return res.json({
      success: true,
      id: r.insertedId,
      lines: lineItems.length,
      skipped,
      linkedInvoiceNumber: linked.linkedInvoiceNumber,
    });
  } catch (e) {
    console.error("InFlow dispatch upload error:", e);
    return res.status(500).json({ success: false, message: "Failed to create dispatch record" });
  }
});

// ── POST /inflow/dispatch/manual/:id/link ───────────────────────────
// Link (re-link, or unlink) an uploaded dispatch record to a sales order.
// PURELY a relationship — nothing is transferred and the record stays on
// the dispatch list; the warehouse keeps dispatching from it. Body:
// { orderId } to link, { orderId: null } to unlink.
router.post("/dispatch/manual/:id/link", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const upload = await db
      .collection(DISPATCH_UPLOADS)
      .findOne({ _id }, { projection: { _id: 1 } });
    if (!upload) return res.status(404).json({ success: false, message: "Upload record not found" });

    const now = new Date();
    const rawOrderId = req.body && req.body.orderId;
    if (rawOrderId == null || rawOrderId === "") {
      await db.collection(DISPATCH_UPLOADS).updateOne(
        { _id },
        {
          $set: {
            linkedOrderId: null,
            linkedInvoiceNumber: null,
            linkedAt: null,
            linkedBy: null,
            updatedAt: now,
          },
        },
      );
      return res.json({ success: true, unlinked: true });
    }

    if (!ObjectId.isValid(rawOrderId)) {
      return res.status(400).json({ success: false, message: "Bad order id" });
    }
    const order = await db
      .collection(ORDERS)
      .findOne({ _id: new ObjectId(rawOrderId) }, { projection: { invoiceNumber: 1 } });
    if (!order) return res.status(404).json({ success: false, message: "Sales order not found" });

    await db.collection(DISPATCH_UPLOADS).updateOne(
      { _id },
      {
        $set: {
          linkedOrderId: order._id,
          linkedInvoiceNumber: order.invoiceNumber || null,
          linkedAt: now,
          linkedBy: (req.user && req.user.username) || null,
          updatedAt: now,
        },
      },
    );
    return res.json({ success: true, orderInvoiceNumber: order.invoiceNumber || "" });
  } catch (e) {
    console.error("InFlow dispatch link error:", e);
    return res.status(500).json({ success: false, message: "Failed to link dispatch record" });
  }
});

// ── DELETE /inflow/dispatch/manual/:id ──────────────────────────────
// Remove an uploaded dispatch record. The link is just a relationship, so
// linked records are deletable too — the confirm dialog is the guard.
router.delete("/dispatch/manual/:id", VIEW_ORDERS, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const r = await db
      .collection(DISPATCH_UPLOADS)
      .deleteOne({ _id: new ObjectId(req.params.id) });
    if (r.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("InFlow dispatch delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete dispatch record" });
  }
});

module.exports = router;
