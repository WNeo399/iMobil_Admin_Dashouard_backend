// Refurbished Device — Customers (Mongo: refurb_customers).
//
// The buyer registry for refurbished sales orders. Small and simple: a
// customer is a name plus contact details, referenced (and snapshotted)
// by sales orders.
//
//   GET    /refurbished/customers      list (search)
//   POST   /refurbished/customers      create
//   PUT    /refurbished/customers/:id  edit
//   DELETE /refurbished/customers/:id  remove (blocked while orders reference it)
//
// Reading needs refurb:sale:view, writing refurb:sale:manage — both covered
// by refurb:*:* (iMobile Admin) and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const VIEW = requirePermission("refurb:sale:view");
const MANAGE = requirePermission("refurb:sale:manage");
const CUSTOMERS = "refurb_customers";
const ORDERS = "refurb_sales_orders";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCustomer(body, { partial = false } = {}) {
  const doc = {};
  const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
  const set = (key, raw, cap) => {
    if (partial && raw === undefined) return;
    doc[key] = str(raw, cap);
  };
  set("name", body.name, 140);
  set("contactName", body.contactName, 100);
  set("email", body.email, 140);
  set("phone", body.phone, 60);
  set("address", body.address, 300);
  set("note", body.note, 500);
  return doc;
}

// ── GET /refurbished/customers ──────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const query = {};
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { contactName: re }, { email: re }, { phone: re }];
    }
    const customers = await db
      .collection(CUSTOMERS)
      .find(query)
      .sort({ name: 1 })
      .limit(500)
      .toArray();
    return res.json({ success: true, customers });
  } catch (e) {
    console.error("List refurb customers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load customers" });
  }
});

// ── POST /refurbished/customers ─────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const doc = buildCustomer(req.body || {});
    if (!doc.name) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    const db = await connectToDatabase();
    const dup = await db
      .collection(CUSTOMERS)
      .findOne({ name: new RegExp(`^${escapeRegex(doc.name)}$`, "i") });
    if (dup) {
      return res.status(409).json({ success: false, message: `Customer "${doc.name}" already exists` });
    }
    doc.createdAt = new Date();
    doc.updatedAt = doc.createdAt;
    doc.createdBy = (req.user && req.user.username) || null;
    const r = await db.collection(CUSTOMERS).insertOne(doc);
    return res.json({ success: true, message: "Customer added", customer: { ...doc, _id: r.insertedId } });
  } catch (e) {
    console.error("Create refurb customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the customer" });
  }
});

// ── PUT /refurbished/customers/:id ──────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const set = buildCustomer(req.body || {}, { partial: true });
    if (set.name !== undefined && !set.name) {
      return res.status(400).json({ success: false, message: "Customer name is required" });
    }
    set.updatedAt = new Date();
    const db = await connectToDatabase();
    const result = await db
      .collection(CUSTOMERS)
      .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: "after" });
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    return res.json({ success: true, message: "Customer updated", customer: updated });
  } catch (e) {
    console.error("Update refurb customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the customer" });
  }
});

// ── DELETE /refurbished/customers/:id ───────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    // Orders snapshot the customer name, but keep the registry honest:
    // a customer with any order history stays on file.
    const used = await db
      .collection(ORDERS)
      .countDocuments({ customerId: new ObjectId(id) });
    if (used > 0) {
      return res.status(400).json({
        success: false,
        message: `This customer has ${used} sales order(s) — it can't be removed`,
      });
    }
    const r = await db.collection(CUSTOMERS).deleteOne({ _id: new ObjectId(id) });
    if (!r.deletedCount) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    return res.json({ success: true, message: "Customer removed" });
  } catch (e) {
    console.error("Delete refurb customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the customer" });
  }
});

module.exports = router;
