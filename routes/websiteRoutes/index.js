// iMobile Website — content managed for the iMobile storefront
// (Mongo: imb_web_banners). First page: the banner carousel.
//
// A banner is three images — desktop, tablet and mobile phone — plus an
// optional link. The active banners, in their saved order, are served to
// the embeddable carousel via routes/widgetRoutes/bannerCarousel.js; this
// file is the authenticated management side.
//
//   GET    /website/banners             list, in carousel order
//   POST   /website/banners             create (multipart: desktop, tablet,
//                                       mobile images + title/link/newTab/active)
//   PUT    /website/banners/order       save the order { ids: [...] }
//   PUT    /website/banners/:id         update fields; any image may be
//                                       replaced (multipart, same names)
//   DELETE /website/banners/:id         delete (S3 objects best-effort)
//   PUT    /website/banner-settings     the carousel's max height / width
//                                       (utils/webBannerSettings)
//
// web:banner:view reads, web:banner:manage writes (admin + iMobile Admin).
//
// Uploads are re-encoded to WebP and capped in width per device, so a
// designer's 8 MB PNG doesn't land on the storefront as-is.

var express = require("express");
var router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const { ObjectId } = require("mongodb");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { getCarouselSettings, saveCarouselSettings } = require("../../utils/webBannerSettings");

const VIEW = requirePermission("web:banner:view");
const MANAGE = requirePermission("web:banner:manage");
const BANNERS = "imb_web_banners";

// Widest stored image per device — beyond this the extra pixels only cost
// the shopper download time.
const DEVICES = { desktop: 2560, tablet: 1600, mobile: 1200 };
const DEVICE_KEYS = Object.keys(DEVICES);

// ── S3 (same lazy-singleton pattern as the other upload routes) ─────
let s3Client = null;
function getS3Client() {
  if (s3Client) return s3Client;
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) return null;
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  return s3Client;
}
// The public widget bucket (the exploded-diagram images live there too).
function getBucketName() {
  return process.env.S3_WIDGET_BUCKET_NAME || process.env.S3_CREDIT_BUCKET_NAME || null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    if (!DEVICE_KEYS.includes(file.fieldname)) return cb(new Error(`Unexpected file field "${file.fieldname}"`));
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only PNG, JPEG or WebP images are accepted"));
  },
});

// Multer errors (size/MIME) come back as a clean 400, not a 500.
function handleUpload(req, res) {
  return new Promise((resolve) => {
    upload.fields(DEVICE_KEYS.map((name) => ({ name, maxCount: 1 })))(req, res, (err) => resolve(err || null));
  });
}

function filesOf(req) {
  const out = {};
  for (const d of DEVICE_KEYS) {
    const f = req.files && req.files[d] && req.files[d][0];
    if (f) out[d] = f;
  }
  return out;
}

function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}
function bool(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  return v === true || v === "true" || v === "1" || v === 1;
}

// The link lands in an <a href> on the storefront, so only web links and
// site-relative paths pass — never javascript:/data: URLs.
function cleanLink(v) {
  const s = str(v, 1000);
  if (!s) return "";
  if (/^\/(?!\/)/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch (e) { /* falls through */ }
  const err = new Error("The link must start with https://, http:// or / (a page on the same site)");
  err.status = 400;
  throw err;
}

// Re-encode one upload for its device and store it; returns the image
// descriptor kept on the banner.
async function storeImage(bannerId, device, file) {
  const s3 = getS3Client();
  const bucket = getBucketName();
  if (!s3 || !bucket) throw new Error("S3 is not configured on the server");

  const { data, info } = await sharp(file.buffer)
    .rotate() // honour the camera/phone orientation flag
    .resize({ width: DEVICES[device], withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error(`Could not read the ${device} image`);

  const key = `website-banners/${bannerId}/${device}-${Date.now()}.webp`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: "image/webp",
      // Every replacement gets a new key, so the file itself never changes.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return {
    key,
    url: `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`,
    width: info.width,
    height: info.height,
    size: data.length,
    originalName: str(file.originalname, 200),
  };
}

async function deleteImages(images) {
  const s3 = getS3Client();
  const bucket = getBucketName();
  if (!s3 || !bucket) return;
  for (const img of images) {
    if (!img || !img.key) continue;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: img.key }));
    } catch (e) {
      // The doc is the source of truth — a dangling S3 object is only waste.
      console.warn("Banner S3 delete failed:", (e && e.message) || e);
    }
  }
}

function who(req) {
  return (req.user && req.user.username) || null;
}

// ── GET /website/banners ────────────────────────────────────────────
router.get("/banners", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const rows = await db.collection(BANNERS).find({}).sort({ order: 1, createdAt: 1 }).limit(200).toArray();
    return res.json({ success: true, rows, settings: await getCarouselSettings(db) });
  } catch (e) {
    console.error("Banner list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the banners" });
  }
});

// ── POST /website/banners ───────────────────────────────────────────
router.post("/banners", MANAGE, async (req, res) => {
  let stored = [];
  try {
    const uploadErr = await handleUpload(req, res);
    if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
    const files = filesOf(req);
    const missing = DEVICE_KEYS.filter((d) => !files[d]);
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing the ${missing.join(", ")} image` });
    }
    const title = str(req.body.title, 160);
    if (!title) return res.status(400).json({ success: false, message: "A title is required" });
    const link = cleanLink(req.body.link);

    const _id = new ObjectId();
    const images = {};
    for (const d of DEVICE_KEYS) {
      images[d] = await storeImage(_id, d, files[d]);
      stored.push(images[d]);
    }

    const db = await connectToDatabase();
    // New banners go to the end of the carousel.
    const last = await db.collection(BANNERS).find({}).sort({ order: -1 }).limit(1).next();
    const now = new Date();
    const doc = {
      _id,
      title,
      link,
      newTab: bool(req.body.newTab, false),
      active: bool(req.body.active, true),
      order: last && Number.isFinite(last.order) ? last.order + 1 : 0,
      images,
      createdAt: now,
      createdBy: who(req),
      updatedAt: now,
      updatedBy: who(req),
    };
    await db.collection(BANNERS).insertOne(doc);
    stored = [];
    return res.json({ success: true, banner: doc });
  } catch (e) {
    await deleteImages(stored);
    if (e.status === 400) return res.status(400).json({ success: false, message: e.message });
    console.error("Banner create error:", e);
    return res.status(500).json({ success: false, message: e.message || "Failed to create the banner" });
  }
});

// ── PUT /website/banners/order ──────────────────────────────────────
// Registered before /banners/:id so "order" isn't read as an id.
router.put("/banners/order", MANAGE, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : null;
    if (!ids || !ids.length || ids.some((id) => !ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: "ids must be a list of banner ids" });
    }
    const db = await connectToDatabase();
    const now = new Date();
    await db.collection(BANNERS).bulkWrite(
      ids.map((id, i) => ({
        updateOne: {
          filter: { _id: new ObjectId(id) },
          update: { $set: { order: i, updatedAt: now, updatedBy: who(req) } },
        },
      })),
    );
    return res.json({ success: true });
  } catch (e) {
    console.error("Banner order error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the order" });
  }
});

// ── PUT /website/banners/:id ────────────────────────────────────────
// JSON for field-only edits (the Active switch); multipart when images
// come along.
router.put("/banners/:id", MANAGE, async (req, res) => {
  let stored = [];
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    if (req.is("multipart/form-data")) {
      const uploadErr = await handleUpload(req, res);
      if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const banner = await db.collection(BANNERS).findOne({ _id });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found" });

    const body = req.body || {};
    const set = { updatedAt: new Date(), updatedBy: who(req) };
    if (body.title !== undefined) {
      const title = str(body.title, 160);
      if (!title) return res.status(400).json({ success: false, message: "A title is required" });
      set.title = title;
    }
    if (body.link !== undefined) set.link = cleanLink(body.link);
    if (body.newTab !== undefined) set.newTab = bool(body.newTab, false);
    if (body.active !== undefined) set.active = bool(body.active, true);

    const files = filesOf(req);
    const replaced = [];
    for (const d of DEVICE_KEYS) {
      if (!files[d]) continue;
      const img = await storeImage(_id, d, files[d]);
      stored.push(img);
      set[`images.${d}`] = img;
      if (banner.images && banner.images[d]) replaced.push(banner.images[d]);
    }

    const updated = await db.collection(BANNERS).findOneAndUpdate(
      { _id },
      { $set: set },
      { returnDocument: "after" },
    );
    stored = [];
    await deleteImages(replaced);
    return res.json({ success: true, banner: updated && (updated.value || updated) });
  } catch (e) {
    await deleteImages(stored);
    if (e.status === 400) return res.status(400).json({ success: false, message: e.message });
    console.error("Banner update error:", e);
    return res.status(500).json({ success: false, message: e.message || "Failed to update the banner" });
  }
});

// ── PUT /website/banner-settings ────────────────────────────────────
router.put("/banner-settings", MANAGE, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const settings = await saveCarouselSettings(db, req.body, who(req));
    return res.json({ success: true, settings });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ success: false, message: e.message });
    console.error("Banner settings error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the settings" });
  }
});

// ── DELETE /website/banners/:id ─────────────────────────────────────
router.delete("/banners/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const banner = await db.collection(BANNERS).findOne({ _id });
    if (!banner) return res.status(404).json({ success: false, message: "Banner not found" });
    await db.collection(BANNERS).deleteOne({ _id });
    await deleteImages(Object.values(banner.images || {}));
    return res.json({ success: true });
  } catch (e) {
    console.error("Banner delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the banner" });
  }
});

module.exports = router;
