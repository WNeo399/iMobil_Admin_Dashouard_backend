// SQT follow-up email pickup (user ask 2026-10-28). The user's own
// automation spots SquareTrade follow-up emails in the Hostinger mailbox,
// files them in "Cases Follow up" and tells us here; SQT → Need Attention
// then lists them. We keep only a pointer — the email is read from the
// mailbox when someone opens it (utils/sqtMailbox, utils/sqtCaseEmails).
//
//   POST /integration/sqt-emails
//     { messageId: "<...>",        required — the email's Message-ID header
//       caseRef?: "041513374134",   Case ID or SR number, if the automation knows it
//       folder?: "Cases Follow up", where it is now (a hint; we search anyway)
//       ingestedBy?: "name" }
//   201 { success, data: { emailId, matched, caseId, folder } }   recorded
//   200 { success, data: { emailId, duplicate: true, ... } }      already had it
//   404 not in the mailbox (yet) — safe to retry
//   503 the mailbox can't be reached — safe to retry
//
// Auth: the shared secret SQT_INGEST_KEY, sent as `x-sqt-ingest-key` or
// `Authorization: Bearer <key>`; with it unset the endpoint refuses.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { ingestEmail } = require("../../utils/sqtCaseEmails");

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
}));

function ingestAuth(req, res, next) {
  const secret = process.env.SQT_INGEST_KEY;
  if (!secret) return res.status(503).json({ success: false, message: "SQT email pickup is not configured (set SQT_INGEST_KEY)" });
  const auth = String(req.get("authorization") || "");
  const given = String(req.get("x-sqt-ingest-key") || (auth.startsWith("Bearer ") ? auth.slice(7) : "")).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Invalid ingest key" });
  }
  return next();
}
router.use(ingestAuth);

const view = (doc, extra) => ({
  emailId: doc._id,
  matched: !!doc.sqtCaseId,
  caseId: doc.caseId || null,
  folder: doc.mailbox ? doc.mailbox.folder : null,
  ...extra,
});

router.post("/", async (req, res) => {
  const b = req.body || {};
  const messageId = String(b.messageId || "").trim();
  if (!messageId || messageId.length > 998) {
    return res.status(400).json({ success: false, message: "messageId (the email's Message-ID header) is required" });
  }
  try {
    const db = await connectToDatabase();
    const out = await ingestEmail(db, {
      messageId,
      caseRef: b.caseRef,
      folder: b.folder,
      ingestedBy: b.ingestedBy,
    });
    if (out.result === "not-found") {
      return res.status(404).json({ success: false, message: "That email isn't in the mailbox (yet)" });
    }
    if (out.result === "duplicate") {
      return res.json({ success: true, data: view(out.doc, { duplicate: true }) });
    }
    return res.status(201).json({ success: true, data: view(out.doc, { duplicate: false }) });
  } catch (err) {
    console.error("SQT email ingest error:", err.message);
    const mailboxDown = /IMAP|ECONN|ETIMEDOUT|ENOTFOUND|mailbox|Command failed|Connection/i.test(String(err.message));
    return res
      .status(mailboxDown ? 503 : 500)
      .json({ success: false, message: mailboxDown ? "The mailbox can't be reached right now — try again" : "Could not record the email" });
  }
});

module.exports = router;
