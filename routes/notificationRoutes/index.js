// Per-user in-app notifications. Mounted under the authenticated chain in
// app.js; every query is scoped to the calling user (req.user._id), so no
// extra permission is required — each role sees only its own notifications.
//
//   GET  /notifications/unreadCount        → { count }            (polled)
//   GET  /notifications/top?limit=         → { unreadCount, list }
//   GET  /notifications?page=&pageSize=&unreadOnly=  → paged history
//   POST /notifications/:id/read           → mark one read
//   POST /notifications/readAll            → mark all read

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { NOTIF } = require("../../utils/notify");

const TOP_LIMIT = 15;

// GET /notifications/unreadCount — cheap, polled by the bell.
router.get("/unreadCount", async function (req, res) {
  try {
    const db = await connectToDatabase();
    const count = await db
      .collection(NOTIF)
      .countDocuments({ userId: req.user._id, read: false });
    return res.json({ success: true, count });
  } catch (error) {
    console.error("Notif unreadCount error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load unread count" });
  }
});

// GET /notifications/top — recent items + unread count for the bell panel.
router.get("/top", async function (req, res) {
  try {
    const db = await connectToDatabase();
    const limit = Math.min(parseInt(req.query.limit, 10) || TOP_LIMIT, 50);
    const list = await db
      .collection(NOTIF)
      .find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    const unreadCount = await db
      .collection(NOTIF)
      .countDocuments({ userId: req.user._id, read: false });
    return res.json({ success: true, unreadCount, list });
  } catch (error) {
    console.error("Notif top error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load notifications" });
  }
});

// GET /notifications — full paged history.
router.get("/", async function (req, res) {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize, 10) || 20, 1),
      100,
    );
    const filter = { userId: req.user._id };
    if (String(req.query.unreadOnly) === "true") filter.read = false;
    const total = await db.collection(NOTIF).countDocuments(filter);
    const list = await db
      .collection(NOTIF)
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();
    return res.json({ success: true, total, page, pageSize, list });
  } catch (error) {
    console.error("Notif list error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load notifications" });
  }
});

// POST /notifications/:id/read — mark one read (scoped to the caller).
router.post("/:id/read", async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const db = await connectToDatabase();
    await db
      .collection(NOTIF)
      .updateOne(
        { _id: new ObjectId(id), userId: req.user._id },
        { $set: { read: true, readAt: new Date() } },
      );
    return res.json({ success: true });
  } catch (error) {
    console.error("Notif read error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to mark read" });
  }
});

// POST /notifications/readAll — mark all the caller's notifications read.
router.post("/readAll", async function (req, res) {
  try {
    const db = await connectToDatabase();
    const r = await db
      .collection(NOTIF)
      .updateMany(
        { userId: req.user._id, read: false },
        { $set: { read: true, readAt: new Date() } },
      );
    return res.json({ success: true, updated: r.modifiedCount || 0 });
  } catch (error) {
    console.error("Notif readAll error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to mark all read" });
  }
});

module.exports = router;
