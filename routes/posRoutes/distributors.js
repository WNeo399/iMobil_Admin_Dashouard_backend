// POS — Distributors (Mongo: pos_distributors).
//
// A distributor is a business that embeds our parts widget on their own
// site and sells to their own customers. The record holds who they are,
// which origins may load their widget, the public key that identifies
// them to it, and the Zoho contact we raise sales orders against.
//
//   GET    /pos/distributors                list (search)
//   POST   /pos/distributors                create
//   GET    /pos/distributors/:id            one
//   PUT    /pos/distributors/:id            edit
//   POST   /pos/distributors/:id/rotate-key issue a fresh public key
//   DELETE /pos/distributors/:id            remove
//
// Reading needs pos:distributor:view, writing pos:distributor:manage —
// both covered by pos:*:* and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { escapeRegex, str, status, address, exact } = require("./common");

const VIEW = requirePermission("pos:distributor:view");
const MANAGE = requirePermission("pos:distributor:manage");
const DISTRIBUTORS = "pos_distributors";

// The key the widget carries in its mount tag. It sits in the distributor's
// page source, so it is an identifier and not a credential — it may only
// read that distributor's catalogue and submit an order against them.
// Random regardless, so one distributor can't guess another's.
function newPublicKey() {
  return "pos_" + crypto.randomBytes(16).toString("hex");
}

// Canonical origin: scheme + host (+ port), no path, no trailing slash —
// the shape a browser sends in the Origin header.
function normalizeOrigin(v) {
  const raw = str(v, 200);
  if (!raw) return "";
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw).origin;
  } catch (e) {
    return "";
  }
}

function buildDistributor(body, { partial = false } = {}) {
  const doc = {};
  const set = (key, value) => {
    if (partial && value === undefined) return;
    doc[key] = value;
  };
  if (!partial || body.name !== undefined) set("name", str(body.name, 140));
  if (!partial || body.contactName !== undefined) set("contactName", str(body.contactName, 100));
  if (!partial || body.email !== undefined) set("email", str(body.email, 140));
  if (!partial || body.phone !== undefined) set("phone", str(body.phone, 60));
  if (!partial || body.address !== undefined) set("address", address(body.address));
  if (!partial || body.website !== undefined) set("website", str(body.website, 200));
  // Who they are to us in Zoho — a confirmed POS order raises its sales
  // order against this contact, not against their end customer.
  if (!partial || body.zohoContactId !== undefined) set("zohoContactId", str(body.zohoContactId, 60));
  if (!partial || body.note !== undefined) set("note", str(body.note, 500));
  if (!partial || body.status !== undefined) set("status", status(body.status));
  if (!partial || body.origins !== undefined) {
    const list = Array.isArray(body.origins) ? body.origins : [];
    // De-duplicated; anything unparseable is dropped rather than stored as
    // junk that could never match a real Origin header.
    set("origins", [...new Set(list.map(normalizeOrigin).filter(Boolean))].slice(0, 20));
  }
  return doc;
}

// ── GET /pos/distributors ───────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const query = {};
    if (req.query.status) query.status = String(req.query.status);
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { contactName: re }, { email: re }, { phone: re }, { origins: re }];
    }
    const distributors = await db
      .collection(DISTRIBUTORS)
      .find(query)
      .sort({ name: 1 })
      .limit(500)
      .toArray();
    return res.json({ success: true, distributors });
  } catch (e) {
    console.error("List POS distributors error:", e);
    return res.status(500).json({ success: false, message: "Failed to load distributors" });
  }
});

// ── GET /pos/distributors/:id ───────────────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const distributor = await db
      .collection(DISTRIBUTORS)
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!distributor) {
      return res.status(404).json({ success: false, message: "Distributor not found" });
    }
    return res.json({ success: true, distributor });
  } catch (e) {
    console.error("Get POS distributor error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the distributor" });
  }
});

// ── POST /pos/distributors ──────────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const doc = buildDistributor(req.body || {});
    if (!doc.name) {
      return res.status(400).json({ success: false, message: "Distributor name is required" });
    }
    const db = await connectToDatabase();
    const dup = await db
      .collection(DISTRIBUTORS)
      .findOne({ name: exact(doc.name) });
    if (dup) {
      return res.status(409).json({ success: false, message: `"${doc.name}" already exists` });
    }
    const now = new Date();
    doc.publicKey = newPublicKey();
    doc.createdAt = now;
    doc.updatedAt = now;
    doc.createdBy = (req.user && req.user.username) || null;
    const r = await db.collection(DISTRIBUTORS).insertOne(doc);
    return res.json({
      success: true,
      message: "Distributor added",
      distributor: { ...doc, _id: r.insertedId },
    });
  } catch (e) {
    console.error("Create POS distributor error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the distributor" });
  }
});

// ── PUT /pos/distributors/:id ───────────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const set = buildDistributor(req.body || {}, { partial: true });
    if (set.name !== undefined && !set.name) {
      return res.status(400).json({ success: false, message: "Distributor name is required" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    if (set.name) {
      const dup = await db.collection(DISTRIBUTORS).findOne({
        _id: { $ne: _id },
        name: exact(set.name),
      });
      if (dup) {
        return res.status(409).json({ success: false, message: `"${set.name}" already exists` });
      }
    }
    // The key is issued by the server — rotate-key is the only way to change it.
    delete set.publicKey;
    set.updatedAt = new Date();
    set.updatedBy = (req.user && req.user.username) || null;
    const result = await db
      .collection(DISTRIBUTORS)
      .findOneAndUpdate({ _id }, { $set: set }, { returnDocument: "after" });
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Distributor not found" });
    }
    return res.json({ success: true, message: "Distributor updated", distributor: updated });
  } catch (e) {
    console.error("Update POS distributor error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the distributor" });
  }
});

// ── POST /pos/distributors/:id/rotate-key ───────────────────────────
// Issues a new key and retires the old one immediately, so any widget
// still embedded with the previous key stops resolving. For a key that
// has been misused, not routine housekeeping.
router.post("/:id/rotate-key", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const result = await db.collection(DISTRIBUTORS).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          publicKey: newPublicKey(),
          updatedAt: new Date(),
          updatedBy: (req.user && req.user.username) || null,
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Distributor not found" });
    }
    return res.json({ success: true, message: "New key issued", distributor: updated });
  } catch (e) {
    console.error("Rotate POS distributor key error:", e);
    return res.status(500).json({ success: false, message: "Failed to issue a new key" });
  }
});

// ── DELETE /pos/distributors/:id ────────────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const r = await db.collection(DISTRIBUTORS).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!r.deletedCount) {
      return res.status(404).json({ success: false, message: "Distributor not found" });
    }
    return res.json({ success: true, message: "Distributor removed" });
  } catch (e) {
    console.error("Delete POS distributor error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the distributor" });
  }
});

module.exports = router;
