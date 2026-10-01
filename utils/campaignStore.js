// Email campaigns (iMobile Website → Campaign; user ask 2026-10-01). Most are
// drafted by another agent through POST /integration/campaigns; every one is
// reviewed, previewed and sent by a person on the dashboard — the agent can
// never send. Mongo imb_web_campaigns:
//
//   { name, subject, fromName, fromEmail, topicId, notes,
//     html, text, contentUrl, contentRev, assets[{name,url,size}], warnings[],
//     source: "agent" | "dashboard", agentName, createdBy, createdAt,
//     updatedBy, updatedAt,
//     status: "draft" | "sending" | "sent" | "failed",
//     tests[{ at, by, listKey, listName, zohoKey, error }],
//     send: { lists[{key,name,contacts}], total, at, by, zohoKey, error },
//     report: { at, data } }
//
// The Zoho campaign is created only when a test or the real send happens
// (Zoho has no API to edit a campaign's content, so drafts stay ours until
// then). Sending is one-way: draft/failed → sending → sent, claimed
// atomically so a double click can't send twice.

const { ObjectId } = require("mongodb");
const zc = require("./zohoCampaigns");
const { prepareContent } = require("./campaignContent");

const COLL = "imb_web_campaigns";
const DEFAULT_FROM = { name: "iMobile", email: "sales@imobilestore.com.au" };
const TEST_LIST_MAX = 10; // a test may only go to a list this small
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

function cleanFields(f, { partial } = {}) {
  const out = {};
  if (!partial || f.name !== undefined) out.name = text(f.name, 120);
  if (!partial || f.subject !== undefined) out.subject = text(f.subject, 200);
  if (!partial || f.fromName !== undefined) out.fromName = text(f.fromName, 80) || DEFAULT_FROM.name;
  if (!partial || f.fromEmail !== undefined) out.fromEmail = text(f.fromEmail, 120).toLowerCase() || DEFAULT_FROM.email;
  if (!partial || f.notes !== undefined) out.notes = text(f.notes, 2000);
  if (f.topicId !== undefined) out.topicId = text(f.topicId, 40) || null;
  if (out.name !== undefined && !out.name) throw bad("Give the campaign a name");
  if (out.subject !== undefined && !out.subject) throw bad("Add a subject line");
  if (out.fromEmail !== undefined && !EMAIL.test(out.fromEmail)) throw bad("The sender address isn't a valid email");
  return out;
}

async function createDraft(db, fields, content, { source, agentName, by }) {
  const f = cleanFields(fields);
  const _id = new ObjectId();
  const prepared = await prepareContent(content, { campaignId: String(_id), rev: 1 });
  const now = new Date();
  const doc = {
    _id, ...f, topicId: f.topicId || null,
    html: prepared.html, text: prepared.text, contentUrl: prepared.contentUrl, contentRev: 1,
    assets: prepared.assets, warnings: prepared.warnings,
    source, agentName: agentName ? text(agentName, 80) : null,
    createdBy: by || null, createdAt: now, updatedBy: by || null, updatedAt: now,
    status: "draft", tests: [], send: null, report: null,
  };
  await db.collection(COLL).insertOne(doc);
  return doc;
}

async function getCampaign(db, id) {
  if (!ObjectId.isValid(id)) throw bad("Campaign not found", 404);
  const doc = await db.collection(COLL).findOne({ _id: new ObjectId(id) });
  if (!doc) throw bad("Campaign not found", 404);
  return doc;
}

const editable = (doc) => doc.status === "draft" || doc.status === "failed";

async function updateDraft(db, id, fields, content, by) {
  const doc = await getCampaign(db, id);
  if (!editable(doc)) throw bad("A sent campaign can't be changed", 409);
  const set = { ...cleanFields(fields, { partial: true }), updatedBy: by || null, updatedAt: new Date() };
  if (content) {
    const rev = (doc.contentRev || 1) + 1;
    const prepared = await prepareContent(content, { campaignId: String(doc._id), rev });
    Object.assign(set, { html: prepared.html, text: prepared.text || doc.text || "", contentUrl: prepared.contentUrl, contentRev: rev, assets: prepared.assets, warnings: prepared.warnings });
  }
  await db.collection(COLL).updateOne({ _id: doc._id, status: { $in: ["draft", "failed"] } }, { $set: set });
  return getCampaign(db, id);
}

async function deleteDraft(db, id) {
  const doc = await getCampaign(db, id);
  if (!editable(doc)) throw bad("A sent campaign can't be deleted", 409);
  await db.collection(COLL).deleteOne({ _id: doc._id, status: { $in: ["draft", "failed"] } });
  // a failed send may have left a Zoho draft behind
  if (doc.send && doc.send.zohoKey) await zc.deleteCampaign(doc.send.zohoKey).catch(() => {});
}

async function resolveTopic(doc) {
  if (doc.topicId) return doc.topicId;
  const t = await zc.topics();
  return t.length ? t[0].id : null; // topic management: the account's topic ("Marketing")
}

async function pickLists(keys) {
  const all = await zc.mailingLists();
  const lists = (keys || []).map((k) => all.find((l) => l.key === String(k))).filter(Boolean);
  if (!lists.length || lists.length !== (keys || []).length) throw bad("Choose the mailing list(s) again — one wasn't found in Zoho");
  return lists;
}

// A test: a separate Zoho campaign to one SMALL list (≤ 10 contacts).
async function sendTest(db, id, listKey, by) {
  const doc = await getCampaign(db, id);
  if (!editable(doc)) throw bad("This campaign has already been sent", 409);
  const [list] = await pickLists([listKey]);
  if (list.contacts > TEST_LIST_MAX) throw bad(`A test can only go to a list of ${TEST_LIST_MAX} contacts or fewer — "${list.name}" has ${list.contacts}`);
  const entry = { at: new Date(), by: by || null, listKey: list.key, listName: list.name, contacts: list.contacts, zohoKey: null, error: null };
  try {
    entry.zohoKey = await zc.createCampaign({
      name: `${doc.name} TEST ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      subject: `[TEST] ${doc.subject}`, fromEmail: doc.fromEmail, fromName: doc.fromName,
      contentUrl: doc.contentUrl, listKeys: [list.key], topicId: await resolveTopic(doc),
    });
    await zc.sendCampaign(entry.zohoKey);
  } catch (e) {
    entry.error = e.message;
  }
  await db.collection(COLL).updateOne({ _id: doc._id }, { $push: { tests: { $each: [entry], $slice: -20 } } });
  if (entry.error) throw bad(entry.error, 502);
  return entry;
}

// The real send. `confirmTotal` must equal the chosen lists' contact count —
// the reviewer typed it — so nobody mails a big list by accident.
async function sendCampaign(db, id, listKeys, confirmTotal, by) {
  const doc = await getCampaign(db, id);
  if (!editable(doc)) throw bad("This campaign has already been sent", 409);
  const lists = await pickLists(listKeys);
  const total = lists.reduce((t, l) => t + l.contacts, 0);
  if (Number(confirmTotal) !== total) throw bad(`Type the number of contacts (${total.toLocaleString()}) to confirm the send`);

  // claim it: only one send, ever
  const claimed = await db.collection(COLL).findOneAndUpdate(
    { _id: doc._id, status: { $in: ["draft", "failed"] } },
    { $set: { status: "sending", updatedAt: new Date(), updatedBy: by || null } },
    { returnDocument: "after" },
  );
  if (!(claimed && (claimed.value || claimed._id))) throw bad("Someone is already sending this campaign", 409);

  const prev = doc.send || {};
  const sameLists = prev.zohoKey && JSON.stringify((prev.lists || []).map((l) => l.key).sort()) === JSON.stringify(lists.map((l) => l.key).sort());
  const send = { lists, total, at: new Date(), by: by || null, zohoKey: sameLists ? prev.zohoKey : null, error: null };
  try {
    if (prev.zohoKey && !sameLists) await zc.deleteCampaign(prev.zohoKey).catch(() => {});
    if (!send.zohoKey) {
      send.zohoKey = await zc.createCampaign({
        name: doc.name, subject: doc.subject, fromEmail: doc.fromEmail, fromName: doc.fromName,
        contentUrl: doc.contentUrl, listKeys: lists.map((l) => l.key), topicId: await resolveTopic(doc),
      });
    }
    await zc.sendCampaign(send.zohoKey);
    await db.collection(COLL).updateOne({ _id: doc._id }, { $set: { status: "sent", send, updatedAt: new Date() } });
  } catch (e) {
    send.error = e.message;
    await db.collection(COLL).updateOne({ _id: doc._id }, { $set: { status: "failed", send, updatedAt: new Date() } });
    throw bad(e.message, 502);
  }
  return getCampaign(db, id);
}

// Summary report, kept on the doc; re-read from Zoho when older than 5 minutes
// (or on refresh, at most every 30 seconds).
async function report(db, id, refresh) {
  const doc = await getCampaign(db, id);
  if (!doc.send || !doc.send.zohoKey || doc.status !== "sent") throw bad("This campaign hasn't been sent yet", 409);
  const age = doc.report ? Date.now() - new Date(doc.report.at).getTime() : Infinity;
  if (age > 5 * 60 * 1000 || (refresh && age > 30 * 1000)) {
    const data = await zc.campaignReport(doc.send.zohoKey);
    doc.report = { at: new Date(), data };
    await db.collection(COLL).updateOne({ _id: doc._id }, { $set: { report: doc.report } });
  }
  return doc.report;
}

// What lists and previews leave out (the HTML can be large).
const summary = (d) => {
  const { html, text: plain, ...rest } = d; // eslint-disable-line no-unused-vars
  return rest;
};

module.exports = {
  COLL, DEFAULT_FROM, TEST_LIST_MAX,
  createDraft, getCampaign, updateDraft, deleteDraft, sendTest, sendCampaign, report, summary,
};
