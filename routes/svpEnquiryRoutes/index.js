// Admin endpoints for the Apple SVP (genuine-parts) lookup enquiries.
//
// The public lookup site (Apple_SVP_Lookup) writes a row to imb_svp_enquiry
// whenever a customer's serial isn't on record and they ask us to check with
// the supplier. These endpoints let dashboard admins browse and action them.
//
// Shape of an imb_svp_enquiry doc:
//   { serial, name, contact, note, status, adminNote, createdAt, updatedAt }

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "imb_svp_enquiry";

const VIEW = requirePermission("svp:enquiry:view");
const MANAGE = requirePermission("svp:enquiry:manage");

// Status lifecycle:
//   pending      just submitted, awaiting a supplier check
//   genuine      supplier confirmed it's a genuine part
//   not-genuine  supplier confirmed it's NOT genuine
//   closed       no action needed (spam / no response / withdrawn)
const ALLOWED_STATUSES = ["pending", "genuine", "not-genuine", "closed"];

// ── GET /svpEnquiry/list ────────────────────────────────────────────
//   ?status=<...>     optional status filter
//   ?search=<text>    case-insensitive match on serial / name / contact / note
//   ?page=N&pageSize=M
// Counts ignore search + status so the per-status badges stay stable.
router.get("/list", VIEW, async function (req, res) {
  try {
    const { status, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const fullFilter = {};
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = { $regex: safe, $options: "i" };
      fullFilter.$or = [
        { serial: re },
        { name: re },
        { contact: re },
        { note: re },
      ];
    }
    if (status) {
      if (!ALLOWED_STATUSES.includes(String(status))) {
        return res
          .status(400)
          .json({ success: false, message: `Unknown status "${status}"` });
      }
      fullFilter.status = String(status);
    }

    const [data, total, countsRaw] = await Promise.all([
      collection
        .find(fullFilter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(fullFilter),
      collection
        .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
        .toArray(),
    ]);

    const counts = { all: 0 };
    for (const s of ALLOWED_STATUSES) counts[s] = 0;
    for (const c of countsRaw) {
      const key = c._id || "unknown";
      if (Object.prototype.hasOwnProperty.call(counts, key)) {
        counts[key] = c.count;
      }
      counts.all += c.count;
    }

    return res.json({ success: true, data, total, page, pageSize, counts });
  } catch (error) {
    console.error("List SVP enquiries error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to list enquiries" });
  }
});

// ── PATCH /svpEnquiry/:id ───────────────────────────────────────────
// Body: { status?, adminNote? }. Returns the updated row.
router.patch("/:id", MANAGE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const body = req.body || {};
    const update = {};

    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      const next = String(body.status || "").trim();
      if (!ALLOWED_STATUSES.includes(next)) {
        return res.status(400).json({
          success: false,
          message: `status must be one of: ${ALLOWED_STATUSES.join(", ")}`,
        });
      }
      update.status = next;
    }
    if (Object.prototype.hasOwnProperty.call(body, "adminNote")) {
      update.adminNote = String(body.adminNote || "");
    }

    if (Object.keys(update).length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update" });
    }
    update.updatedAt = new Date();

    const db = await connectToDatabase();
    const result = await db
      .collection(COLLECTION)
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: update },
        { returnDocument: "after" },
      );
    const row = result && (result.value || result);
    if (!row || !row._id) {
      return res
        .status(404)
        .json({ success: false, message: "Enquiry not found" });
    }
    return res.json({ success: true, data: row });
  } catch (error) {
    console.error("Patch SVP enquiry error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update enquiry" });
  }
});

// ── DELETE /svpEnquiry/:id ──────────────────────────────────────────
router.delete("/:id", MANAGE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const db = await connectToDatabase();
    const result = await db
      .collection(COLLECTION)
      .deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Enquiry not found" });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Delete SVP enquiry error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete enquiry" });
  }
});

module.exports = router;
