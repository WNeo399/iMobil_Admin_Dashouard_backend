// Refurbished Device — Suppliers (Mongo: refurb_suppliers).
//
// A phone supplier's own upstream suppliers — where THEIR stock comes
// from. The page is phone-supplier only, and every read and write is
// scoped to the stock source on the caller's user record, so each
// supplier location manages its own list and never sees another's.
// Devices point at one via `supplier: { id, name }` (picked at stock
// creation on the Stock page).
//
//   GET    /refurbished/suppliers      list (own source, search)
//   POST   /refurbished/suppliers      create
//   PUT    /refurbished/suppliers/:id  edit
//   DELETE /refurbished/suppliers/:id  remove (blocked while devices reference it)

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { stockSourceForUser } = require("./stockSource");

const VIEW = requirePermission("refurb:stock:view");
const MANAGE = requirePermission("refurb:stock:manage");
const SUPPLIERS = "refurb_suppliers";
const DEVICES = "refurb_devices";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}

// The page is for phone suppliers only, and their stock source is the
// scope for everything below. Staff roles are refused outright — this
// list is the suppliers' own address book, not ours.
function supplierScope(req, res) {
  if (!req.user || req.user.role !== "phone-supplier") {
    res.status(403).json({ success: false, message: "Suppliers are managed by phone-supplier accounts" });
    return null;
  }
  const src = stockSourceForUser(req.user);
  if (!src) {
    res.status(400).json({
      success: false,
      message: "Your account has no stock source assigned — ask an admin to set it first",
    });
    return null;
  }
  return src;
}

function buildSupplier(body, { partial = false } = {}) {
  const doc = {};
  if (!partial || body.name !== undefined) doc.name = str(body.name, 140);
  if (!partial || body.contactName !== undefined) doc.contactName = str(body.contactName, 100);
  if (!partial || body.phone !== undefined) doc.phone = str(body.phone, 60);
  if (!partial || body.email !== undefined) doc.email = str(body.email, 140).toLowerCase();
  if (!partial || body.note !== undefined) doc.note = str(body.note, 500);
  return doc;
}

// ── GET /refurbished/suppliers ──────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    const db = await connectToDatabase();
    const query = { stockSource: src };
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { contactName: re }, { email: re }, { phone: re }];
    }
    const suppliers = await db
      .collection(SUPPLIERS)
      .find(query)
      .sort({ name: 1 })
      .limit(200)
      .toArray();
    return res.json({ success: true, suppliers });
  } catch (e) {
    console.error("List refurb suppliers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load suppliers" });
  }
});

// ── POST /refurbished/suppliers ─────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    const doc = buildSupplier(req.body || {});
    if (!doc.name) {
      return res.status(400).json({ success: false, message: "Supplier name is required" });
    }
    const db = await connectToDatabase();
    const dup = await db.collection(SUPPLIERS).findOne({
      stockSource: src,
      name: new RegExp("^" + escapeRegex(doc.name) + "$", "i"),
    });
    if (dup) {
      return res.status(409).json({ success: false, message: `"${doc.name}" already exists` });
    }
    const now = new Date();
    doc.stockSource = src;
    doc.createdAt = now;
    doc.updatedAt = now;
    doc.createdBy = (req.user && req.user.username) || null;
    const r = await db.collection(SUPPLIERS).insertOne(doc);
    return res.json({ success: true, message: "Supplier added", supplier: { ...doc, _id: r.insertedId } });
  } catch (e) {
    console.error("Create refurb supplier error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the supplier" });
  }
});

// ── PUT /refurbished/suppliers/:id ──────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const set = buildSupplier(req.body || {}, { partial: true });
    if (set.name !== undefined && !set.name) {
      return res.status(400).json({ success: false, message: "Supplier name is required" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    if (set.name) {
      const dup = await db.collection(SUPPLIERS).findOne({
        _id: { $ne: _id },
        stockSource: src,
        name: new RegExp("^" + escapeRegex(set.name) + "$", "i"),
      });
      if (dup) {
        return res.status(409).json({ success: false, message: `"${set.name}" already exists` });
      }
    }
    set.updatedAt = new Date();
    // Scoped update: another source's supplier reads as not found.
    const result = await db
      .collection(SUPPLIERS)
      .findOneAndUpdate({ _id, stockSource: src }, { $set: set }, { returnDocument: "after" });
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    // Devices carry a name snapshot — keep it current when the name moves.
    if (set.name) {
      await db.collection(DEVICES).updateMany(
        { "supplier.id": _id },
        { $set: { "supplier.name": set.name } },
      );
    }
    return res.json({ success: true, message: "Supplier updated", supplier: updated });
  } catch (e) {
    console.error("Update refurb supplier error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the supplier" });
  }
});

// ── DELETE /refurbished/suppliers/:id ───────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const used = await db.collection(DEVICES).countDocuments({ "supplier.id": _id });
    if (used > 0) {
      return res.status(400).json({
        success: false,
        message: `${used} device(s) point at this supplier — it can't be removed`,
      });
    }
    const r = await db.collection(SUPPLIERS).deleteOne({ _id, stockSource: src });
    if (!r.deletedCount) {
      return res.status(404).json({ success: false, message: "Supplier not found" });
    }
    return res.json({ success: true, message: "Supplier removed" });
  } catch (e) {
    console.error("Delete refurb supplier error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the supplier" });
  }
});

module.exports = router;
