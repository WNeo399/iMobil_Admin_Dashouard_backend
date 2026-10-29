// SQT → Need Attention (user ask 2026-10-28): SquareTrade follow-up emails
// the user's automation picked up (POST /integration/sqt-emails), read and
// answered from the dashboard. Only pointer records live in
// `sqt_case_emails`; bodies and attachments are read from the Hostinger
// mailbox on demand (utils/sqtMailbox — read-only, never touches flags).
//
//   GET  /sqt/case-emails/attention?tab=open|replied|handled|unmatched&q=&page=&pageSize=
//   GET  /sqt/case-emails/counts                       { open, unmatched }
//   GET  /sqt/case-emails/open-counts?ids=a,b          { [sqtCaseId]: n }  (Cases page badge)
//   GET  /sqt/case-emails/case/:id                     the case + every email on it
//   GET  /sqt/case-emails/:emailId/content             the email, from the mailbox
//   GET  /sqt/case-emails/:emailId/attachments/:index  one attachment, from the mailbox
//   GET  /sqt/case-emails/case/:id/original/content            the request the case was created from
//   GET  /sqt/case-emails/case/:id/original/attachments/:index (sqt_cases.source.messageId)
//   POST /sqt/case-emails/case/:id/reply   multipart { to, cc, subject, body, replyToEmailId, includeQuote, files[] }
//   POST /sqt/case-emails/case/:id/handled { note? }   every open email on the case → handled
//   POST /sqt/case-emails/:emailId/handled { note? }   one email (Unmatched → dismiss)
//   POST /sqt/case-emails/:emailId/reopen
//   POST /sqt/case-emails/:emailId/link    { caseRef } an unmatched email → a case
//
// sqt:email:view | reply | handle — the sqt:*:* roles (Admin, TechElite
// Admin, iMobile Front Desk, Exyon Admin); shop roles and Call Center don't.
// A reply goes out over SMTP from the same mailbox, threaded
// (In-Reply-To / References), and a copy is saved in its Sent folder.
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { sendMail } = require("../../utils/mailer");
const mailbox = require("../../utils/sqtMailbox");
const { CASE_SUMMARY, emailsCol, findCaseByRef, closeAnsweredOutside, oid } = require("../../utils/sqtCaseEmails");

// Where the intake automation files new SquareTrade requests — the hint for
// a case's original request (searched everywhere anyway).
const requestFolderName = () => process.env.SQT_REQUEST_FOLDER || "SQT New Request";

const router = express.Router();
const VIEW = requirePermission("sqt:email:view");
const REPLY = requirePermission("sqt:email:reply");
const HANDLE = requirePermission("sqt:email:handle");

const TABS = ["open", "replied", "handled", "unmatched"];
const EMAIL_RE = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;
const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES_TOTAL = 20 * 1024 * 1024;

const actor = (req) => (req.user && req.user.username) || "system";
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function caseView(c) {
  if (!c) return null;
  const cu = c.customer || {};
  return {
    _id: c._id,
    caseId: c.caseId || "",
    serviceRequestId: c.serviceRequestId || "",
    status: c.status || "",
    shopName: c.shopName || "",
    retailer: c.retailer || "",
    customerName: [cu.firstName, cu.lastName].filter(Boolean).join(" "),
    device: (c.device && c.device.description) || "",
  };
}

function emailView(e) {
  return {
    _id: e._id,
    direction: e.direction,
    messageId: e.messageId,
    sqtCaseId: e.sqtCaseId || null,
    caseId: e.caseId || null,
    caseRef: e.caseRef || null,
    subject: e.subject || "",
    from: e.from || null,
    to: e.to || [],
    cc: e.cc || [],
    replyTo: e.replyTo || [],
    date: e.date,
    snippet: e.snippet || "",
    attachmentCount: e.attachmentCount || 0,
    attachmentNames: e.attachmentNames || [],
    status: e.status || null,
    handledBy: e.handledBy || null,
    handledAt: e.handledAt || null,
    handledNote: e.handledNote || null,
    sentBy: e.sentBy || null,
    text: e.direction === "outbound" ? e.text || "" : undefined,
    savedToSent: e.direction === "outbound" ? !!e.savedToSent : undefined,
    missing: !!e.missingAt,
  };
}

const caseNote = (db, sqtCaseId, text, req) =>
  db.collection("sqt_cases").updateOne(
    { _id: sqtCaseId },
    { $push: { notes: { text, at: new Date(), addedBy: actor(req), source: "email" } }, $set: { updatedAt: new Date() } },
  );

// (aggregate, not distinct — the DB runs the Stable API in strict mode)
async function countsOf(col) {
  const [openCases, unmatched] = await Promise.all([
    col
      .aggregate([
        { $match: { direction: "inbound", status: "open", sqtCaseId: { $ne: null } } },
        { $group: { _id: "$sqtCaseId" } },
        { $count: "n" },
      ])
      .toArray(),
    col.countDocuments({ direction: "inbound", status: "open", sqtCaseId: null }),
  ]);
  return { open: (openCases[0] && openCases[0].n) || 0, unmatched };
}

const mailboxDown = (err) =>
  /IMAP|ECONN|ETIMEDOUT|ENOTFOUND|mailbox is not configured|Command failed|Connection|socket/i.test(String(err && err.message));

// ── lists ─────────────────────────────────────────────────────────────
router.get("/attention", VIEW, async (req, res) => {
  try {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : "open";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 30));
    const q = String(req.query.q || "").trim().slice(0, 100);
    const re = q ? new RegExp(escRe(q), "i") : null;

    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const counts = await countsOf(col);

    // Unmatched: single emails no case could be found for.
    if (tab === "unmatched") {
      const match = { direction: "inbound", sqtCaseId: null, status: "open" };
      if (re) match.$or = [{ subject: re }, { "from.address": re }, { "from.name": re }, { snippet: re }, { caseRef: re }];
      const [rows, total] = await Promise.all([
        col.find(match).sort({ date: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
        col.countDocuments(match),
      ]);
      return res.json({ success: true, data: { tab, rows: rows.map((e) => ({ email: emailView(e) })), total, counts } });
    }

    // One row per case: Open = any open email; Replied / Handled = nothing
    // open and the latest email ended that way.
    const pipeline = [
      { $match: { direction: "inbound", sqtCaseId: { $ne: null } } },
      { $sort: { date: -1 } },
      {
        $group: {
          _id: "$sqtCaseId",
          openCount: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
          total: { $sum: 1 },
          emailId: { $first: "$_id" },
          subject: { $first: "$subject" },
          from: { $first: "$from" },
          date: { $first: "$date" },
          snippet: { $first: "$snippet" },
          status: { $first: "$status" },
          handledBy: { $first: "$handledBy" },
          handledAt: { $first: "$handledAt" },
          waitingSince: { $min: { $cond: [{ $eq: ["$status", "open"] }, "$date", null] } },
        },
      },
      { $match: tab === "open" ? { openCount: { $gt: 0 } } : { openCount: 0, status: tab } },
      {
        $lookup: {
          from: "sqt_cases",
          let: { cid: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$cid"] } } }, { $project: CASE_SUMMARY }],
          as: "case",
        },
      },
      { $unwind: "$case" },
    ];
    if (re) {
      pipeline.push({
        $match: {
          $or: [
            { "case.caseId": re },
            { "case.serviceRequestId": re },
            { "case.customer.firstName": re },
            { "case.customer.lastName": re },
            { "case.shopName": re },
            { subject: re },
            { "from.address": re },
            { "from.name": re },
            { snippet: re },
          ],
        },
      });
    }
    pipeline.push(
      { $sort: tab === "open" ? { date: -1 } : { handledAt: -1, date: -1 } },
      { $facet: { rows: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }], total: [{ $count: "n" }] } },
    );
    const [out] = await col.aggregate(pipeline).toArray();
    const rows = (out.rows || []).map((r) => ({
      sqtCaseId: r._id,
      case: caseView(r.case),
      openCount: r.openCount,
      total: r.total,
      waitingSince: r.waitingSince || null,
      latest: {
        emailId: r.emailId,
        subject: r.subject || "",
        from: r.from || null,
        date: r.date,
        snippet: r.snippet || "",
        status: r.status,
        handledBy: r.handledBy || null,
        handledAt: r.handledAt || null,
      },
    }));
    return res.json({ success: true, data: { tab, rows, total: (out.total[0] && out.total[0].n) || 0, counts } });
  } catch (err) {
    console.error("Need Attention list error:", err);
    return res.status(500).json({ success: false, message: "Failed to load the follow-up emails" });
  }
});

router.get("/counts", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    return res.json({ success: true, data: await countsOf(await emailsCol(db)) });
  } catch (err) {
    console.error("Need Attention counts error:", err);
    return res.status(500).json({ success: false, message: "Failed to count the follow-up emails" });
  }
});

router.get("/open-counts", VIEW, async (req, res) => {
  try {
    const ids = String(req.query.ids || "").split(",").map(oid).filter(Boolean).slice(0, 200);
    if (!ids.length) return res.json({ success: true, data: {} });
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const rows = await col
      .aggregate([
        { $match: { sqtCaseId: { $in: ids }, direction: "inbound", status: "open" } },
        { $group: { _id: "$sqtCaseId", n: { $sum: 1 } } },
      ])
      .toArray();
    const data = {};
    for (const r of rows) data[String(r._id)] = r.n;
    return res.json({ success: true, data });
  } catch (err) {
    console.error("Need Attention open-counts error:", err);
    return res.status(500).json({ success: false, message: "Failed to count the follow-up emails" });
  }
});

// ── one case's thread ─────────────────────────────────────────────────
router.get("/case/:id", VIEW, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid case id" });
    const db = await connectToDatabase();
    const theCase = await db
      .collection("sqt_cases")
      .findOne({ _id: id }, { projection: { ...CASE_SUMMARY, statusHistory: 1, source: 1, createdAt: 1 } });
    if (!theCase) return res.status(404).json({ success: false, message: "Case not found" });
    const col = await emailsCol(db);
    const emails = await col.find({ sqtCaseId: id }).sort({ date: 1 }).toArray();
    const hist = Array.isArray(theCase.statusHistory) ? theCase.statusHistory : [];
    const last = hist[hist.length - 1] || null;
    // the request the case was created from (the intake automation's email)
    const src = theCase.source || {};
    const original = src.messageId
      ? { subject: src.emailSubject || "", from: src.emailFrom || "", date: src.receivedAt || theCase.createdAt || null }
      : null;
    return res.json({
      success: true,
      data: {
        case: {
          ...caseView(theCase),
          lastStatus: last ? { status: last.status, at: last.at, note: last.note || "" } : null,
        },
        original,
        emails: emails.map(emailView),
        mailboxAddress: mailbox.mailboxAddress(),
      },
    });
  } catch (err) {
    console.error("Need Attention case error:", err);
    return res.status(500).json({ success: false, message: "Failed to load the case's emails" });
  }
});

// Finds the email in the mailbox (refreshing where we last saw it) and
// returns it parsed, or answers the request itself and returns null.
async function loadFromMailbox(col, e, res) {
  let where;
  try {
    where = await mailbox.locate(e.messageId, e.mailbox || {});
  } catch (err) {
    console.error("SQT mailbox locate error:", err.message);
    res.status(503).json({ success: false, message: "The mailbox can't be reached right now — try again shortly" });
    return null;
  }
  if (!where) {
    await col.updateOne({ _id: e._id }, { $set: { missingAt: new Date() } });
    res.status(410).json({ success: false, message: "This email is no longer in the mailbox" });
    return null;
  }
  const moved = !e.mailbox || e.mailbox.folder !== where.folder || e.mailbox.uid !== where.uid;
  if (moved || e.missingAt) {
    await col.updateOne({ _id: e._id }, { $set: { mailbox: where }, $unset: { missingAt: "" } });
  }
  const parsed = await mailbox.fetchParsed(where.folder, where.uid);
  if (!parsed) {
    res.status(410).json({ success: false, message: "This email is no longer in the mailbox" });
    return null;
  }
  return parsed;
}

// What the thread shows for one email.
const contentOf = (parsed) => ({
  html: parsed.html || null,
  text: parsed.text || "",
  attachments: mailbox.listedAttachments(parsed).map(({ a, index }) => ({
    index,
    filename: a.filename || `attachment-${index + 1}`,
    contentType: a.contentType || "application/octet-stream",
    size: a.size || (a.content ? a.content.length : 0),
  })),
});

function sendAttachment(res, parsed, index) {
  const a = (parsed.attachments || [])[index];
  if (!a || !a.content) return res.status(404).json({ success: false, message: "Attachment not found" });
  const name = a.filename || `attachment-${index + 1}`;
  res.setHeader("Content-Type", a.contentType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  return res.send(a.content);
}

const contentError = (res, err, what) => {
  console.error(`Need Attention ${what} error:`, err);
  const down = mailboxDown(err);
  return res
    .status(down ? 503 : 500)
    .json({ success: false, message: down ? "The mailbox can't be reached right now — try again shortly" : "Could not open this email" });
};

router.get("/:emailId/content", VIEW, async (req, res) => {
  try {
    const id = oid(req.params.emailId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid email id" });
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const e = await col.findOne({ _id: id });
    if (!e) return res.status(404).json({ success: false, message: "Email not found" });
    const parsed = await loadFromMailbox(col, e, res);
    if (!parsed) return undefined;
    return res.json({ success: true, data: contentOf(parsed) });
  } catch (err) {
    return contentError(res, err, "content");
  }
});

router.get("/:emailId/attachments/:index", VIEW, async (req, res) => {
  try {
    const id = oid(req.params.emailId);
    const index = parseInt(req.params.index, 10);
    if (!id || !(index >= 0)) return res.status(400).json({ success: false, message: "Invalid attachment" });
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const e = await col.findOne({ _id: id });
    if (!e) return res.status(404).json({ success: false, message: "Email not found" });
    const parsed = await loadFromMailbox(col, e, res);
    if (!parsed) return undefined;
    return sendAttachment(res, parsed, index);
  } catch (err) {
    return contentError(res, err, "attachment");
  }
});

// The case's original request — no pointer record; its Message-ID is the
// case's source.messageId, kept by the intake automation.
async function loadOriginal(req, res) {
  const id = oid(req.params.id);
  if (!id) {
    res.status(400).json({ success: false, message: "Invalid case id" });
    return null;
  }
  const db = await connectToDatabase();
  const theCase = await db.collection("sqt_cases").findOne({ _id: id }, { projection: { "source.messageId": 1 } });
  const messageId = theCase && theCase.source && theCase.source.messageId;
  if (!messageId) {
    res.status(404).json({ success: false, message: "This case wasn't created from an email" });
    return null;
  }
  const where = await mailbox.locate(messageId, { folder: await mailbox.resolveFolder(requestFolderName()) });
  const parsed = where ? await mailbox.fetchParsed(where.folder, where.uid) : null;
  if (!parsed) {
    res.status(410).json({ success: false, message: "The original request is no longer in the mailbox" });
    return null;
  }
  return parsed;
}

router.get("/case/:id/original/content", VIEW, async (req, res) => {
  try {
    const parsed = await loadOriginal(req, res);
    if (!parsed) return undefined;
    return res.json({ success: true, data: contentOf(parsed) });
  } catch (err) {
    return contentError(res, err, "original content");
  }
});

router.get("/case/:id/original/attachments/:index", VIEW, async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (!(index >= 0)) return res.status(400).json({ success: false, message: "Invalid attachment" });
    const parsed = await loadOriginal(req, res);
    if (!parsed) return undefined;
    return sendAttachment(res, parsed, index);
  } catch (err) {
    return contentError(res, err, "original attachment");
  }
});

// ── reply ─────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 10 },
}).array("files", 10);

// "a@x.com, B <b@y.com>" or a JSON array → ["a@x.com", "b@y.com"]
function parseAddrs(v) {
  let list = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      list = JSON.parse(v);
    } catch (e) {
      list = [];
    }
  } else if (v) list = String(v).split(/[,;]/);
  const out = [];
  for (const raw of list) {
    const s = String((raw && raw.address) || raw || "").trim();
    const m = /<([^>]+)>/.exec(s);
    const addr = (m ? m[1] : s).trim();
    if (addr && !out.some((x) => x.toLowerCase() === addr.toLowerCase())) out.push(addr);
  }
  return out;
}

router.post("/case/:id/reply", REPLY, (req, res) => {
  upload(req, res, async (upErr) => {
    if (upErr) {
      const msg = upErr.code === "LIMIT_FILE_SIZE" ? "Each attachment must be 15 MB or smaller" : "Could not read the attachments";
      return res.status(400).json({ success: false, message: msg });
    }
    try {
      const id = oid(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: "Invalid case id" });
      const b = req.body || {};
      const to = parseAddrs(b.to);
      const cc = parseAddrs(b.cc).filter((a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()));
      if (!to.length) return res.status(400).json({ success: false, message: "Add at least one recipient" });
      const bad = [...to, ...cc].filter((a) => !EMAIL_RE.test(a));
      if (bad.length) return res.status(400).json({ success: false, message: `Not an email address: ${bad.join(", ")}` });
      if (to.length + cc.length > 20) return res.status(400).json({ success: false, message: "Too many recipients (20 at most)" });
      const body = String(b.body || "").replace(/\r\n/g, "\n").trim();
      if (!body) return res.status(400).json({ success: false, message: "Write the reply first" });
      if (body.length > 20000) return res.status(400).json({ success: false, message: "The reply is too long" });
      const files = req.files || [];
      if (files.reduce((n, f) => n + f.size, 0) > MAX_FILES_TOTAL) {
        return res.status(400).json({ success: false, message: "Attachments add up to more than 20 MB" });
      }

      const db = await connectToDatabase();
      const theCase = await db.collection("sqt_cases").findOne({ _id: id }, { projection: { caseId: 1 } });
      if (!theCase) return res.status(404).json({ success: false, message: "Case not found" });
      const col = await emailsCol(db);

      // The email being answered — the one given, else the case's latest.
      const replyToId = oid(b.replyToEmailId);
      let orig = replyToId ? await col.findOne({ _id: replyToId, sqtCaseId: id, direction: "inbound" }) : null;
      if (!orig) orig = await col.find({ sqtCaseId: id, direction: "inbound" }).sort({ date: -1 }).limit(1).next();
      if (!orig) return res.status(400).json({ success: false, message: "This case has no email to reply to" });

      const origSubject = String(orig.subject || "");
      const subject = (
        String(b.subject || "").trim() || (/^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`)
      ).slice(0, 300);

      // Quote the original below the reply, the way mail clients do.
      let quote = "";
      if (b.includeQuote !== "0" && b.includeQuote !== "false") {
        try {
          const where = await mailbox.locate(orig.messageId, orig.mailbox || {});
          const parsed = where ? await mailbox.fetchParsed(where.folder, where.uid) : null;
          if (parsed && parsed.text) {
            const f = orig.from || {};
            const who = f.name ? `${f.name} <${f.address}>` : f.address || "the sender";
            const when = new Date(orig.date).toLocaleString("en-AU", {
              timeZone: "Australia/Melbourne",
              dateStyle: "medium",
              timeStyle: "short",
            });
            const quoted = String(parsed.text).replace(/\r/g, "").trim().split("\n").map((l) => `> ${l}`).join("\n");
            quote = `\n\nOn ${when}, ${who} wrote:\n${quoted}`;
          }
        } catch (e) {
          console.error("SQT reply: could not quote the original:", e.message);
        }
      }

      const fromAddr = mailbox.mailboxAddress();
      const fromName = process.env.SQT_MAIL_FROM_NAME || "Tech Elite";
      const domain = fromAddr.split("@")[1] || "tech-elite.com.au";
      const messageId = `<${crypto.randomUUID()}@${domain}>`;
      const references = [...new Set([...(orig.references || []), orig.messageId])].slice(-20);
      const raw = await new MailComposer({
        from: { name: fromName, address: fromAddr },
        to,
        cc: cc.length ? cc : undefined,
        subject,
        text: body + quote,
        messageId,
        inReplyTo: orig.messageId,
        references: references.join(" "),
        date: new Date(),
        attachments: files.map((f) => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype })),
      })
        .compile()
        .build();

      try {
        await sendMail({ raw, envelope: { from: fromAddr, to: [...to, ...cc] } });
      } catch (err) {
        console.error("SQT reply send error:", err.message);
        return res.status(502).json({ success: false, message: `The email could not be sent: ${err.message}` });
      }

      // A copy in the mailbox's Sent folder, so the team sees it there.
      let sent = null;
      try {
        sent = await mailbox.appendToSent(raw);
      } catch (err) {
        console.error("SQT reply: could not save to Sent:", err.message);
      }

      const now = new Date();
      const r = await col.insertOne({
        messageId,
        direction: "outbound",
        sqtCaseId: id,
        caseId: theCase.caseId,
        mailbox: sent,
        subject,
        from: { name: fromName, address: fromAddr },
        to: to.map((address) => ({ name: "", address })),
        cc: cc.map((address) => ({ name: "", address })),
        replyTo: [],
        date: now,
        inReplyTo: orig.messageId,
        references,
        snippet: body.replace(/\s+/g, " ").slice(0, 240),
        text: body,
        attachmentCount: files.length,
        attachmentNames: files.map((f) => f.originalname),
        sentBy: actor(req),
        inReplyToEmailId: orig._id,
        savedToSent: !!sent,
        createdAt: now,
        updatedAt: now,
      });
      await col.updateMany(
        { sqtCaseId: id, direction: "inbound", status: "open" },
        { $set: { status: "replied", handledBy: actor(req), handledAt: now, replyEmailId: r.insertedId, updatedAt: now } },
      );
      await caseNote(db, id, `Replied to the follow-up email "${subject}"`, req);
      return res.json({ success: true, data: { emailId: r.insertedId, savedToSent: !!sent } });
    } catch (err) {
      console.error("SQT reply error:", err);
      return res.status(500).json({ success: false, message: "Could not send the reply" });
    }
  });
});

// ── handled / reopen / link ───────────────────────────────────────────
router.post("/case/:id/handled", HANDLE, async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "Invalid case id" });
    const note = String((req.body && req.body.note) || "").trim().slice(0, 1000);
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const now = new Date();
    const r = await col.updateMany(
      { sqtCaseId: id, direction: "inbound", status: "open" },
      { $set: { status: "handled", handledBy: actor(req), handledAt: now, handledNote: note || null, updatedAt: now } },
    );
    if (!r.modifiedCount) return res.status(400).json({ success: false, message: "Nothing is waiting on this case" });
    await caseNote(db, id, `Follow-up email marked handled${note ? ` — ${note}` : ""}`, req);
    return res.json({ success: true, data: { handled: r.modifiedCount } });
  } catch (err) {
    console.error("Need Attention handled error:", err);
    return res.status(500).json({ success: false, message: "Could not mark it handled" });
  }
});

router.post("/:emailId/handled", HANDLE, async (req, res) => {
  try {
    const id = oid(req.params.emailId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid email id" });
    const note = String((req.body && req.body.note) || "").trim().slice(0, 1000);
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const now = new Date();
    const e = await col.findOneAndUpdate(
      { _id: id, direction: "inbound", status: "open" },
      { $set: { status: "handled", handledBy: actor(req), handledAt: now, handledNote: note || null, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!e) return res.status(400).json({ success: false, message: "That email isn't waiting" });
    if (e.sqtCaseId) await caseNote(db, e.sqtCaseId, `Follow-up email marked handled${note ? ` — ${note}` : ""}`, req);
    return res.json({ success: true, data: emailView(e) });
  } catch (err) {
    console.error("Need Attention email handled error:", err);
    return res.status(500).json({ success: false, message: "Could not mark it handled" });
  }
});

router.post("/:emailId/reopen", HANDLE, async (req, res) => {
  try {
    const id = oid(req.params.emailId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid email id" });
    const db = await connectToDatabase();
    const col = await emailsCol(db);
    const e = await col.findOneAndUpdate(
      { _id: id, direction: "inbound", status: { $ne: "open" } },
      {
        $set: { status: "open", updatedAt: new Date() },
        $unset: { handledBy: "", handledAt: "", handledNote: "", replyEmailId: "" },
      },
      { returnDocument: "after" },
    );
    if (!e) return res.status(400).json({ success: false, message: "That email is already waiting" });
    return res.json({ success: true, data: emailView(e) });
  } catch (err) {
    console.error("Need Attention reopen error:", err);
    return res.status(500).json({ success: false, message: "Could not reopen it" });
  }
});

router.post("/:emailId/link", HANDLE, async (req, res) => {
  try {
    const id = oid(req.params.emailId);
    const ref = String((req.body && req.body.caseRef) || "").trim();
    if (!id || !ref) return res.status(400).json({ success: false, message: "Enter a Case ID or SR number" });
    const db = await connectToDatabase();
    const theCase = await findCaseByRef(db, ref);
    if (!theCase) return res.status(404).json({ success: false, message: `No case with Case ID or SR "${ref}"` });
    const col = await emailsCol(db);
    const e = await col.findOneAndUpdate(
      { _id: id, direction: "inbound" },
      { $set: { sqtCaseId: theCase._id, caseId: theCase.caseId, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!e) return res.status(404).json({ success: false, message: "Email not found" });
    await closeAnsweredOutside(db, theCase._id);
    return res.json({ success: true, data: emailView(e) });
  } catch (err) {
    console.error("Need Attention link error:", err);
    return res.status(500).json({ success: false, message: "Could not link the email" });
  }
});

module.exports = router;
