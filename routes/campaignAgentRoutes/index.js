// Campaign drafts from another agent (user ask 2026-10-01: "campaigns should
// be created by another agent most of the time … every campaign needs to be
// reviewed before sending"). The agent can CREATE a draft and READ its status —
// nothing here can send; a person previews and sends it on the dashboard
// (iMobile Website → Campaign, routes/websiteRoutes/campaigns.js).
//
//   POST /integration/campaigns        new draft
//   GET  /integration/campaigns/:id    its status (+ the summary once sent)
//
// Auth: the shared secret CAMPAIGN_AGENT_KEY, sent as `x-campaign-key` or
// `Authorization: Bearer <key>`; with it unset the endpoint refuses.
//
// POST body — multipart/form-data:
//   name, subject (required) · fromName, fromEmail, notes, agentName (optional)
//   zip   — a design-tool zip: an .html file + images/ (+ an optional .txt)
//   html  — or a single .html file, with `images` files beside it
// or JSON (up to 20 MB):
//   { name, subject, fromName?, fromEmail?, notes?, agentName?,
//     html? , zipBase64?, text?, images?: [{ filename, contentBase64 }] }
// Images referenced by relative path (images/x.png) are hosted and linked;
// absolute https:// image URLs are left as they are. Unsubscribe placeholders
// such as {{ unsubscribe }} become Zoho's tag.

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const store = require("../../utils/campaignStore");
const { LIMITS } = require("../../utils/campaignContent");

router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
}));

function agentAuth(req, res, next) {
  const secret = process.env.CAMPAIGN_AGENT_KEY;
  if (!secret) return res.status(503).json({ success: false, message: "Campaign agent access is not configured (set CAMPAIGN_AGENT_KEY)" });
  const auth = String(req.get("authorization") || "");
  const given = String(req.get("x-campaign-key") || (auth.startsWith("Bearer ") ? auth.slice(7) : "")).trim();
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: "Invalid campaign key" });
  }
  return next();
}
router.use(agentAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.zipBytes, files: LIMITS.images + 2 },
}).fields([{ name: "zip", maxCount: 1 }, { name: "html", maxCount: 1 }, { name: "images", maxCount: LIMITS.images }]);

const b64 = (s, what) => {
  try {
    return Buffer.from(String(s).replace(/^data:[^,]+,/, ""), "base64");
  } catch (e) {
    throw Object.assign(new Error(`${what} isn't valid base64`), { status: 400 });
  }
};

function contentFrom(req) {
  const f = req.files || {};
  const body = req.body || {};
  const one = (n) => (f[n] && f[n][0]) || null;
  const images = (f.images || []).map((x) => ({ name: x.originalname, buffer: x.buffer }));
  for (const im of Array.isArray(body.images) ? body.images : []) {
    if (im && im.filename && im.contentBase64) images.push({ name: String(im.filename), buffer: b64(im.contentBase64, im.filename) });
  }
  if (one("zip")) return { zip: one("zip").buffer, text: body.text, images };
  if (body.zipBase64) return { zip: b64(body.zipBase64, "zipBase64"), text: body.text, images };
  if (one("html")) return { html: one("html").buffer.toString("utf8"), text: body.text, images };
  if (body.html) return { html: String(body.html), text: body.text, images };
  return null;
}

router.post("/", upload, async (req, res) => {
  try {
    const content = contentFrom(req);
    if (!content) return res.status(400).json({ success: false, message: "Send the email content: a `zip`, an `html` file, `html` text or `zipBase64`" });
    const db = await connectToDatabase();
    const b = req.body || {};
    const doc = await store.createDraft(db, b, content, { source: "agent", agentName: b.agentName, by: b.agentName ? `agent: ${String(b.agentName).slice(0, 60)}` : "agent" });
    return res.status(201).json({
      success: true,
      id: String(doc._id),
      status: doc.status,
      warnings: doc.warnings,
      contentUrl: doc.contentUrl,
      review: "A person must preview and send it on the dashboard: iMobile Website → Campaign",
      reviewPath: `/website/campaigns?id=${doc._id}`,
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("Campaign agent create error:", e.message);
    return res.status(status).json({ success: false, message: status >= 500 ? "Could not create the campaign" : e.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    const d = await store.getCampaign(db, req.params.id);
    const r = d.report && d.report.data;
    return res.json({
      success: true,
      id: String(d._id),
      name: d.name,
      subject: d.subject,
      status: d.status, // draft · sending · sent · failed
      createdAt: d.createdAt,
      warnings: d.warnings,
      sentAt: d.status === "sent" && d.send ? d.send.at : null,
      lists: d.send ? (d.send.lists || []).map((l) => l.name) : [],
      summary: r ? { sent: r.sent, delivered: r.delivered, opens: r.opens, openPct: r.openPct, uniqueClicks: r.uniqueClicks, clickPct: r.clickPct, bounces: r.bounces, unsubscribes: r.unsubscribes, at: d.report.at } : null,
    });
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ success: false, message: status >= 500 ? "Could not read the campaign" : e.message });
  }
});

module.exports = router;
