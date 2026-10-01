// iMobile Website → Campaign: email campaigns through Zoho Campaigns, the
// dashboard side (user ask 2026-10-01). Drafts come mostly from another
// agent (routes/campaignAgentRoutes) or are made here; a person previews,
// test-sends and sends them here, then reads the summary. Logic in
// utils/campaignStore; Zoho calls in utils/zohoCampaigns.
//
//   GET    /website/campaigns?tab=review|sent     our campaigns (no HTML)
//   GET    /website/campaigns/options             Zoho lists, topics, senders
//   GET    /website/campaigns/zoho-history        campaigns in Zoho (incl. ones sent from Zoho)
//   GET    /website/campaigns/zoho/:key/report    report for a Zoho-history row
//   GET    /website/campaigns/zoho/:key/recipients?action=&page=
//   POST   /website/campaigns                     new draft (multipart: zip | html file
//                                                  + images[], or JSON { html })
//   GET    /website/campaigns/:id                 one campaign, with its HTML
//   PUT    /website/campaigns/:id                 edit a draft (new content optional)
//   DELETE /website/campaigns/:id                 delete a draft
//   POST   /website/campaigns/:id/test            { listKey } — test to a ≤10-contact list
//   POST   /website/campaigns/:id/send            { listKeys, confirmTotal } — the real send
//   GET    /website/campaigns/:id/report[?refresh=1]
//   GET    /website/campaigns/:id/recipients?action=&page=
//
// web:campaign:view reads, web:campaign:edit drafts / test-sends,
// web:campaign:send sends — admin and iMobile Admin (web:*:*).

const express = require("express");
const multer = require("multer");
const router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const zc = require("../../utils/zohoCampaigns");
const store = require("../../utils/campaignStore");
const { LIMITS } = require("../../utils/campaignContent");

const VIEW = requirePermission("web:campaign:view");
const EDIT = requirePermission("web:campaign:edit");
const SEND = requirePermission("web:campaign:send");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.zipBytes, files: LIMITS.images + 2 },
}).fields([{ name: "zip", maxCount: 1 }, { name: "html", maxCount: 1 }, { name: "images", maxCount: LIMITS.images }]);

const who = (req) => (req.user && req.user.username) || null;

function fail(res, e, what) {
  const status = e.status || 500;
  if (status >= 500) console.error(`Campaign ${what} error:`, e.message);
  return res.status(status).json({ success: false, message: status >= 500 && !e.status ? `Could not ${what}` : e.message });
}

// multipart or JSON → { zip?, html?, text?, images? } (null = no new content)
function contentFrom(req) {
  const f = req.files || {};
  const one = (n) => (f[n] && f[n][0]) || null;
  const zip = one("zip");
  const htmlFile = one("html");
  const images = (f.images || []).map((x) => ({ name: x.originalname, buffer: x.buffer }));
  const body = req.body || {};
  if (zip) return { zip: zip.buffer, text: body.text, images };
  if (htmlFile) return { html: htmlFile.buffer.toString("utf8"), text: body.text, images };
  if (body.html) return { html: String(body.html), text: body.text, images };
  return null;
}

// small caches — the lists change rarely and Zoho's rate limit is shared
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const q = req.query.tab === "sent" ? { status: "sent" } : req.query.tab === "review" ? { status: { $in: ["draft", "failed", "sending"] } } : {};
    const rows = await db.collection(store.COLL).find(q, { projection: { html: 0, text: 0 } }).sort({ createdAt: -1 }).limit(300).toArray();
    const counts = {
      review: await db.collection(store.COLL).countDocuments({ status: { $in: ["draft", "failed", "sending"] } }),
      sent: await db.collection(store.COLL).countDocuments({ status: "sent" }),
    };
    return res.json({ success: true, rows, counts });
  } catch (e) {
    return fail(res, e, "load the campaigns");
  }
});

router.get("/options", VIEW, async (req, res) => {
  try {
    const refresh = req.query.refresh === "1";
    if (refresh) cache.delete("lists");
    const [lists, topics] = await Promise.all([
      cached("lists", 2 * 60 * 1000, () => zc.mailingLists()),
      cached("topics", 30 * 60 * 1000, () => zc.topics()),
    ]);
    const db = await connectToDatabase();
    // (no `distinct`: the connection uses Mongo's strict API v1)
    const used = await db.collection(store.COLL).aggregate([{ $group: { _id: "$fromEmail" } }]).toArray();
    const senders = [...new Set([store.DEFAULT_FROM.email, ...used.map((u) => u._id).filter(Boolean)])];
    return res.json({
      success: true,
      lists: lists.sort((a, b) => b.contacts - a.contacts),
      topics,
      senders,
      defaultFrom: store.DEFAULT_FROM,
      testListMax: store.TEST_LIST_MAX,
    });
  } catch (e) {
    return fail(res, e, "read the Zoho lists");
  }
});

router.get("/zoho-history", VIEW, async (req, res) => {
  try {
    const rows = await cached("history", 2 * 60 * 1000, () => zc.recentCampaigns(60));
    const db = await connectToDatabase();
    const ours = new Map((await db.collection(store.COLL).find({ "send.zohoKey": { $ne: null } }, { projection: { name: 1, "send.zohoKey": 1 } }).toArray()).map((d) => [d.send && d.send.zohoKey, String(d._id)]));
    return res.json({ success: true, rows: rows.map((r) => ({ ...r, campaignId: ours.get(r.key) || null })) });
  } catch (e) {
    return fail(res, e, "read Zoho's campaigns");
  }
});

router.get("/zoho/:key/report", VIEW, async (req, res) => {
  try {
    const key = String(req.params.key).replace(/[^\w]/g, "");
    const [report, details] = await Promise.all([zc.campaignReport(key), zc.campaignDetails(key)]);
    return res.json({ success: true, report: { at: new Date(), data: report }, details });
  } catch (e) {
    return fail(res, e, "read the report");
  }
});

router.get("/zoho/:key/recipients", VIEW, async (req, res) => {
  try {
    const key = String(req.params.key).replace(/[^\w]/g, "");
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await zc.recipients(key, String(req.query.action || "openedcontacts"), (page - 1) * 50 + 1, 50);
    return res.json({ success: true, rows, page });
  } catch (e) {
    return fail(res, e, "read the recipients");
  }
});

router.post("/", EDIT, upload, async (req, res) => {
  try {
    const content = contentFrom(req);
    if (!content) return res.status(400).json({ success: false, message: "Add the email content — a zip from the design tool, or an HTML file" });
    const db = await connectToDatabase();
    const doc = await store.createDraft(db, req.body || {}, content, { source: "dashboard", by: who(req) });
    return res.json({ success: true, campaign: store.summary(doc) });
  } catch (e) {
    return fail(res, e, "create the campaign");
  }
});

router.get("/:id", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    return res.json({ success: true, campaign: await store.getCampaign(db, req.params.id) });
  } catch (e) {
    return fail(res, e, "load the campaign");
  }
});

router.put("/:id", EDIT, upload, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doc = await store.updateDraft(db, req.params.id, req.body || {}, contentFrom(req), who(req));
    return res.json({ success: true, campaign: doc });
  } catch (e) {
    return fail(res, e, "save the campaign");
  }
});

router.delete("/:id", EDIT, async (req, res) => {
  try {
    const db = await connectToDatabase();
    await store.deleteDraft(db, req.params.id);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "delete the campaign");
  }
});

router.post("/:id/test", EDIT, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const entry = await store.sendTest(db, req.params.id, String((req.body && req.body.listKey) || ""), who(req));
    return res.json({ success: true, test: entry });
  } catch (e) {
    return fail(res, e, "send the test");
  }
});

router.post("/:id/send", SEND, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const b = req.body || {};
    const doc = await store.sendCampaign(db, req.params.id, Array.isArray(b.listKeys) ? b.listKeys.map(String) : [], b.confirmTotal, who(req));
    cache.delete("history");
    return res.json({ success: true, campaign: store.summary(doc) });
  } catch (e) {
    return fail(res, e, "send the campaign");
  }
});

router.get("/:id/report", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    return res.json({ success: true, report: await store.report(db, req.params.id, req.query.refresh === "1") });
  } catch (e) {
    return fail(res, e, "read the report");
  }
});

router.get("/:id/recipients", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doc = await store.getCampaign(db, req.params.id);
    if (!doc.send || !doc.send.zohoKey || doc.status !== "sent") return res.status(409).json({ success: false, message: "This campaign hasn't been sent yet" });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await zc.recipients(doc.send.zohoKey, String(req.query.action || "openedcontacts"), (page - 1) * 50 + 1, 50);
    return res.json({ success: true, rows, page });
  } catch (e) {
    return fail(res, e, "read the recipients");
  }
});

module.exports = router;
