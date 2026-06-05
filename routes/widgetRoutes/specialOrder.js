// POST /widget/specialOrder
//
// Receives a submission from the Special Order widget (embedded on
// third-party customer sites). Processes images server-side, archives
// to S3, persists to MongoDB.
//
// Body (multipart/form-data):
//   name         string, required, ≤200 chars
//   description  string, required, ≤5000 chars
//   _company     honeypot — silently dropped if filled
//   images       file[], 0–10 images, image/* MIME, ≤10MB each before
//                processing
//
// Response (always JSON):
//   { success: true, id: "<mongo _id>", imageCount: <n> }
//   { success: true, dropped: true }                     // honeypot hit
//   { success: false, message: "..." }                    // anything else

var express = require("express");
var multer = require("multer");
var crypto = require("crypto");
var sharp = require("sharp");
var router = express.Router();
const {
  S3Client,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "imb_special_orders";

// ── Limits ─────────────────────────────────────────────────────────
// Per-image cap: matches the widget's client-side check so a sneaky
// curl call can't push 100MB files. Multer enforces both per-file
// size AND a total file count.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB raw
const MAX_IMAGES = 10;
const MAX_NAME_LEN = 200;
const MAX_DESCRIPTION_LEN = 5000;
// Image processing targets — kept slightly larger than the widget's
// client-side compression (1600px @ q0.82) so a customer uploading
// from a desktop site with no client compression still ends up with
// reasonable archive sizes.
const PROCESSED_MAX_EDGE = 2400;
const PROCESSED_JPEG_QUALITY = 85;
const THUMBNAIL_EDGE = 300;
const THUMBNAIL_JPEG_QUALITY = 75;

// S3 key prefix matching the folder the customer created in the
// bucket. Leading slash omitted (S3 keys aren't paths and a leading
// slash creates an empty-name "directory" in the console).
const S3_PREFIX = "Special Order Images/";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: MAX_IMAGES,
    // Loose body field cap to defend against absurd payloads.
    fields: 20,
    fieldSize: MAX_DESCRIPTION_LEN * 2,
  },
  fileFilter(req, file, cb) {
    // Trust MIME for routing only — sharp will reject anything that
    // isn't actually an image on the processing pass.
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error(`Unsupported image type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ── S3 client (lazy) ───────────────────────────────────────────────
// Same lazy-build pattern as creditNoteRoutes/index.js so a misconfigured
// env doesn't crash the whole backend at boot.
let _s3 = null;
function getS3Client() {
  if (_s3) return _s3;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    return null;
  }
  _s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _s3;
}

function getBucketName() {
  // Allow a dedicated widget bucket but fall back to the credit-note
  // bucket since the user mentioned they created the "Special Order
  // Images" folder inside the existing bucket.
  return (
    process.env.S3_WIDGET_BUCKET_NAME ||
    process.env.S3_CREDIT_BUCKET_NAME ||
    null
  );
}

// ── Origin allowlist (shared with router) ──────────────────────────
// Imported lazily to avoid a circular dep with index.js.
function isAllowedOrigin(req) {
  // eslint-disable-next-line global-require
  const parent = require("./index");
  const allowed = parent.allowedOrigins || [];
  if (allowed.length === 0) return false;
  const origin = req.get("Origin");
  if (origin && allowed.includes(origin)) return true;
  // Some embeds (e.g. file:// pages, certain WebView wrappers)
  // don't send Origin but do send Referer. Match its origin half
  // against the allowlist as a fallback.
  const referer = req.get("Referer");
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (allowed.includes(refOrigin)) return true;
    } catch {
      // Malformed Referer — treat as unauthenticated.
    }
  }
  return false;
}

// ── Handler ────────────────────────────────────────────────────────
router.post("/", upload.array("images", MAX_IMAGES), async function (req, res) {
  try {
    // 1. Origin check. CORS already filtered the browser case; this
    //    rejects non-browser callers (curl, scripts) too.
    if (!isAllowedOrigin(req)) {
      console.warn(
        `[specialOrder] rejected submission from origin=${req.get("Origin")} referer=${req.get("Referer")}`,
      );
      return res
        .status(403)
        .json({ success: false, message: "Origin not allowed" });
    }

    const body = req.body || {};

    // 2. Honeypot. Real users never see `_company`; if it's filled,
    //    return success without persisting so the bot moves on
    //    instead of probing for other endpoints.
    if (body._company && String(body._company).trim()) {
      console.warn(
        `[specialOrder] honeypot hit from ip=${req.ip} origin=${req.get("Origin")}`,
      );
      return res.json({ success: true, dropped: true });
    }

    // 3. Validate text fields. Trim everything so trailing whitespace
    //    doesn't sneak into the persisted record.
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required" });
    }
    if (name.length > MAX_NAME_LEN) {
      return res.status(400).json({
        success: false,
        message: `Name must be ${MAX_NAME_LEN} characters or fewer`,
      });
    }
    if (!description) {
      return res
        .status(400)
        .json({ success: false, message: "Description is required" });
    }
    if (description.length > MAX_DESCRIPTION_LEN) {
      return res.status(400).json({
        success: false,
        message: `Description must be ${MAX_DESCRIPTION_LEN} characters or fewer`,
      });
    }

    const files = Array.isArray(req.files) ? req.files : [];

    // 4. Image processing pass — sharp re-encodes (strips EXIF) and
    //    generates a thumbnail. Failures on individual files skip
    //    that file rather than failing the whole submission; the
    //    text-only submission is still valuable.
    const bucket = getBucketName();
    const s3 = getS3Client();
    if (files.length > 0 && (!bucket || !s3)) {
      // Don't reject — files just won't be archived. Log loudly so
      // ops notices the misconfiguration.
      console.error(
        "[specialOrder] S3 env vars missing — images will not be archived. " +
          "Set S3_WIDGET_BUCKET_NAME (or S3_CREDIT_BUCKET_NAME) + S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY.",
      );
    }

    const datePrefix = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
    const persistedImages = [];

    if (files.length > 0 && bucket && s3) {
      for (const file of files) {
        try {
          const processed = await processImage(file.buffer);
          const id = crypto.randomBytes(8).toString("hex");
          const safeBase = sanitizeFilename(file.originalname);
          // Originals + thumbs co-located by date so a console
          // browse stays manageable as submissions pile up.
          const fullKey = `${S3_PREFIX}${datePrefix}/${id}-${safeBase}.jpg`;
          const thumbKey = `${S3_PREFIX}${datePrefix}/thumbs/${id}-${safeBase}.jpg`;
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: fullKey,
              Body: processed.full,
              ContentType: "image/jpeg",
            }),
          );
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: thumbKey,
              Body: processed.thumb,
              ContentType: "image/jpeg",
            }),
          );
          persistedImages.push({
            s3Key: fullKey,
            thumbnailKey: thumbKey,
            originalName: file.originalname,
            contentType: "image/jpeg",
            size: processed.full.length,
            width: processed.width,
            height: processed.height,
          });
        } catch (e) {
          // Per-file failure — log and move on. The Mongo record
          // captures whichever images did make it through.
          console.warn(
            `[specialOrder] dropped image "${file.originalname}":`,
            e.message || e,
          );
        }
      }
    }

    // 5. Persist. Source metadata captured for audit (who submitted
    //    from where) without storing the request bodies themselves.
    const doc = {
      name,
      description,
      images: persistedImages,
      source: {
        origin: req.get("Origin") || null,
        referer: req.get("Referer") || null,
        ip:
          (req.headers["x-forwarded-for"] || "")
            .split(",")[0]
            .trim() || req.ip || null,
        userAgent: req.get("User-Agent") || null,
      },
      status: "new", // new | reviewed | fulfilled | rejected
      createdAt: new Date(),
    };

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).insertOne(doc);

    return res.json({
      success: true,
      id: String(result.insertedId),
      imageCount: persistedImages.length,
    });
  } catch (error) {
    // Multer file-size / file-count rejections land here with their
    // own .code; surface a usable message instead of the raw error.
    if (error && error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: `One of your images is larger than ${MAX_IMAGE_BYTES / 1024 / 1024}MB. Please pick a smaller file.`,
      });
    }
    if (error && error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        message: `Too many images — max ${MAX_IMAGES} per submission.`,
      });
    }
    console.error("[specialOrder] error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Submission failed",
    });
  }
});

// ── Image helpers ──────────────────────────────────────────────────

// Process an uploaded image into a re-encoded full-size copy and a
// thumbnail. Always returns JPEG so downstream storage / display
// doesn't need to branch on format. `rotate()` is called first so
// the auto-orientation EXIF tag is applied before `.jpeg()` strips
// all metadata — without it, a portrait phone photo would land
// sideways in the archive.
async function processImage(buffer) {
  const pipeline = sharp(buffer, { failOn: "none" }).rotate();
  const metadata = await pipeline.metadata();
  const [full, thumb] = await Promise.all([
    pipeline
      .clone()
      .resize({
        width: PROCESSED_MAX_EDGE,
        height: PROCESSED_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: PROCESSED_JPEG_QUALITY, mozjpeg: true })
      .toBuffer(),
    pipeline
      .clone()
      .resize({
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
        fit: "cover",
      })
      .jpeg({ quality: THUMBNAIL_JPEG_QUALITY, mozjpeg: true })
      .toBuffer(),
  ]);
  return {
    full,
    thumb,
    width: metadata.width || null,
    height: metadata.height || null,
  };
}

// Strip the original filename down to something safe for an S3 key:
// drop the extension, replace anything non-alphanumeric / non-dash /
// non-underscore with a dash, and truncate. The random id added in
// the key carries uniqueness; this is purely cosmetic so a console
// browse stays readable.
function sanitizeFilename(name) {
  const base = String(name || "image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return base || "image";
}

module.exports = router;
