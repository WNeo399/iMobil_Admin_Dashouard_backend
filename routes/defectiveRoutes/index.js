// Defective devices for sale (2026-10-09). Old or faulty units not worth
// refurbishing are sold as they are — every unit is a one-off listing with
// its own description, photos and/or video. The listing text is drafted by
// Claude from the item's details, the findings (working / faulty), the staff note and the
// photos, then edited by staff. Admin-only for now (defect:listing:*, held by
// the admin wildcard alone — user decision). The devices are NOT the
// Refurbished Device register (user: those are a different stock), and
// there is no Blackbelt lookup (most of these units have no report).
// Mounted at /defective under the authenticated chain in app.js.
//
//   GET    /defective/meta                         fault states, conditions, limits, what's configured
//   GET    /defective/listings?status&q&page&pageSize   (&chat=1: the ones with a chat, last worked on first)
//   POST   /defective/listings                     create (Draft, DL-10001+)
//   GET    /defective/listings/:id
//   PUT    /defective/listings/:id                 edit (not once Sold)
//   DELETE /defective/listings/:id                 a never-published draft → deleted (kept, marked)
//   POST   /defective/listings/:id/photos          multipart "photos" (up to 12)
//   POST   /defective/listings/:id/video           { name, contentType, size } → a signed PUT for the browser
//   POST   /defective/listings/:id/video/:mediaId/finish  { duration, width, height } → the video on the listing
//   POST   /defective/listings/:id/media/:mediaId/poster  multipart "poster" (a video's cover frame)
//   PUT    /defective/listings/:id/media/order     { ids }
//   DELETE /defective/listings/:id/media/:mediaId
//   POST   /defective/listings/:id/draft           { instructions? } → the AI draft
//   POST   /defective/listings/:id/status          { to, sold: { price, channel, note } }
//   POST   /defective/assist                       { listingId?, message, mediaIds? } → the chat assistant (New Listing page)

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const axios = require("axios");
const sharp = require("sharp");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const media = require("../../utils/defectMedia");

const VIEW = requirePermission("defect:listing:view");
const MANAGE = requirePermission("defect:listing:manage");

const LISTINGS = "defect_listings";
const COUNTERS = "defect_counters";

// What works and what is faulty, as free-form items ("Screen", "Battery",
// "Zip"…). The item can be anything, so there is no fixed checklist: the
// assistant records the findings from the staff's description and staff can
// edit them. `state`: ok (tested, works) / faulty / unknown (mentioned, not
// tested). Listings made before 2026-10-09 stored the old fixed checklist
// keys — LEGACY_LABELS turns those into labels on read.
const LEGACY_LABELS = {
  powersOn: "Powers on", screen: "Screen (display)", touch: "Touch", backGlass: "Back glass / cover", frame: "Frame / body",
  rearCamera: "Rear camera", frontCamera: "Front camera", battery: "Battery", charging: "Charging port", speaker: "Speaker / earpiece",
  mic: "Microphone", buttons: "Buttons", biometrics: "Face ID / Touch ID / fingerprint", wireless: "Wi-Fi / Bluetooth / mobile signal",
  waterDamage: "Liquid damage", activationLock: "Activation lock / account lock",
};
const FAULT_STATES = ["ok", "faulty", "unknown"];
const CONDITIONS = ["For parts or not working", "Powers on, major faults", "Working with faults", "Cosmetic damage only"];
// what kind of item it is — the website filters on it (the assistant decides)
const CATEGORIES = ["Mobile Phone", "Tablet", "Laptop", "Game Console", "Other"];
const STATUSES = ["draft", "ready", "published", "sold", "withdrawn"];
// which status a listing may move to from each one (deleted is its own path)
const MOVES = {
  draft: ["ready", "published", "withdrawn"],
  ready: ["published", "draft", "withdrawn"],
  published: ["sold", "withdrawn", "draft"],
  withdrawn: ["draft", "ready", "published"],
  sold: [],
};
const DESCRIPTION_PARTS = ["works", "faults", "included", "condition"];

const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const oid = (v) => { try { return new ObjectId(String(v)); } catch (e) { return null; } };
const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const hist = (action, by, detail) => ({ at: new Date(), by, action, ...(detail ? { detail } : {}) });

// DL-10001, 10002 … — one counter document, never reused
async function nextListingNo(db) {
  const r = await db.collection(COUNTERS).findOneAndUpdate(
    { _id: "listing" },
    [{ $set: { seq: { $add: [{ $max: [{ $ifNull: ["$seq", 0] }, 10000] }, 1] } } }],
    { upsert: true, returnDocument: "after" },
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return { seq: doc.seq, no: `DL-${doc.seq}` };
}

// The device facts as typed (no lookup — most of these units have no record anywhere)
function deviceOf(body, partial) {
  const src = (body && body.device) || {};
  const out = {};
  const set = (k, v) => { if (partial && src[k] === undefined) return; out[k] = v; };
  set("brand", str(src.brand, 60));
  set("series", str(src.series, 60));   // the line within the brand: iPhone 14, Galaxy S, Moto G, PlayStation 5
  set("model", str(src.model, 120));
  set("storage", str(src.storage, 40));
  set("color", str(src.color, 60));
  set("imei", str(src.imei, 40).toUpperCase().replace(/[\s-]/g, ""));
  set("serialNumber", str(src.serialNumber, 60));
  set("modelNumber", str(src.modelNumber, 40));
  set("batteryHealth", num(src.batteryHealth));
  return out;
}
// the findings, validated: a label is required (an old fixed key becomes its
// label; old rows that were never ticked are dropped), one row per label
function faultsOf(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  const seen = new Set();
  for (const f of list) {
    if (!f || typeof f !== "object") continue;
    const legacy = !f.label && f.key ? LEGACY_LABELS[f.key] || "" : "";
    if (legacy && f.state !== "ok" && f.state !== "faulty") continue;
    const label = str(f.label || legacy, 60);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({ label, state: FAULT_STATES.includes(f.state) ? f.state : "unknown", note: str(f.note, 300) });
  }
  return out;
}
function descriptionOf(obj, partial) {
  if (obj == null || typeof obj !== "object") return partial ? undefined : { works: "", faults: "", included: "", condition: "" };
  const out = {};
  for (const k of DESCRIPTION_PARTS) {
    if (partial && obj[k] === undefined) continue;
    out[k] = str(obj[k], 4000);
  }
  return out;
}
// The fields staff edit, validated. `partial` keeps what the body doesn't mention.
function editableOf(body, partial) {
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  const device = deviceOf(body, partial);
  if (Object.keys(device).length) put("device", device);
  if (!partial || body.category !== undefined) {
    const cat = str(body.category, 40);
    if (cat && !CATEGORIES.includes(cat)) return { error: "Unknown category" };
    put("category", cat);
  }
  put("faults", faultsOf(body.faults));
  if (!partial || body.note !== undefined) put("note", str(body.note, 2000));
  if (!partial || body.included !== undefined) put("included", str(body.included, 500));
  if (!partial || body.price !== undefined) {
    const p = num(body.price);
    if (body.price != null && body.price !== "" && (p == null || p < 0 || p > 100000)) return { error: "Price must be 0 or more" };
    put("price", body.price == null || body.price === "" ? null : Math.round(p * 100) / 100);
  }
  if (!partial || body.title !== undefined) put("title", str(body.title, 120));
  if (!partial || body.summary !== undefined) put("summary", str(body.summary, 300));
  const d = descriptionOf(body.description, partial);
  if (d !== undefined) put("description", d);
  if (!partial || body.conditionLabel !== undefined) {
    const c = str(body.conditionLabel, 60);
    if (c && !CONDITIONS.includes(c)) return { error: "Unknown condition" };
    put("conditionLabel", c);
  }
  return { fields: out };
}
// a flat before/after of the changed fields for the history
function changesOf(before, after) {
  const out = {};
  const same = (a, b) => JSON.stringify(a == null || a === "" ? null : a) === JSON.stringify(b == null || b === "" ? null : b);
  for (const [k, v] of Object.entries(after)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) {
        const was = (before[k] || {})[kk];
        if (!same(was, vv)) out[`${k}.${kk}`] = { from: was == null ? "" : was, to: vv };
      }
    } else if (!same(before[k], v)) {
      out[k] = { from: before[k] == null ? "" : before[k], to: v };
    }
  }
  return out;
}
// what the list and the page get: media without storage keys
const publicMedia = (m) => ({
  id: m.id, kind: m.kind, url: m.url, thumbUrl: m.thumbUrl || (m.poster && m.poster.thumbUrl) || null,
  poster: m.poster ? { url: m.poster.url, thumbUrl: m.poster.thumbUrl } : null,
  width: m.width || null, height: m.height || null, duration: m.duration || null, size: m.size || null, name: m.name || "", contentType: m.contentType || "",
});
const viewOf = (l) => ({ ...l, faults: faultsOf(l.faults) || [], media: (l.media || []).map(publicMedia) });
// is the listing complete enough to go on sale?
function readyProblems(l) {
  const p = [];
  if (!str(l.title, 1)) p.push("a title");
  if (!(l.media || []).some((m) => m.kind === "photo" || m.kind === "video")) p.push("a photo or a video");
  if (!(l.price > 0)) p.push("a price");
  const d = l.description || {};
  if (!str(d.faults, 1) && !str(d.condition, 1)) p.push("the faults or the condition described");
  if (!str((l.device || {}).brand, 1)) p.push("the brand");
  if (!str((l.device || {}).model, 1)) p.push("the device model");
  if (!CATEGORIES.includes(l.category)) p.push("the category");
  return p;
}
async function loadListing(db, id) {
  const _id = oid(id);
  if (!_id) return null;
  return db.collection(LISTINGS).findOne({ _id, status: { $ne: "deleted" } });
}

// ── meta ────────────────────────────────────────────────────────────────
router.get("/meta", VIEW, (req, res) => {
  res.json({
    success: true,
    faultStates: FAULT_STATES,
    conditions: CONDITIONS,
    categories: CATEGORIES,
    statuses: STATUSES,
    moves: MOVES,
    limits: { maxPhotos: media.MAX_PHOTOS, maxVideoBytes: media.MAX_VIDEO_BYTES, maxVideoSeconds: media.MAX_VIDEO_SECONDS, photoTargetBytes: 1024 * 1024, videoTypes: Object.keys(media.VIDEO_TYPES) },
    mediaConfigured: media.isConfigured(),
    aiConfigured: !!process.env.ANTHROPIC_API_KEY,
  });
});

// ── listings ────────────────────────────────────────────────────────────
router.get("/listings", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 24, 1), 200);
    const match = { status: { $ne: "deleted" } };
    if (req.query.status && STATUSES.includes(String(req.query.status))) match.status = String(req.query.status);
    if (req.query.category && CATEGORIES.includes(String(req.query.category))) match.category = String(req.query.category);
    const q = str(req.query.q, 80);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      match.$or = [{ listingNo: rx }, { title: rx }, { "device.model": rx }, { "device.brand": rx }, { "device.series": rx }, { "device.imei": rx }, { "device.serialNumber": rx }];
    }
    // the New Listing page's history: listings built or continued in the chat
    const chatOnly = String(req.query.chat || "") === "1";
    if (chatOnly) match.$or = [...(match.$or || []), { viaChat: true }, { "chat.0": { $exists: true } }];
    const col = db.collection(LISTINGS);
    const [rows, total, byStatus] = await Promise.all([
      col.find(match, { projection: { history: 0, ai: 0, chat: 0 } }).sort(chatOnly ? { updatedAt: -1 } : { seq: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      col.countDocuments(match),
      col.aggregate([{ $match: { status: { $ne: "deleted" } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    ]);
    return res.json({
      success: true,
      rows: rows.map((l) => ({ ...viewOf(l), description: undefined, note: undefined })),
      total,
      counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    });
  } catch (e) { next(e); }
});

router.post("/listings", MANAGE, async (req, res, next) => {
  try {
    const { fields, error } = editableOf(req.body || {}, false);
    if (error) return bad(res, error);
    if (!str(fields.device.model, 1)) return bad(res, "The device model is required");
    const db = await connectToDatabase();
    const { seq, no } = await nextListingNo(db);
    const now = new Date();
    const by = actor(req);
    const doc = {
      listingNo: no, seq, status: "draft", category: "",
      ...fields,
      faults: fields.faults || [],
      media: [], ai: null,
      createdAt: now, createdBy: by, updatedAt: now, updatedBy: by,
      history: [hist("created", by)],
    };
    const r = await db.collection(LISTINGS).insertOne(doc);
    return res.json({ success: true, listing: viewOf({ ...doc, _id: r.insertedId }) });
  } catch (e) { next(e); }
});

router.get("/listings/:id", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await loadListing(db, req.params.id);
    if (!l) return bad(res, "Listing not found", 404);
    return res.json({ success: true, listing: viewOf(l) });
  } catch (e) { next(e); }
});

router.put("/listings/:id", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await loadListing(db, req.params.id);
    if (!l) return bad(res, "Listing not found", 404);
    if (l.status === "sold") return bad(res, `${l.listingNo} is sold — it can't be edited`);
    const { fields, error } = editableOf(req.body || {}, true);
    if (error) return bad(res, error);
    if (fields.device) fields.device = { ...(l.device || {}), ...fields.device };
    if (fields.description) fields.description = { ...(l.description || {}), ...fields.description };
    if (fields.device && !str(fields.device.model, 1)) return bad(res, "The device model is required");
    const changes = changesOf(l, fields);
    if (!Object.keys(changes).length) return res.json({ success: true, listing: viewOf(l), changed: 0 });
    const now = new Date();
    const by = actor(req);
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $set: { ...fields, updatedAt: now, updatedBy: by },
      $push: { history: hist("updated", by, changes) },
    });
    const after = await loadListing(db, req.params.id);
    return res.json({ success: true, listing: viewOf(after), changed: Object.keys(changes).length });
  } catch (e) { next(e); }
});

// A draft that was never published is removed from view (kept, marked
// deleted — nothing is erased; its files stay in the bucket).
router.delete("/listings/:id", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await loadListing(db, req.params.id);
    if (!l) return bad(res, "Listing not found", 404);
    if (l.publishedAt || l.status === "sold") return bad(res, `${l.listingNo} has been on sale — withdraw it instead of deleting`);
    const now = new Date();
    const by = actor(req);
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: { status: "deleted", deletedAt: now, deletedBy: by, updatedAt: now, updatedBy: by }, $push: { history: hist("deleted", by) } });
    return res.json({ success: true });
  } catch (e) { next(e); }
});

// ── media ───────────────────────────────────────────────────────────────
async function withEditable(req, res, db) {
  const l = await loadListing(db, req.params.id);
  if (!l) { bad(res, "Listing not found", 404); return null; }
  if (l.status === "sold") { bad(res, `${l.listingNo} is sold — its media can't change`); return null; }
  return l;
}
const mediaCount = (l) => (l.media || []).filter((m) => m.kind !== "poster").length;

router.post("/listings/:id/photos", MANAGE, media.acceptPhotos, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    const files = req.files || [];
    if (!files.length) return bad(res, "Pick at least one photo");
    if (mediaCount(l) + files.length > media.MAX_PHOTOS) return bad(res, `A listing holds up to ${media.MAX_PHOTOS} photos and videos`);
    const added = [];
    for (const f of files) added.push(await media.storePhoto(f, l.listingNo, "photo"));
    const now = new Date();
    const by = actor(req);
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $push: { media: { $each: added }, history: hist("photos added", by, { count: added.length }) },
      $set: { updatedAt: now, updatedBy: by },
    });
    return res.json({ success: true, added: added.map(publicMedia) });
  } catch (e) {
    if (e && e.status) return bad(res, e.message, e.status);
    next(e);
  }
});

// The browser uploads the video itself: it asks for a signed URL, PUTs the
// file to S3, then reports it done (finish) so the listing records it.
router.post("/listings/:id/video", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    if (mediaCount(l) + 1 > media.MAX_PHOTOS) return bad(res, `A listing holds up to ${media.MAX_PHOTOS} photos and videos`);
    const b = req.body || {};
    const signed = await media.presignVideo({ listingNo: l.listingNo, contentType: b.contentType, size: b.size });
    // remembered as pending so finish can check the key is one we handed out
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $push: { pendingVideos: { id: signed.id, key: signed.key, contentType: signed.contentType, name: str(b.name, 140), size: Number(b.size) || 0, at: new Date(), by: actor(req) } },
    });
    return res.json({ success: true, upload: signed });
  } catch (e) {
    if (e && e.status) return bad(res, e.message, e.status);
    next(e);
  }
});

router.post("/listings/:id/video/:mediaId/finish", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    const pending = (l.pendingVideos || []).find((p) => p.id === req.params.mediaId);
    if (!pending) return bad(res, "That upload wasn't started here — start it again", 404);
    const head = await media.headObject(pending.key);
    if (!head || !head.size) return bad(res, "The video hasn't arrived in the bucket — upload it again");
    const b = req.body || {};
    // the limits the browser already applies, enforced here too: the object goes
    const dur = num(b.duration);
    const tooLong = dur != null && dur > media.MAX_VIDEO_SECONDS + 0.5;
    const tooBig = head.size > media.MAX_VIDEO_BYTES;
    if (tooLong || tooBig) {
      try { await media.removeObject(pending.key); } catch (e) { console.warn("Defective video: could not remove a refused upload:", e.message); }
      await db.collection(LISTINGS).updateOne({ _id: l._id }, { $pull: { pendingVideos: { id: pending.id } } });
      return bad(res, tooLong ? `A video must be ${media.MAX_VIDEO_SECONDS} seconds or shorter` : `A video must be ${Math.round(media.MAX_VIDEO_BYTES / 1024 / 1024)} MB or smaller`);
    }
    const entry = {
      id: pending.id, kind: "video", key: pending.key, url: media.urlOf(pending.key), contentType: head.contentType || pending.contentType,
      name: pending.name, size: head.size, duration: num(b.duration), width: num(b.width), height: num(b.height), poster: null, addedAt: new Date(),
    };
    const now = new Date();
    const by = actor(req);
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $push: { media: entry, history: hist("video added", by, { name: entry.name, size: entry.size }) },
      $pull: { pendingVideos: { id: pending.id } },
      $set: { updatedAt: now, updatedBy: by },
    });
    return res.json({ success: true, added: publicMedia(entry) });
  } catch (e) {
    if (e && e.status) return bad(res, e.message, e.status);
    next(e);
  }
});

router.post("/listings/:id/media/:mediaId/poster", MANAGE, media.acceptPoster, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    const video = (l.media || []).find((m) => m.id === req.params.mediaId && m.kind === "video");
    if (!video) return bad(res, "Video not found", 404);
    if (!req.file) return bad(res, "Pick an image");
    const poster = await media.storePhoto(req.file, l.listingNo, "poster");
    if (video.poster) { await media.removeObject(video.poster.key); await media.removeObject(video.poster.thumbKey); }
    await db.collection(LISTINGS).updateOne({ _id: l._id, "media.id": video.id }, { $set: { "media.$.poster": poster, updatedAt: new Date(), updatedBy: actor(req) } });
    return res.json({ success: true, media: publicMedia({ ...video, poster }) });
  } catch (e) {
    if (e && e.status) return bad(res, e.message, e.status);
    next(e);
  }
});

router.put("/listings/:id/media/order", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
    const current = l.media || [];
    const byId = new Map(current.map((m) => [m.id, m]));
    if (ids.length !== current.length || !ids.every((id) => byId.has(id)) || new Set(ids).size !== ids.length) return bad(res, "The order must list every photo and video once");
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: { media: ids.map((id) => byId.get(id)), updatedAt: new Date(), updatedBy: actor(req) } });
    return res.json({ success: true });
  } catch (e) { next(e); }
});

router.delete("/listings/:id/media/:mediaId", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await withEditable(req, res, db);
    if (!l) return;
    const m = (l.media || []).find((x) => x.id === req.params.mediaId);
    if (!m) return bad(res, "Photo or video not found", 404);
    const now = new Date();
    const by = actor(req);
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $pull: { media: { id: m.id } },
      $push: { history: hist(`${m.kind} removed`, by, { name: m.name || "" }) },
      $set: { updatedAt: now, updatedBy: by },
    });
    for (const key of [m.key, m.thumbKey, m.poster && m.poster.key, m.poster && m.poster.thumbKey]) await media.removeObject(key);
    return res.json({ success: true });
  } catch (e) { next(e); }
});

// ── the AI draft ────────────────────────────────────────────────────────
// Claude gets the item's details, the findings, the staff note, the price and
// the photos, and must answer through write_listing (a forced tool call, so
// the draft is always well-formed). Guardrails live in the system prompt:
// nothing is called working unless recorded ok, unknown stays unknown, no
// specs beyond what was typed. The draft is stored on the listing and
// returned; the page puts it in the form for staff to edit.
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const AI_MAX_PHOTOS = 8;
const AI_PROMPT_VERSION = 1;
const WRITE_LISTING_TOOL = {
  name: "write_listing",
  description: "Write the sales listing for this defective item.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Up to 80 characters: brand, model, storage, colour, then the headline fault or condition, e.g. 'iPhone 11 64GB Black – cracked screen, powers on'." },
      summary: { type: "string", description: "One or two sentences (up to 200 characters) a buyer reads first: what it is and the main thing wrong with it." },
      works: { type: "string", description: "What works — ONLY the findings recorded ok (tested and working), one per line starting with '- '. Empty if nothing was recorded ok." },
      faults: { type: "string", description: "Known faults — every finding recorded faulty, with its note and what the photos show, one per line starting with '- '. Plain and specific." },
      included: { type: "string", description: "Only when the staff said something extra comes with it (charger, box, case…): what that is. Otherwise an empty string — the item alone needs no line and the section is not shown. Never ask about it." },
      condition: { type: "string", description: "The item description a buyer reads: what the item is and its condition, built only from the facts the staff gave (plus what the photos plainly show). Two to five plain lines that state the facts directly ('Screen is cracked at the top corner.') — never 'the staff say', 'as described', 'reported', 'according to' or any mention of who told you. No untested functions, assumptions or anything that was not given." },
      conditionLabel: { type: "string", enum: CONDITIONS, description: "The one label that fits best." },
      openQuestions: { type: "array", items: { type: "string" }, description: "Only the basics still missing before it can go on sale — photos or a video, the price — one short line each, up to 2. Never what's included (unsaid means it comes alone). Nothing else: never ask for more tests or details; what the staff did not mention is simply left as untested." },
      photoNotes: { type: "array", items: { type: "object", properties: { photo: { type: "integer" }, note: { type: "string" } }, required: ["photo", "note"] }, description: "What each photo shows, numbered as given (one short line each)." },
    },
    required: ["title", "summary", "works", "faults", "included", "condition", "conditionLabel", "openQuestions"],
  },
};
const SYSTEM_PROMPT = `You write honest, plain-English sales listings for defective, old or faulty items sold as-is by an Australian phone repair shop — mostly phones and other devices, but it can be anything. Buyers are technicians, tinkerers and bargain hunters; they need to know exactly what is wrong.

Rules:
- Use only the facts given: the item's details, the findings (what was tested working / faulty), the staff note and the photos. Do not add specifications, features or history you were not given — not even a model's standard storage, screen size or year you happen to know; if storage was not given, leave it out of the title.
- A function is "working" only if the findings record it ok; never imply anything else works. What the staff did not mention is simply left out — do not list untested functions.
- The condition text is the item description: only the facts the staff gave about the item, plus what the photos plainly show, written as a plain product description that states the facts directly. Never write "the staff say", "as described", "reported", "according to" or who told you — in any part of the listing.
- Describe faults and cosmetic damage concretely (where, how big, what it affects). If a photo shows damage the findings don't mention, include it in the text.
- Write only from what was given and do not ask the staff for more tests or details — openQuestions is only for the basics still missing (photos or a video, the price), up to 2; what's included is never asked — unsaid means it comes alone.
- No hype, no filler, no emojis, no promises about repairability or value. Do not mention the price unless the staff note asks you to.
- Australian English. Write for a product page: short lines, '- ' bullets in works/faults.`;

function aiClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  return new Anthropic();
}
// the listing's photos (and video posters) as small base64 JPEGs for the model
async function photoBlocks(listing) {
  // photos only — videos are for buyers, the model never sees a frame of them
  const items = (listing.media || []).filter((m) => m.kind === "photo").slice(0, AI_MAX_PHOTOS);
  const blocks = [];
  let n = 0;
  for (const m of items) {
    const url = m.kind === "photo" ? m.url : m.poster.url;
    try {
      const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
      const jpeg = await sharp(Buffer.from(r.data)).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      n += 1;
      blocks.push({ type: "text", text: `Photo ${n}:` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } });
    } catch (e) {
      console.warn("Defective listing draft: photo skipped:", e.message);
    }
  }
  return { blocks, count: n };
}
function factsText(l, instructions) {
  const d = l.device || {};
  const lines = ["ITEM"];
  for (const [label, v] of [["Category", l.category], ["Brand", d.brand], ["Series", d.series], ["Model", d.model], ["Storage", d.storage], ["Colour", d.color], ["Model number", d.modelNumber], ["Battery health", d.batteryHealth != null ? `${d.batteryHealth}%` : ""]]) {
    if (v) lines.push(`${label}: ${v}`);
  }
  lines.push("", "FINDINGS (ok = tested and working, faulty = broken, unknown = mentioned but not tested; anything not listed is untested)");
  const findings = faultsOf(l.faults) || [];
  if (!findings.length) lines.push("(none recorded yet)");
  for (const x of findings) lines.push(`${x.label}: ${x.state}${x.note ? ` — ${x.note}` : ""}`);
  lines.push("", `WHAT'S INCLUDED: ${l.included || "(not said — it comes alone)"}`);
  lines.push(`PRICE: ${l.price > 0 ? `AUD ${l.price}` : "(not set)"}`);
  lines.push("", `STAFF NOTE: ${l.note || "(none)"}`);
  if (instructions) lines.push("", `EXTRA INSTRUCTIONS FOR THIS DRAFT: ${instructions}`);
  return lines.join("\n");
}

// what write_listing returned, cleaned; with no photos the staff are told so
function draftOf(i, photoCount) {
  const draft = {
    title: str(i.title, 120), summary: str(i.summary, 300),
    description: { works: str(i.works, 4000), faults: str(i.faults, 4000), included: str(i.included, 500), condition: str(i.condition, 4000) },
    conditionLabel: CONDITIONS.includes(i.conditionLabel) ? i.conditionLabel : "",
    openQuestions: (Array.isArray(i.openQuestions) ? i.openQuestions : []).map((q) => str(q, 300)).filter(Boolean).slice(0, 3),
    photoNotes: (Array.isArray(i.photoNotes) ? i.photoNotes : []).map((p) => ({ photo: num(p && p.photo), note: str(p && p.note, 300) })).filter((p) => p.note),
  };
  // the model doesn't always ask for photos when there are none — the page should
  if (!photoCount && !draft.openQuestions.length) draft.openQuestions.push("No photos yet: add photos of the screen, the back and every damaged spot before publishing.");
  return draft;
}
// one listing photo (or a video's cover) as an image block for the model, or null
async function imageBlock(url) {
  try {
    const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
    const jpeg = await sharp(Buffer.from(r.data)).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
  } catch (e) {
    console.warn("Defective listing: photo skipped:", e.message);
    return null;
  }
}

router.post("/listings/:id/draft", MANAGE, async (req, res, next) => {
  try {
    const client = aiClient();
    if (!client) return bad(res, "The AI assistant isn't set up on the server (ANTHROPIC_API_KEY)", 503);
    const db = await connectToDatabase();
    const l = await loadListing(db, req.params.id);
    if (!l) return bad(res, "Listing not found", 404);
    if (l.status === "sold") return bad(res, `${l.listingNo} is sold`);
    if (!str((l.device || {}).model, 1)) return bad(res, "Enter the device model first");
    const instructions = str(req.body && req.body.instructions, 1000);
    const { blocks, count } = await photoBlocks(l);
    const content = [{ type: "text", text: factsText(l, instructions) }, ...blocks,
      { type: "text", text: count ? `Write the listing from the facts and the ${count} photo${count === 1 ? "" : "s"}.` : "There are no photos yet — write the listing from the facts alone and ask for photos in openQuestions." }];
    const resp = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      tools: [WRITE_LISTING_TOOL],
      tool_choice: { type: "tool", name: "write_listing" },
      messages: [{ role: "user", content }],
    });
    const call = (resp.content || []).find((b) => b.type === "tool_use" && b.name === "write_listing");
    if (!call || !call.input) return bad(res, "The assistant didn't return a draft — try again", 502);
    const draft = draftOf(call.input, count);
    const ai = {
      draftedAt: new Date(), by: actor(req), model: resp.model || AI_MODEL, promptVersion: AI_PROMPT_VERSION, photos: count,
      usage: resp.usage ? { input: resp.usage.input_tokens, output: resp.usage.output_tokens } : null,
      draft,
    };
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: { ai, updatedAt: new Date(), updatedBy: actor(req) }, $push: { history: hist("AI draft", actor(req), { photos: count, model: ai.model }) } });
    return res.json({ success: true, draft, photos: count, model: ai.model, usage: ai.usage });
  } catch (e) {
    const msg = (e && e.error && e.error.error && e.error.error.message) || (e && e.message) || "";
    if (e && e.status && e.status >= 400 && e.status < 500) return bad(res, `The assistant refused the request: ${msg}`, 502);
    next(e);
  }
});

// ── status ──────────────────────────────────────────────────────────────
router.post("/listings/:id/status", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await loadListing(db, req.params.id);
    if (!l) return bad(res, "Listing not found", 404);
    const to = str(req.body && req.body.to, 20);
    if (!STATUSES.includes(to)) return bad(res, "Unknown status");
    if (!(MOVES[l.status] || []).includes(to)) return bad(res, `${l.listingNo} is ${l.status}; it can't go to ${to}`);
    if (to === "ready" || to === "published") {
      const problems = readyProblems(l);
      if (problems.length) return bad(res, `${l.listingNo} still needs ${problems.join(", ")}`);
    }
    const now = new Date();
    const by = actor(req);
    const set = { status: to, updatedAt: now, updatedBy: by };
    const detail = { from: l.status, to };
    if (to === "published") { set.publishedAt = l.publishedAt || now; set.withdrawnAt = null; }
    if (to === "withdrawn") { set.withdrawnAt = now; set.withdrawNote = str(req.body && req.body.note, 500); if (set.withdrawNote) detail.note = set.withdrawNote; }
    if (to === "sold") {
      const s = (req.body && req.body.sold) || {};
      const price = num(s.price);
      set.soldAt = now;
      set.sold = { price: price != null && price >= 0 ? Math.round(price * 100) / 100 : l.price, channel: str(s.channel, 60), note: str(s.note, 500), by };
      detail.sold = set.sold;
    }
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: set, $push: { history: hist(to, by, detail) } });
    const after = await loadListing(db, req.params.id);
    return res.json({ success: true, listing: viewOf(after) });
  } catch (e) { next(e); }
});

// ── the chat assistant (New Listing page, user 2026-10-09) ──────────────
// Staff describe the device in a chat. The assistant records what it is
// told (update_listing), asks for what is missing, and writes the text
// (write_listing) once it knows enough. The listing is created on the first
// message and saved after every tool call; the chat is kept on it so the
// page can resume. Publishing stays with the staff (the Publish button).
const CHAT_ROUNDS = 4;      // tool rounds per turn
const CHAT_IMAGES = 6;      // photos of the latest user turn the model sees (each photo once)
const CHAT_KEEP = 40;       // turns kept on the listing
const UPDATE_LISTING_TOOL = {
  name: "update_listing",
  description: "Record facts the staff gave about the item: its details, findings (what works / what is faulty), the price, what's included, or a short note. Pass only what was said; a finding not mentioned stays as it is.",
  input_schema: {
    type: "object",
    properties: {
      device: { type: "object", properties: { brand: { type: "string" }, series: { type: "string", description: "The family within the brand, on top of the model and only when it has one: iPhone 14, Galaxy Tab S, Moto G, PlayStation, MacBook Air…" }, model: { type: "string", description: "ALWAYS set when the item is known — the full model name as the staff said it, e.g. 'Galaxy Tab S6 Lite', 'iPhone 14 Pro', 'V8', 'Switch Lite'. Never leave it empty while filling series." }, storage: { type: "string" }, color: { type: "string" }, imei: { type: "string" }, serialNumber: { type: "string" }, modelNumber: { type: "string" }, batteryHealth: { type: "number" } } },
      findings: { type: "array", description: "What works and what is faulty, decided from what the staff said: one item per part or function, named plainly as they would (e.g. 'Screen', 'Battery', 'Charging port', 'Zip', 'Motor'); state ok = they said it was tested and works, faulty = broken, unknown = they said it was not tested; a short note on each fault saying what exactly. Never add items they did not mention. An item given again replaces the earlier one with the same label.", items: { type: "object", properties: { label: { type: "string" }, state: { type: "string", enum: FAULT_STATES }, note: { type: "string" } }, required: ["label", "state"] } },
      category: { type: "string", enum: CATEGORIES, description: "What kind of item it is — decide it yourself as soon as the item is known." },
      price: { type: "number", description: "AUD including GST — only when the staff state it." },
      included: { type: "string", description: "What comes with it — only when the staff mention it; unsaid means the item alone." },
      note: { type: "string", description: "A short note of what the staff told you about the unit (history, what was tested) that the listing should reflect." },
    },
  },
};
// what the model can only see in the photos is proposed, not recorded: it
// waits on the listing as pendingSuggestion until the staff say yes or no
const SUGGEST_TOOL = {
  name: "suggest_details",
  description: "Propose details you can SEE in the attached photos but the staff did not state: brand, series, model, colour, the storage printed on the item or its box, accessories in the picture (what's included), the category. Nothing here is recorded until the staff confirm — they get a Yes / No. Use it instead of update_listing for anything that comes only from the photos. Visible damage and wear are findings: record those with update_listing straight away.",
  input_schema: {
    type: "object",
    properties: {
      device: { type: "object", properties: { brand: { type: "string" }, series: { type: "string" }, model: { type: "string" }, storage: { type: "string" }, color: { type: "string" } } },
      category: { type: "string", enum: CATEGORIES },
      included: { type: "string", description: "Accessories seen in the photos, e.g. 'Charger and box'." },
      note: { type: "string", description: "One short line on what in the photos made you think so, e.g. 'the Apple logo and the triple camera; a charger is in the box'." },
    },
  },
};
// the suggestion, cleaned, for the listing
function suggestionOf(input) {
  const device = deviceOf({ device: (input && input.device) || {} }, true);
  const out = { device, category: CATEGORIES.includes(input && input.category) ? input.category : "", included: str(input && input.included, 500), note: str(input && input.note, 300), at: new Date() };
  const any = Object.values(device).some(Boolean) || out.category || out.included;
  return any ? out : null;
}
const suggestionLine = (sg) => {
  const d = sg.device || {};
  const parts = [["category", sg.category], ["brand", d.brand], ["series", d.series], ["model", d.model], ["storage", d.storage], ["colour", d.color], ["included", sg.included]].filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  return parts.join(", ");
};

const CHAT_PROMPT = `You are the listing assistant on the "New Listing" page of a phone repair shop's dashboard. A staff member is telling you about ONE defective, old or faulty item they want to sell as it is — usually a phone or another device, but it can be anything. Get the facts, record them, and write the listing — with as little typing from them as possible.

How to work:
- Record every fact they give straight away with update_listing: the item's details (brand; model — ALWAYS, the full model name as they said it, e.g. 'Galaxy Tab S6 Lite', 'iPhone 14 Pro', 'V8'; series — the family on top of the model, only when it has one: iPhone 14, Galaxy Tab S, Moto G, PlayStation; storage; colour — whichever apply); the category — Mobile Phone, Tablet, Laptop, Game Console or Other — which YOU decide from what the item is, without asking; the findings — from their description YOU decide what is working and what is faulty, one item per part or function named plainly (Screen, Battery, Charging port, Zip, Motor…), ok (tested, works) / faulty / unknown (they said it was not tested), with a note on each fault; the price; what's included; a short note of what they told you.
- Then ask for what is still missing, ONE short question at a time, in this order: the item (brand, model, storage, colour — whichever apply) → what is wrong and what was tested → photos (ask them to attach photos of the front, the back and any damage, and a video if a fault is hard to show) → the price (they decide it — never suggest or judge a price).
- When photos are attached, say in one line what you notice (damage, wear) and add it to the findings if it adds to what they said.
- Videos are for buyers only: you never see them, so never describe or guess what a video shows — just note that it is attached.
- What you can only SEE in the photos — brand, model, colour, storage printed on the item or box, accessories in the shot, the category — is a suggestion, not a fact: call suggest_details with it (one call per turn, everything in it) and ask in one short line whether to record it; the staff get a Yes / No. Never put photo-only details into update_listing. If a photo contradicts what they typed (another colour, another model), say so in one line and suggest the correction the same way.
- Once the device, the faults or tests, and the price are known, call write_listing (photos are strongly preferred, but don't wait for them more than once). Then say in one or two lines that the text is written and what they should check. If they ask for changes to the text, call write_listing again with the changes.
- Keep questions to the basics: the item, what is wrong, photos, the price. Never ask them to test more things or for extra details — the listing describes only what they told you; anything not mentioned is simply untested.
- Never ask what's included: if they don't mention it, the item comes alone and the text's included line stays empty. Record it only when they say something comes with it.
- Keep replies short and plain: one to three sentences. Australian English. No emojis, no bullet lists in the chat.
- Rely only on the item's details, the findings, the staff's words and the photos — never invent specs, history or test results. A function is "working" only if the staff said it was tested and works.
- Publishing is done by the staff with the Publish button; you cannot publish or set the price.

When writing the listing (write_listing):
- Use only the facts given — no specs from your own knowledge (not even a model's standard storage or screen size; if storage was not given, leave it out of the title). "What works" lists only findings recorded ok; never imply anything else works, and leave out what they did not mention (no lists of untested functions). The condition text is the item description: only the facts they gave, written directly to the buyer ("Screen is cracked at the top corner.") — never "the staff say", "as described", "reported" or who told you, anywhere in the listing.
- Describe faults and cosmetic damage concretely. No hype, no filler, no promises about repairability or value. Do not mention the price.
- Product-page style: short lines, '- ' bullets in works/faults.`;

// the system prompt for a turn: the persona plus the listing as it stands
function chatSystem(l) {
  const missing = readyProblems(l);
  return `${CHAT_PROMPT}

CURRENT LISTING STATE (${l.listingNo})
${factsText(l)}

LISTING TEXT WRITTEN: ${l.title ? "yes — title: " + l.title : "not yet"}
PHOTOS / VIDEOS ATTACHED: ${(l.media || []).filter((m) => m.kind === "photo").length} / ${(l.media || []).filter((m) => m.kind === "video").length}
STILL NEEDED BEFORE IT CAN BE PUBLISHED: ${missing.length ? missing.join(", ") : "nothing"}`;
}
// the stored chat as model messages: alternating turns (consecutive user
// turns merged), the latest CHAT_IMAGES photos as images, older ones named
async function chatMessages(l) {
  const mediaById = new Map((l.media || []).map((m) => [m.id, m]));
  const turns = l.chat || [];
  // which attachments still get sent as pictures
  // only the photos attached in the latest user turn go as pictures, so
  // each photo is looked at once (2026-10-09: cost); older ones are named
  const withPictures = new Set();
  const last = [...turns].reverse().find((t) => t.role === "user");
  let n = 0;
  for (const id of [...((last && last.mediaIds) || [])].reverse()) {
    if (n >= CHAT_IMAGES) break;
    if (mediaById.has(id) && mediaById.get(id).kind === "photo") { withPictures.add(id); n++; }
  }
  const out = [];
  for (const t of turns) {
    if (t.role === "assistant") {
      const text = String(t.text || "").trim();
      if (!text) continue;
      if (out.length && out[out.length - 1].role === "assistant") out[out.length - 1].content += "\n" + text;
      else out.push({ role: "assistant", content: text });
      continue;
    }
    const blocks = [];
    const text = String(t.text || "").trim();
    const ids = (t.mediaIds || []).filter((id) => mediaById.has(id));
    if (text) blocks.push({ type: "text", text });
    for (const id of ids) {
      const m = mediaById.get(id);
      const label = m.kind === "video" ? "a video — it is on the listing for buyers, you do not see it" : "a photo";
      if (withPictures.has(id)) {
        const img = m.url ? await imageBlock(m.url) : null;
        blocks.push({ type: "text", text: `[attached ${label}]` });
        if (img) blocks.push(img);
      } else {
        blocks.push({ type: "text", text: `[attached ${label} earlier — already looked at; what it showed is in the findings and your notes]` });
      }
    }
    if (!blocks.length) continue;
    if (out.length && out[out.length - 1].role === "user") out[out.length - 1].content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(start)" }] });
  if (out[out.length - 1].role !== "user") out.push({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  return out;
}
// update_listing: merge what the assistant recorded into the listing
async function applyUpdateTool(db, l, input, by) {
  const body = {};
  if (input.device && typeof input.device === "object") body.device = input.device;
  if (input.price != null) body.price = input.price;
  if (input.category != null) body.category = input.category;
  if (input.included != null) body.included = input.included;
  if (Array.isArray(input.findings)) {
    // merged by label: an item given again replaces the earlier one
    const merged = new Map((faultsOf(l.faults) || []).map((x) => [x.label.toLowerCase(), x]));
    for (const c of faultsOf(input.findings) || []) merged.set(c.label.toLowerCase(), c);
    body.faults = [...merged.values()];
  }
  if (input.note) {
    const add = str(input.note, 1000);
    body.note = l.note && l.note.includes(add) ? l.note : str([l.note, add].filter(Boolean).join("\n"), 2000);
  }
  const { fields, error } = editableOf(body, true);
  if (error) return { ok: false, error };
  if (fields.device) fields.device = { ...(l.device || {}), ...fields.device };
  const changes = changesOf(l, fields);
  if (!Object.keys(changes).length) return { ok: true, changed: [], stillNeeded: readyProblems(l) };
  const now = new Date();
  await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: { ...fields, updatedAt: now, updatedBy: by }, $push: { history: hist("updated by the assistant", by, changes) } });
  const after = await loadListing(db, l._id);
  return { ok: true, changed: Object.keys(changes), stillNeeded: readyProblems(after) };
}
// write_listing from the chat: the text goes straight onto the listing
async function applyWriteTool(db, l, input, by) {
  const photos = (l.media || []).filter((m) => m.kind === "photo").length;
  const draft = draftOf(input || {}, photos);
  const ai = { draftedAt: new Date(), by, model: AI_MODEL, promptVersion: AI_PROMPT_VERSION, photos, via: "chat", draft };
  const now = new Date();
  await db.collection(LISTINGS).updateOne({ _id: l._id }, {
    $set: { ai, title: draft.title, summary: draft.summary, description: draft.description, conditionLabel: draft.conditionLabel, updatedAt: now, updatedBy: by },
    $push: { history: hist("AI draft (chat)", by, { photos }) },
  });
  const after = await loadListing(db, l._id);
  return { ok: true, written: true, openQuestions: draft.openQuestions, stillNeeded: readyProblems(after) };
}

// Yes / No to the details the assistant saw in the photos: recorded (or
// dropped) here, with both chat turns stored — no AI call.
router.post("/assist/decide", MANAGE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const l = await loadListing(db, req.body && req.body.listingId);
    if (!l) return bad(res, "Listing not found", 404);
    const sg = l.pendingSuggestion;
    if (!sg) return bad(res, "There is no suggestion waiting");
    const accept = !!(req.body && req.body.accept);
    const by = actor(req);
    const now = new Date();
    const userText = accept ? "Yes, record that." : "No, leave it.";
    let reply = "Okay, left as it was.";
    const actions = [];
    if (accept) {
      const body = { device: sg.device || {} };
      if (sg.category) body.category = sg.category;
      if (sg.included) body.included = sg.included;
      const r = await applyUpdateTool(db, l, body, by);
      if (!r.ok) return bad(res, r.error || "Could not record the suggestion");
      if (r.changed.length) actions.push("updated");
      reply = `Recorded: ${suggestionLine(sg)}.`;
    }
    await db.collection(LISTINGS).updateOne({ _id: l._id }, {
      $unset: { pendingSuggestion: "" },
      $push: { chat: { $each: [{ role: "user", text: userText, mediaIds: [], at: now, by }, { role: "assistant", text: reply, actions, at: now }], $slice: -CHAT_KEEP } },
      $set: { updatedAt: now, updatedBy: by },
    });
    const after = await loadListing(db, l._id);
    return res.json({ success: true, listing: viewOf(after), userText, reply, actions });
  } catch (e) { next(e); }
});

router.post("/assist", MANAGE, async (req, res, next) => {
  try {
    const client = aiClient();
    if (!client) return bad(res, "The AI assistant isn't set up on the server (ANTHROPIC_API_KEY)", 503);
    const db = await connectToDatabase();
    const by = actor(req);
    const now = new Date();
    const b = req.body || {};
    const message = str(b.message, 4000);
    const mediaIds = Array.isArray(b.mediaIds) ? b.mediaIds.map(String).slice(0, media.MAX_PHOTOS) : [];
    let l = b.listingId ? await loadListing(db, b.listingId) : null;
    if (b.listingId && !l) return bad(res, "Listing not found", 404);
    if (l && l.status === "sold") return bad(res, `${l.listingNo} is sold`);
    if (!l) {
      // the page starts the listing before anything is known about the unit
      const { seq, no } = await nextListingNo(db);
      const doc = {
        listingNo: no, seq, status: "draft",
        device: { brand: "", series: "", model: "", storage: "", color: "", imei: "", serialNumber: "", modelNumber: "", batteryHealth: null },
        category: "", faults: [], note: "", included: "", price: null, title: "", summary: "", description: { works: "", faults: "", included: "", condition: "" }, conditionLabel: "",
        media: [], ai: null, chat: [], viaChat: true,
        createdAt: now, createdBy: by, updatedAt: now, updatedBy: by, history: [hist("created", by, { via: "chat" })],
      };
      const r = await db.collection(LISTINGS).insertOne(doc);
      l = { ...doc, _id: r.insertedId };
    }
    if (!message && !mediaIds.length) return res.json({ success: true, listing: viewOf(l), reply: "", actions: [] });

    // the turn is kept even if the model fails
    const known = new Set((l.media || []).map((m) => m.id));
    const turn = { role: "user", text: message, mediaIds: mediaIds.filter((id) => known.has(id)), at: now, by };
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $push: { chat: { $each: [turn], $slice: -CHAT_KEEP } }, $set: { updatedAt: now, updatedBy: by } });
    l = await loadListing(db, l._id);

    const messages = await chatMessages(l);
    const actions = [];
    let reply = "";
    for (let round = 0; round < CHAT_ROUNDS; round++) {
      const resp = await client.messages.create({ model: AI_MODEL, max_tokens: 2500, system: chatSystem(l), tools: [UPDATE_LISTING_TOOL, WRITE_LISTING_TOOL, SUGGEST_TOOL], messages });
      messages.push({ role: "assistant", content: resp.content });
      const text = (resp.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
      if (text) reply = text;
      const calls = (resp.content || []).filter((x) => x.type === "tool_use");
      if (!calls.length || resp.stop_reason !== "tool_use") break;
      const results = [];
      for (const c of calls) {
        let out;
        try {
          if (c.name === "update_listing") { out = await applyUpdateTool(db, l, c.input || {}, by); if (out.ok && out.changed.length) actions.push("updated"); }
          else if (c.name === "write_listing") { out = await applyWriteTool(db, l, c.input || {}, by); actions.push("wrote"); }
          else if (c.name === "suggest_details") {
            const sg = suggestionOf(c.input || {});
            if (sg) { await db.collection(LISTINGS).updateOne({ _id: l._id }, { $set: { pendingSuggestion: sg } }); actions.push("suggested"); out = { ok: true, waitingForStaff: suggestionLine(sg) }; }
            else out = { ok: false, error: "nothing to suggest" };
          }
          else out = { ok: false, error: "unknown tool" };
          l = await loadListing(db, l._id);
        } catch (e) { out = { ok: false, error: e.message }; }
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }
    if (!reply) reply = actions.includes("wrote") ? "The listing text is written — check it on the right." : "Noted.";
    await db.collection(LISTINGS).updateOne({ _id: l._id }, { $push: { chat: { $each: [{ role: "assistant", text: reply, actions: [...new Set(actions)], at: new Date() }], $slice: -CHAT_KEEP } } });
    l = await loadListing(db, l._id);
    return res.json({ success: true, listing: viewOf(l), reply, actions: [...new Set(actions)] });
  } catch (e) {
    const msg = (e && e.error && e.error.error && e.error.error.message) || (e && e.message) || "";
    if (e && e.status && e.status >= 400 && e.status < 500) return bad(res, `The assistant refused the request: ${msg}`, 502);
    next(e);
  }
});

module.exports = router;
module.exports.FAULT_STATES = FAULT_STATES;
module.exports.CONDITIONS = CONDITIONS;
