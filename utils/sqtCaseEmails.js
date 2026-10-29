// SQT case emails (user ask 2026-10-28) — SquareTrade follow-up emails and
// our replies, one POINTER record per email in `sqt_case_emails`; the email
// itself stays in the Hostinger mailbox and is read on demand
// (utils/sqtMailbox). Shared by the automation's ingest endpoint
// (routes/sqtEmailIngestRoutes) and SQT → Need Attention
// (routes/sqtRoutes/caseEmails).
//
// Record:
//   { messageId (unique), direction: "inbound" | "outbound",
//     sqtCaseId, caseId,                 // null until matched / linked
//     mailbox: { folder, uid },          // where it was last found
//     subject, from, to, cc, replyTo, date, inReplyTo, references,
//     snippet, attachmentCount,
//     inbound:  status "open" | "replied" | "handled", handledBy, handledAt,
//               handledNote, replyEmailId  (handledBy "outside the dashboard"
//               = answered from someone's own mailbox — closeAnsweredOutside)
//     outbound: sentBy, text (our reply), inReplyToEmailId, savedToSent
//     ingestedBy, createdAt, updatedAt }
const { ObjectId } = require("mongodb");
const mailbox = require("./sqtMailbox");

const COLLECTION = "sqt_case_emails";
let indexed = null;

async function emailsCol(db) {
  const col = db.collection(COLLECTION);
  if (!indexed) {
    indexed = Promise.all([
      col.createIndex({ messageId: 1 }, { unique: true }),
      col.createIndex({ sqtCaseId: 1, date: -1 }),
      col.createIndex({ direction: 1, status: 1, date: -1 }),
    ]).catch((e) => {
      indexed = null;
      throw e;
    });
  }
  await indexed;
  return col;
}

const CASE_SUMMARY = {
  caseId: 1,
  serviceRequestId: 1,
  status: 1,
  shopName: 1,
  retailer: 1,
  "customer.firstName": 1,
  "customer.lastName": 1,
  "device.description": 1,
};

// A Case ID or Service Request number — SquareTrade's subjects say
// "Case ID 041513374134", which is our serviceRequestId.
async function findCaseByRef(db, ref) {
  const r = String(ref || "").trim();
  if (!r) return null;
  return db
    .collection("sqt_cases")
    .findOne({ $or: [{ serviceRequestId: r }, { caseId: r }] }, { projection: { caseId: 1 } });
}

// Which case an email belongs to: the automation's caseRef, then the thread
// (the intake email kept on the case as source.messageId, or an email we
// already hold), then numbers in the subject.
async function matchCase(db, { caseRef, subject, inReplyTo, references }) {
  if (caseRef) {
    const c = await findCaseByRef(db, caseRef);
    if (c) return c;
  }
  const ids = [...new Set([inReplyTo, ...(references || [])].filter(Boolean))];
  if (ids.length) {
    const c = await db
      .collection("sqt_cases")
      .findOne({ "source.messageId": { $in: ids } }, { projection: { caseId: 1 } });
    if (c) return c;
    const e = await db
      .collection(COLLECTION)
      .findOne({ messageId: { $in: ids }, sqtCaseId: { $ne: null } }, { projection: { sqtCaseId: 1, caseId: 1 } });
    if (e) return { _id: e.sqtCaseId, caseId: e.caseId };
  }
  const nums = [...new Set(String(subject || "").match(/\b\d{6,14}\b/g) || [])];
  for (const n of nums) {
    const c = await findCaseByRef(db, n);
    if (c) return c;
  }
  return null;
}

// Someone answered SquareTrade from their own mailbox (e.g. adrian@, whose
// Sent folder isn't this mailbox), so the dashboard never saw the reply.
// The tell: a later SquareTrade email that replies to a message we don't
// hold (In-Reply-To is none of the case's emails nor its intake email) and
// carries "[EXTERNAL]" — the tag SquareTrade's mail puts on messages from
// us. Every open email older than that one was answered, so it closes as
// "replied outside the dashboard". Runs after each new email on a case, so
// emails picked up out of order settle too.
const OUTSIDE = "outside the dashboard";

async function closeAnsweredOutside(db, sqtCaseId) {
  const col = await emailsCol(db);
  const mails = await col
    .find({ sqtCaseId }, { projection: { messageId: 1, direction: 1, subject: 1, inReplyTo: 1, date: 1 } })
    .sort({ date: -1 })
    .toArray();
  const theCase = await db.collection("sqt_cases").findOne({ _id: sqtCaseId }, { projection: { "source.messageId": 1 } });
  const known = new Set(mails.map((m) => String(m.messageId).toLowerCase()));
  const intakeId = theCase && theCase.source && theCase.source.messageId;
  if (intakeId) known.add(mailbox.normId(intakeId).toLowerCase());
  const cue = mails.find(
    (m) =>
      m.direction === "inbound" &&
      m.inReplyTo &&
      !known.has(String(m.inReplyTo).toLowerCase()) &&
      /\[EXTERNAL\]/i.test(m.subject || ""),
  );
  if (!cue) return 0;
  const r = await col.updateMany(
    { sqtCaseId, direction: "inbound", status: "open", date: { $lt: cue.date } },
    {
      $set: {
        status: "replied",
        handledBy: OUTSIDE,
        handledAt: cue.date,
        handledNote: "SquareTrade's next email replies to it",
        updatedAt: new Date(),
      },
    },
  );
  return r.modifiedCount;
}

// Record one inbound email the automation picked up.
//   -> { result: "created" | "duplicate" | "not-found", doc? }
async function ingestEmail(db, { messageId, caseRef, folder, ingestedBy }) {
  const col = await emailsCol(db);
  const id = mailbox.normId(messageId);
  const existing = await col.findOne({ messageId: id });
  if (existing) return { result: "duplicate", doc: existing };

  const folderPath = folder ? await mailbox.resolveFolder(folder) : null;
  const where = await mailbox.locate(id, { folder: folderPath });
  if (!where) return { result: "not-found" };
  const parsed = await mailbox.fetchParsed(where.folder, where.uid);
  if (!parsed) return { result: "not-found" };
  const s = mailbox.summarize(parsed);
  const theCase = await matchCase(db, { caseRef, subject: s.subject, inReplyTo: s.inReplyTo, references: s.references });

  const now = new Date();
  const doc = {
    messageId: id,
    direction: "inbound",
    sqtCaseId: theCase ? theCase._id : null,
    caseId: theCase ? theCase.caseId : null,
    mailbox: where,
    subject: s.subject,
    from: s.from,
    to: s.to,
    cc: s.cc,
    replyTo: s.replyTo,
    date: s.date || now,
    inReplyTo: s.inReplyTo,
    references: s.references,
    snippet: s.snippet,
    attachmentCount: s.attachmentCount,
    status: "open",
    caseRef: caseRef ? String(caseRef).slice(0, 40) : null,
    ingestedBy: String(ingestedBy || "automation").slice(0, 60),
    createdAt: now,
    updatedAt: now,
  };
  try {
    const r = await col.insertOne(doc);
    if (doc.sqtCaseId) await closeAnsweredOutside(db, doc.sqtCaseId);
    return { result: "created", doc: await col.findOne({ _id: r.insertedId }) };
  } catch (e) {
    // Two deliveries of the same email at once — the other one won.
    if (e && e.code === 11000) return { result: "duplicate", doc: await col.findOne({ messageId: id }) };
    throw e;
  }
}

const oid = (v) => {
  try {
    return new ObjectId(String(v));
  } catch (e) {
    return null;
  }
};

module.exports = {
  COLLECTION,
  CASE_SUMMARY,
  emailsCol,
  findCaseByRef,
  matchCase,
  ingestEmail,
  closeAnsweredOutside,
  oid,
};
