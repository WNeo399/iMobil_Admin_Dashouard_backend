// Refurbished Device — Repairers (Mongo: refurb_repairers).
//
// The small managed list of workshops we send faulty devices to. Kept as
// records rather than free text so a repair batch can point at one and the
// contact details stay in one place.
//
//   GET    /refurbished/repairers      list (search)
//   POST   /refurbished/repairers      create
//   PUT    /refurbished/repairers/:id  edit
//   DELETE /refurbished/repairers/:id  remove (blocked while batches reference it)
//
// Reading needs refurb:repair:view, writing refurb:repair:manage — both
// covered by refurb:*:* (iMobile Admin) and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const VIEW = requirePermission("refurb:repair:view");
const MANAGE = requirePermission("refurb:repair:manage");
const REPAIRERS = "refurb_repairers";
const BATCHES = "refurb_repair_batches";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}

function buildRepairer(body, { partial = false } = {}) {
  const doc = {};
  const set = (key, value) => {
    if (partial && value === undefined) return;
    doc[key] = value;
  };
  if (!partial || body.name !== undefined) set("name", str(body.name, 140));
  if (!partial || body.contactName !== undefined) set("contactName", str(body.contactName, 100));
  if (!partial || body.email !== undefined) set("email", str(body.email, 140));
  if (!partial || body.phone !== undefined) set("phone", str(body.phone, 60));
  if (!partial || body.address !== undefined) set("address", str(body.address, 300));
  if (!partial || body.note !== undefined) set("note", str(body.note, 500));
  if (!partial || body.status !== undefined) {
    const s = str(body.status, 20).toLowerCase();
    set("status", s === "inactive" ? "inactive" : "active");
  }
  return doc;
}

// ── GET /refurbished/repairers ──────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const query = {};
    if (req.query.status) query.status = String(req.query.status);
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { contactName: re }, { email: re }, { phone: re }];
    }
    const repairers = await db
      .collection(REPAIRERS)
      .find(query)
      .sort({ name: 1 })
      .limit(200)
      .toArray();
    return res.json({ success: true, repairers });
  } catch (e) {
    console.error("List repairers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load repairers" });
  }
});

// ── POST /refurbished/repairers ─────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const doc = buildRepairer(req.body || {});
    if (!doc.name) {
      return res.status(400).json({ success: false, message: "Repairer name is required" });
    }
    const db = await connectToDatabase();
    const dup = await db
      .collection(REPAIRERS)
      .findOne({ name: new RegExp("^" + escapeRegex(doc.name) + "$", "i") });
    if (dup) {
      return res.status(409).json({ success: false, message: `"${doc.name}" already exists` });
    }
    const now = new Date();
    doc.createdAt = now;
    doc.updatedAt = now;
    doc.createdBy = (req.user && req.user.username) || null;
    const r = await db.collection(REPAIRERS).insertOne(doc);
    return res.json({ success: true, message: "Repairer added", repairer: { ...doc, _id: r.insertedId } });
  } catch (e) {
    console.error("Create repairer error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the repairer" });
  }
});

// ── PUT /refurbished/repairers/:id ──────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const set = buildRepairer(req.body || {}, { partial: true });
    if (set.name !== undefined && !set.name) {
      return res.status(400).json({ success: false, message: "Repairer name is required" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    if (set.name) {
      const dup = await db.collection(REPAIRERS).findOne({
        _id: { $ne: _id },
        name: new RegExp("^" + escapeRegex(set.name) + "$", "i"),
      });
      if (dup) {
        return res.status(409).json({ success: false, message: `"${set.name}" already exists` });
      }
    }
    set.updatedAt = new Date();
    set.updatedBy = (req.user && req.user.username) || null;
    const result = await db
      .collection(REPAIRERS)
      .findOneAndUpdate({ _id }, { $set: set }, { returnDocument: "after" });
    const updated = result ? result.value || result : null;
    if (!updated || !updated._id) {
      return res.status(404).json({ success: false, message: "Repairer not found" });
    }
    return res.json({ success: true, message: "Repairer updated", repairer: updated });
  } catch (e) {
    console.error("Update repairer error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the repairer" });
  }
});

// ── DELETE /refurbished/repairers/:id ───────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    // Batches snapshot the name, but a repairer with history stays on file.
    const used = await db.collection(BATCHES).countDocuments({ repairerId: _id });
    if (used > 0) {
      return res.status(400).json({
        success: false,
        message: `This repairer has ${used} repair batch(es) — it can't be removed`,
      });
    }
    const r = await db.collection(REPAIRERS).deleteOne({ _id });
    if (!r.deletedCount) {
      return res.status(404).json({ success: false, message: "Repairer not found" });
    }
    return res.json({ success: true, message: "Repairer removed" });
  } catch (e) {
    console.error("Delete repairer error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the repairer" });
  }
});

module.exports = router;
