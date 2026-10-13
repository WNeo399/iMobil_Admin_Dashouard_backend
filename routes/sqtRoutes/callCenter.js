// SQT → Call Center (user ask 2026-10-13): every new case gets a phone
// call from our call center explaining the repair process. This is their
// portal — the cases still to call, the customer's details, "mark as
// contacted" and notes. Nothing else of SQT is reachable with the Call
// Center permissions alone (the SQT Call Center role holds only these).
//
//   GET  /sqt/call-center/cases?tab=todo|contacted|all&q=&page=&pageSize=
//   GET  /sqt/call-center/cases/:id
//   POST /sqt/call-center/cases/:id/contacted     { note? }   mark contacted
//   POST /sqt/call-center/cases/:id/uncontacted               undo / put (back) on the list
//   POST /sqt/call-center/cases/:id/no-call       { note? }   no call needed
//   POST /sqt/call-center/cases/:id/notes         { text }    a call note
//
// On the case doc: `callCenter: { contacted, noCall, at, by, note, attempts: [...] }`.
// Every call-center action also lands in the case's `notes` (with
// source: "call-center"), so the Cases page shows it in the usual place.
const express = require("express");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { hasPermission } = require("../../constants/roles");

const router = express.Router();
const VIEW = requirePermission("sqt:callcenter:view");
const CONTACT = requirePermission("sqt:callcenter:contact");

const COLLECTION = "sqt_cases";
// A cancelled or finished case needs no process call any more.
const DONE = ["cancelled", "completed"];
// Old cases (the user, 2026-10-13): everything that was past "pending" when
// the call center started was marked callCenter.noCall by
// bin/callCenterOldCases.js — no call required, though they stay under "All
// cases" and can still be marked contacted or put on the list. Pending and
// every new case simply have no flag yet: "not contacted".
const PAGE_MAX = 100;

const actor = (req) => (req.user && req.user.username) || "system";
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the portal shows of a case — the customer, the device, where it is.
const PROJECTION = {
  caseId: 1, serviceRequestId: 1, createdAt: 1, status: 1, statusHistory: 1,
  customer: 1, device: 1, describedFault: 1, shopName: 1, shopId: 1, retailer: 1,
  notes: 1, callCenter: 1, source: 1,
};

// The Solvup hand-off is internal (user 2026-10-13): only admin-side SQT
// users — those who may move a case through it (sqt:case:changeStatus:
// Admin, TechElite Admin, iMobile Front Desk) — see its history entries or
// a case sitting in that status. Everyone else (the call center) gets the
// history without them and the status shown as "in-progress".
const SOLVUP = ["waiting-solvup", "issue-with-solvup"];
function canSeeSolvup(req) {
  return hasPermission((req.user && req.user.permissions) || [], "sqt:case:changeStatus");
}
function redact(c, req) {
  if (!c || canSeeSolvup(req)) return c;
  const out = { ...c };
  if (Array.isArray(out.statusHistory)) out.statusHistory = out.statusHistory.filter((h) => !SOLVUP.includes(h && h.status));
  if (SOLVUP.includes(out.status)) out.status = "in-progress";
  return out;
}

function tabMatch(tab) {
  if (tab === "contacted") return { "callCenter.contacted": true };
  if (tab === "all") return {};
  // to call: not yet contacted, and still a live case
  return { "callCenter.contacted": { $ne: true }, "callCenter.noCall": { $ne: true }, status: { $nin: DONE } };
}

function searchMatch(q) {
  const s = str(q, 60);
  if (!s) return {};
  const re = new RegExp(escapeRegex(s), "i");
  const digits = s.replace(/\D/g, "");
  const or = [
    { caseId: re }, { serviceRequestId: re },
    { "customer.firstName": re }, { "customer.lastName": re }, { "customer.email": re },
    { "device.imei": re }, { "device.modelName": re }, { shopName: re },
  ];
  // a phone number typed with spaces / dashes still matches
  if (digits.length >= 4) or.push({ "customer.phone": new RegExp(digits.split("").join("[\\s\\-()]*")) });
  else or.push({ "customer.phone": re });
  return { $or: or };
}

router.get("/cases", VIEW, async (req, res) => {
  try {
    const tab = ["todo", "contacted", "all"].includes(req.query.tab) ? req.query.tab : "todo";
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), PAGE_MAX);
    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const match = { ...tabMatch(tab), ...searchMatch(req.query.q) };
    // the queue: the longest-waiting case first; the rest newest first
    const sort = tab === "todo" ? { createdAt: 1 } : tab === "contacted" ? { "callCenter.at": -1 } : { createdAt: -1 };
    const [rows, total, todo, contacted] = await Promise.all([
      col.find(match, { projection: PROJECTION }).sort(sort).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      col.countDocuments(tabMatch("todo")),
      col.countDocuments(tabMatch("contacted")),
    ]);
    return res.json({ success: true, rows: rows.map((r) => redact(r, req)), total, page, pageSize, counts: { todo, contacted } });
  } catch (e) {
    console.error("call center list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the cases" });
  }
});

router.get("/cases/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid case id" });
    const db = await connectToDatabase();
    const c = await db.collection(COLLECTION).findOne({ _id: new ObjectId(req.params.id) }, { projection: PROJECTION });
    if (!c) return res.status(404).json({ success: false, message: "Case not found" });
    return res.json({ success: true, data: redact(c, req) });
  } catch (e) {
    console.error("call center case error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the case" });
  }
});

// one note on the case, tagged as the call center's, plus the attempt log
async function logCall(col, _id, req, text, patch) {
  const now = new Date();
  const by = actor(req);
  const note = { text, at: now, addedBy: by, source: "call-center" };
  const update = {
    $push: { notes: note, "callCenter.attempts": { at: now, by, text } },
    $set: { updatedAt: now, ...patch(now, by) },
  };
  const r = await col.findOneAndUpdate({ _id }, update, { returnDocument: "after", projection: PROJECTION });
  return r ? r.value || r : null;
}

router.post("/cases/:id/contacted", CONTACT, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid case id" });
    const note = str((req.body || {}).note, 500);
    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const _id = new ObjectId(req.params.id);
    const cur = await col.findOne({ _id }, { projection: { _id: 1 } });
    if (!cur) return res.status(404).json({ success: false, message: "Case not found" });
    const text = `Call center: customer contacted${note ? " — " + note : ""}`;
    const updated = await logCall(col, _id, req, text, (now, by) => ({
      "callCenter.contacted": true, "callCenter.noCall": false, "callCenter.at": now, "callCenter.by": by, "callCenter.note": note,
    }));
    return res.json({ success: true, message: "Marked as contacted", data: redact(updated, req) });
  } catch (e) {
    console.error("call center contacted error:", e);
    return res.status(500).json({ success: false, message: "Failed to mark the case" });
  }
});

router.post("/cases/:id/uncontacted", CONTACT, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid case id" });
    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const _id = new ObjectId(req.params.id);
    const cur = await col.findOne({ _id }, { projection: { _id: 1, "callCenter.contacted": 1 } });
    if (!cur) return res.status(404).json({ success: false, message: "Case not found" });
    const updated = await logCall(col, _id, req, "Call center: put on the call list", () => ({
      "callCenter.contacted": false, "callCenter.noCall": false, "callCenter.at": null, "callCenter.by": null,
    }));
    return res.json({ success: true, message: "Back on the call list", data: redact(updated, req) });
  } catch (e) {
    console.error("call center uncontacted error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the case" });
  }
});

// no call needed (the shop already explained, a duplicate case, an old one…)
router.post("/cases/:id/no-call", CONTACT, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid case id" });
    const note = str((req.body || {}).note, 500);
    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const _id = new ObjectId(req.params.id);
    const cur = await col.findOne({ _id }, { projection: { _id: 1 } });
    if (!cur) return res.status(404).json({ success: false, message: "Case not found" });
    const updated = await logCall(col, _id, req, `Call center: no call needed${note ? " — " + note : ""}`, (now, by) => ({
      "callCenter.noCall": true, "callCenter.contacted": false, "callCenter.at": now, "callCenter.by": by, "callCenter.note": note,
    }));
    return res.json({ success: true, message: "Marked as no call needed", data: redact(updated, req) });
  } catch (e) {
    console.error("call center no-call error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the case" });
  }
});

router.post("/cases/:id/notes", CONTACT, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid case id" });
    const text = str((req.body || {}).text, 1000);
    if (!text) return res.status(400).json({ success: false, message: "Note text is required" });
    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const _id = new ObjectId(req.params.id);
    const cur = await col.findOne({ _id }, { projection: { _id: 1 } });
    if (!cur) return res.status(404).json({ success: false, message: "Case not found" });
    const updated = await logCall(col, _id, req, `Call center: ${text}`, () => ({}));
    return res.json({ success: true, message: "Note added", data: redact(updated, req) });
  } catch (e) {
    console.error("call center note error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the note" });
  }
});

module.exports = router;
module.exports.redact = redact;
