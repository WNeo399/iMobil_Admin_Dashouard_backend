// POS — Customers (Mongo: pos_customers).
//
// A distributor's own customers. Deliberately keyed on (distributorId,
// email) rather than email alone: the same repairer may hold an account
// with two distributors, and each distributor's customer list is their own
// commercial data. Two records, no shared state.
//
// Accounts are created by the distributor, never self-registered. Ordering
// doesn't require one — a customer record can equally be the contact
// captured at checkout — so nothing here assumes a login exists yet.
//
//   GET    /pos/customers            list (distributor / search / status)
//   POST   /pos/customers            create
//   GET    /pos/customers/:id        one
//   PUT    /pos/customers/:id        edit
//   DELETE /pos/customers/:id        remove
//
// Reading needs pos:customer:view, writing pos:customer:manage — both
// covered by pos:*:* and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { escapeRegex, str, status, address, exact } = require("./common");

const VIEW = requirePermission("pos:customer:view");
const MANAGE = requirePermission("pos:customer:manage");
const CUSTOMERS = "pos_customers";
const DISTRIBUTORS = "pos_distributors";

// One account per email per distributor, enforced at the database too so a
// race between two admins can't slip a duplicate through.
let _indexEnsured = false;
async function ensureIndex(db) {
  if (_indexEnsured) return;
  try {
    await db
      .collection(CUSTOMERS)
      .createIndex({ distributorId: 1, email: 1 }, { unique: true, name: "distributor_email_unique" });
    _indexEnsured = true;
  } catch (e) {
    // A pre-existing duplicate would fail the build; log and carry on so the
    // page still works while it's cleaned up.
    console.warn("POS customers index not created:", (e && e.message) || e);
  }
}

function buildCustomer(body, { partial = false } = {}) {
  const doc = {};
  const set = (key, value) => {
    if (partial && value === undefined) return;
    doc[key] = value;
  };
  if (!partial || body.name !== undefined) set("name", str(body.name, 140));
  // Lower-cased so "Sam@x.com" and "sam@x.com" can't become two accounts.
  if (!partial || body.email !== undefined) set("email", str(body.email, 140).toLowerCase());
  if (!partial || body.phone !== undefined) set("phone", str(body.phone, 60));
  if (!partial || body.address !== undefined) set("address", address(body.address));
  if (!partial || body.note !== undefined) set("note", str(body.note, 500));
  if (!partial || body.status !== undefined) set("status", status(body.status));
  return doc;
}

// ── GET /pos/customers ──────────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const query = {};
    if (req.query.distributorId && ObjectId.isValid(req.query.distributorId)) {
      query.distributorId = new ObjectId(req.query.distributorId);
    }
    if (req.query.status) query.status = String(req.query.status);
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { email: re }, { phone: re }];
    }

    const customers = await db
      .collection(CUSTOMERS)
      .find(query)
      .sort({ name: 1 })
      .limit(1000)
      .toArray();

    // Stamp the distributor's name on each row so the admin list reads
    // without a second lookup per row.
    const ids = [...new Set(customers.map((c) => String(c.distributorId)).filter(Boolean))];
    const dists = ids.length
      ? await db
          .collection(DISTRIBUTORS)
          .find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { name: 1 } })
          .toArray()
      : [];
    const nameById = new Map(dists.map((d) => [String(d._id), d.name]));

    return res.json({
      success: true,
      customers: customers.map((c) => ({
        ...c,
        distributorName: nameById.get(String(c.distributorId)) || "",
      })),
    });
  } catch (e) {
    console.error("List POS customers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load customers" });
  }
});

// ── GET /pos/customers/:id ──────────────────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const customer = await db.collection(CUSTOMERS).findOne({ _id: new ObjectId(req.params.id) });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    return res.json({ success: true, customer });
  } catch (e) {
    console.error("Get POS customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the customer" });
  }
});

// ── POST /pos/customers ─────────────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    if (!ObjectId.isValid(body.distributorId)) {
      return res.status(400).json({ success: false, message: "A distributor is required" });
    }
    const doc = buildCustomer(body);
    if (!doc.name) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    // The account identifier, and what a login would be keyed on later.
    if (!doc.email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const db = await connectToDatabase();
    await ensureIndex(db);
    const distributorId = new ObjectId(body.distributorId);
    const distributor = await db.collection(DISTRIBUTORS).findOne({ _id: distributorId });
    if (!distributor) {
      return res.status(404).json({ success: false, message: "Distributor not found" });
    }

    const dup = await db.collection(CUSTOMERS).findOne({ distributorId, email: doc.email });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: `${distributor.name} already has a customer with that email`,
      });
    }

    const now = new Date();
    doc.distributorId = distributorId;
    doc.createdAt = now;
    doc.updatedAt = now;
    doc.createdBy = (req.user && req.user.username) || null;
    const r = await db.collection(CUSTOMERS).insertOne(doc);
    return res.json({
      success: true,
      message: "Customer added",
      customer: { ...doc, _id: r.insertedId, distributorName: distributor.name },
    });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ success: false, message: "That email is already used by this distributor" });
    }
    console.error("Create POS customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the customer" });
  }
});

// ── PUT /pos/customers/:id ──────────────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const existing = await db.collection(CUSTOMERS).findOne({ _id });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    // A customer belongs to the distributor who created them — moving one
    // would drag their order history across a commercial boundary. Echoing
    // the same value back is fine (the form always sends it).
    if (req.body && req.body.distributorId !== undefined) {
      if (String(req.body.distributorId) !== String(existing.distributorId)) {
        return res.status(400).json({
          success: false,
          message: "A customer can't be moved to another distributor",
        });
      }
    }

    const set = buildCustomer(req.body || {}, { partial: true });
    if (set.name !== undefined && !set.name) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    if (set.email !== undefined && !set.email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }
    if (set.email && set.email !== existing.email) {
      const dup = await db
        .collection(CUSTOMERS)
        .findOne({ _id: { $ne: _id }, distributorId: existing.distributorId, email: set.email });
      if (dup) {
        return res.status(409).json({
          success: false,
          message: "That email is already used by this distributor",
        });
      }
    }

    set.updatedAt = new Date();
    set.updatedBy = (req.user && req.user.username) || null;
    const result = await db
      .collection(CUSTOMERS)
      .findOneAndUpdate({ _id }, { $set: set }, { returnDocument: "after" });
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    return res.json({ success: true, message: "Customer updated", customer: updated });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ success: false, message: "That email is already used by this distributor" });
    }
    console.error("Update POS customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the customer" });
  }
});

// ── DELETE /pos/customers/:id ───────────────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const r = await db.collection(CUSTOMERS).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!r.deletedCount) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    return res.json({ success: true, message: "Customer removed" });
  } catch (e) {
    console.error("Delete POS customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the customer" });
  }
});

module.exports = router;
