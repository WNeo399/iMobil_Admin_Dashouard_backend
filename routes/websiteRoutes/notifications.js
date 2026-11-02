// iMobile Website → Notification (user ask 2026-11-02): the popup a shopper
// sees on opening the website, during its time period. The ones showing now
// are served to the widget by routes/widgetRoutes/notification.js; this file
// is the authenticated management side (Mongo: imb_web_notifications).
//
//   GET    /website/notifications        list
//   POST   /website/notifications        create
//   PUT    /website/notifications/:id    update — the fields sent, the rest
//                                        stay (the list's switch sends active)
//   DELETE /website/notifications/:id    delete
//
// web:notification:view reads, web:notification:manage writes (admin + iMobile Admin).

const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { cleanLink } = require("../../utils/webLink");

const VIEW = requirePermission("web:notification:view");
const MANAGE = requirePermission("web:notification:manage");
const NOTIFICATIONS = "imb_web_notifications";
// how often one shopper sees it: once per visit (the tab's session), once
// ever, or every time a page opens — the widget keeps track
const FREQUENCIES = ["visit", "once", "always"];

const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
const who = (req) => (req.user && req.user.username) || null;
const dateOf = (v) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d : null;
};
function refuse(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// The body, checked, over what is saved (a PUT may send only some fields).
function fieldsOf(body, saved) {
  const b = { ...saved, ...body };
  const title = str(b.title, 120);
  if (!title) throw refuse("A title is required");
  const startAt = dateOf(b.startAt);
  const endAt = dateOf(b.endAt);
  if (!startAt || !endAt) throw refuse("Set when the notification starts and ends");
  if (endAt <= startAt) throw refuse("The end must be after the start");
  const frequency = b.frequency || "visit";
  if (!FREQUENCIES.includes(frequency)) throw refuse("Bad frequency");
  const link = cleanLink(b.link);
  return {
    title,
    message: str(b.message, 1000),
    buttonText: str(b.buttonText, 40),
    link,
    newTab: !!link && b.newTab === true,
    startAt,
    endAt,
    frequency,
    active: b.active !== false,
  };
}

function fail(res, e, what) {
  if (e.status === 400) return res.status(400).json({ success: false, message: e.message });
  console.error(`Notification ${what} error:`, e);
  return res.status(500).json({ success: false, message: `Failed to ${what} the notification` });
}

router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const rows = await db.collection(NOTIFICATIONS).find({}).sort({ startAt: -1 }).limit(200).toArray();
    return res.json({ success: true, rows });
  } catch (e) {
    return fail(res, e, "load");
  }
});

router.post("/", MANAGE, async (req, res) => {
  try {
    const fields = fieldsOf(req.body);
    const now = new Date();
    const doc = { ...fields, createdAt: now, createdBy: who(req), updatedAt: now, updatedBy: who(req) };
    const db = await connectToDatabase();
    await db.collection(NOTIFICATIONS).insertOne(doc);
    return res.json({ success: true, notification: doc });
  } catch (e) {
    return fail(res, e, "create");
  }
});

router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) throw refuse("Bad id");
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const saved = await db.collection(NOTIFICATIONS).findOne({ _id });
    if (!saved) return res.status(404).json({ success: false, message: "Notification not found" });
    const update = { ...fieldsOf(req.body, saved), updatedAt: new Date(), updatedBy: who(req) };
    await db.collection(NOTIFICATIONS).updateOne({ _id }, { $set: update });
    return res.json({ success: true, notification: { ...saved, ...update } });
  } catch (e) {
    return fail(res, e, "update");
  }
});

router.delete("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) throw refuse("Bad id");
    const db = await connectToDatabase();
    const r = await db.collection(NOTIFICATIONS).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Notification not found" });
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "delete");
  }
});

module.exports = router;
