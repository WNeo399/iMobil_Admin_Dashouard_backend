// Refurbished Device → Warehouse → Transfers: the records left by bulk
// shelf moves (see utils/refurbTransfers.js). Read-only here — a record is
// written by POST /refurbished/devices/bulk-location.
//
//   GET /refurbished/transfers?to=&q=&page=&pageSize=   newest first, no lines
//   GET /refurbished/transfers/:id                      one record with its lines
const express = require("express");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { TRANSFERS } = require("../../utils/refurbTransfers");
const { actsAsPhoneSupplier } = require("../../constants/roles");

const router = express.Router();
const VIEW = requirePermission("refurb:stock:view");

// suppliers see their own stock, not our shelf moves
function staffOnly(req, res, next) {
  if (actsAsPhoneSupplier(req.user)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  next();
}

router.get("/", VIEW, staffOnly, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 24, 1), 200);
    const match = {};
    const to = String(req.query.to || "").trim();
    if (to) match.to = to;
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      match.$or = [{ transferNo: rx }, { "lines.imei": rx }, { "lines.serialNumber": rx }, { note: rx }];
    }
    const col = db.collection(TRANSFERS);
    const [rows, total, tos] = await Promise.all([
      col.find(match, { projection: { lines: 0 } }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      // distinct is outside the Stable API the client pins — group instead
      col.aggregate([{ $group: { _id: "$to" } }]).toArray(),
    ]);
    return res.json({ success: true, rows, total, page, pageSize, destinations: tos.map((x) => x._id).filter(Boolean).sort() });
  } catch (e) {
    console.error("Refurb transfers list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the transfers" });
  }
});

router.get("/:id", VIEW, staffOnly, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const db = await connectToDatabase();
    const transfer = await db.collection(TRANSFERS).findOne({ _id: new ObjectId(req.params.id) });
    if (!transfer) return res.status(404).json({ success: false, message: "Transfer not found" });
    return res.json({ success: true, transfer });
  } catch (e) {
    console.error("Refurb transfer load error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the transfer" });
  }
});

module.exports = router;
