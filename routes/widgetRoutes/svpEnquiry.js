// POST /widget/svpEnquiry
//
// Public endpoint the Apple SVP lookup site calls (server-to-server) to file a
// "please check this serial with the supplier" enquiry. Writes to the
// imb_svp_enquiry collection, which the dashboard's SVP Enquiries page manages.
// The lookup app never touches the database directly — it goes through here.
//
// Body (application/json):
//   serial    string, required
//   name      string, required
//   contact   string, required
//   note      string, optional
//   _company  honeypot — silently dropped if filled
//
// Defence: the widget router's per-IP rate limit (see widgetRoutes/index.js)
// plus an OPTIONAL shared secret — if SVP_SUBMIT_SECRET is set in the backend
// env, the caller must send a matching `x-svp-secret` header.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { notifyRoles } = require("../../utils/notify");
const { ROLES } = require("../../constants/roles");

const COLLECTION = "imb_svp_enquiry";
const MAX = { serial: 100, name: 200, contact: 60, note: 2000 };

router.post("/", express.json(), async function (req, res) {
  try {
    // Optional shared-secret gate for the server-to-server caller.
    const secret = process.env.SVP_SUBMIT_SECRET;
    if (secret && req.get("x-svp-secret") !== secret) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const body = req.body || {};

    // Honeypot — a real form never fills `_company`; bots fill everything.
    if (body._company && String(body._company).trim()) {
      return res.json({ success: true, dropped: true });
    }

    const serial = String(body.serial || "").trim();
    const name = String(body.name || "").trim();
    const contact = String(body.contact || "").trim();
    const note = String(body.note || "").trim();

    if (!serial) {
      return res.status(400).json({ success: false, message: "serial is required" });
    }
    if (!name) {
      return res.status(400).json({ success: false, message: "name is required" });
    }
    if (!contact) {
      return res.status(400).json({ success: false, message: "contact is required" });
    }
    if (
      serial.length > MAX.serial ||
      name.length > MAX.name ||
      contact.length > MAX.contact ||
      note.length > MAX.note
    ) {
      return res
        .status(400)
        .json({ success: false, message: "One or more fields are too long" });
    }

    const now = new Date();
    const doc = {
      serial,
      name,
      contact,
      note,
      status: "pending", // pending | genuine | not-genuine | closed
      adminNote: "",
      source: {
        ip:
          (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
          req.ip ||
          null,
        userAgent: req.get("User-Agent") || null,
      },
      createdAt: now,
      updatedAt: now,
    };

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).insertOne(doc);

    // Notify the iMobile admins who triage SVP enquiries. Best-effort — a
    // notify failure must never fail the public submission.
    try {
      await notifyRoles(db, [ROLES.ADMIN, ROLES.IMOBILE_ADMIN], {
        type: "svp_enquiry_new",
        title: "New SVP enquiry",
        message: `${name} asked about serial ${serial}${contact ? ` — ${contact}` : ""}.`,
        data: { enquiryId: String(result.insertedId), serial, name },
      });
    } catch (notifyErr) {
      console.error("[svpEnquiry] notify error:", notifyErr);
    }

    return res.json({ success: true, id: String(result.insertedId) });
  } catch (error) {
    console.error("[svpEnquiry] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Submission failed" });
  }
});

module.exports = router;
