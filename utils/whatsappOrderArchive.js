// On WhatsApp special-order session completion, archive everything
// the customer sent into the SAME imb_special_orders collection the
// embeddable Special Order widget feeds. Single review surface in the
// dashboard handles both channels — see views/imobile/specialOrder
// on the frontend.
//
// Two reasons we run this on completion rather than per-message:
//   1. Twilio media URLs only stay valid for ~24 hours. We download
//      and re-host on S3 before they expire so the admin review
//      screen doesn't gradually fill with broken image links.
//   2. The widget side runs sharp (EXIF strip + thumbnail) on every
//      image. Doing the same here keeps the two schemas identical
//      so the existing admin gallery just works.

const axios = require("axios");
const crypto = require("crypto");
const sharp = require("sharp");
const {
  S3Client,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { connectToDatabase } = require("./mongodb");

const SPECIAL_ORDERS_COLLECTION = "imb_special_orders";
// Same bucket the widget order endpoint uses; falls back through the
// credit-note bucket since you confirmed they share the bucket.
function getBucketName() {
  return (
    process.env.S3_WIDGET_BUCKET_NAME ||
    process.env.S3_CREDIT_BUCKET_NAME ||
    null
  );
}

// Sub-prefix under the shared "Special Order Images/" folder so a
// console browse can tell at a glance which channel each order came
// from. The widget side writes directly under Special Order Images/.
const S3_PREFIX = "Special Order Images/whatsapp/";

// Sharp processing targets — copied verbatim from
// routes/widgetRoutes/specialOrder.js so the two channels produce
// identically-sized archives + thumbnails.
const PROCESSED_MAX_EDGE = 2400;
const PROCESSED_JPEG_QUALITY = 85;
const THUMBNAIL_EDGE = 300;
const THUMBNAIL_JPEG_QUALITY = 75;

let _s3 = null;
function getS3Client() {
  if (_s3) return _s3;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) return null;
  _s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _s3;
}

/**
 * Persist a completed WhatsApp special-order session into
 * imb_special_orders.
 *
 * `session` is the imb_whatsapp_session document with collected
 * description + images. This function:
 *   1. Downloads each media URL from Twilio (Basic Auth required —
 *      the URLs aren't public).
 *   2. Processes each through sharp into a full-size JPEG + a
 *      thumbnail (same pipeline as the widget endpoint).
 *   3. Uploads both to S3 under "Special Order Images/whatsapp/<yyyy-mm-dd>/".
 *   4. Inserts an imb_special_orders row carrying the s3 keys + a
 *      `source: { channel: 'whatsapp', ... }` discriminator.
 *
 * Returns the inserted document id on success. Throws on persistent
 * failure (e.g. S3 misconfigured); per-image download / processing
 * failures are logged and skipped so a single bad media URL doesn't
 * lose the whole order.
 */
async function archiveSessionAsSpecialOrder(session) {
  if (!session || !session.waId) {
    throw new Error("archiveSessionAsSpecialOrder: invalid session");
  }
  const collectedImages = (session.collected && session.collected.images) || [];

  const bucket = getBucketName();
  const s3 = getS3Client();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const persistedImages = [];

  if (collectedImages.length > 0 && (!bucket || !s3)) {
    // Don't reject the order — the text portion is still valuable.
    // Log loudly so ops notices the misconfiguration.
    console.error(
      "[whatsappArchive] S3 env missing — images will not be archived. " +
        "Set S3_WIDGET_BUCKET_NAME (or S3_CREDIT_BUCKET_NAME) + S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY.",
    );
  }

  if (bucket && s3) {
    for (const img of collectedImages) {
      if (!img || !img.twilioUrl) continue;
      try {
        const buffer = await downloadTwilioMedia(img.twilioUrl);
        const processed = await processImage(buffer);
        const id = crypto.randomBytes(8).toString("hex");
        const fullKey = `${S3_PREFIX}${datePrefix}/${id}.jpg`;
        const thumbKey = `${S3_PREFIX}${datePrefix}/thumbs/${id}.jpg`;
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
          originalName: `whatsapp-${id}.jpg`,
          contentType: "image/jpeg",
          size: processed.full.length,
          width: processed.width,
          height: processed.height,
          sourceTwilioUrl: img.twilioUrl,
          sourceContentType: img.contentType || null,
        });
      } catch (e) {
        // Single-image failure — log + move on. The Mongo record
        // captures whatever did make it.
        console.warn(
          `[whatsappArchive] dropped image ${img.twilioUrl}:`,
          e.message || e,
        );
      }
    }
  }

  // Source shape mirrors the widget endpoint's
  // routes/widgetRoutes/specialOrder.js — { origin, referer, ip,
  // userAgent } — so the admin review page can read source.origin /
  // source.ip uniformly across both channels. Without this the
  // "From" row in the dialog was empty for WhatsApp records.
  // WhatsApp-specific fields (channel, waId, etc.) sit alongside
  // for downstream consumers that branch on channel.
  const source = {
    origin: buildOriginLabel(session),
    referer: null,
    ip: null,
    userAgent: null,
    // WhatsApp-specific extras
    channel: "whatsapp",
    waId: session.waId,
    from: session.from || null,
    profileName: session.profileName || null,
    sessionId: session._id || null,
  };

  const doc = {
    name: session.profileName || `WhatsApp ${session.waId}`,
    description: (session.collected && session.collected.description) || "",
    images: persistedImages,
    source,
    status: "new",
    createdAt: new Date(),
  };

  const db = await connectToDatabase();
  const result = await db.collection(SPECIAL_ORDERS_COLLECTION).insertOne(doc);
  return result.insertedId;
}

// Build a humanly-meaningful string for the admin page's "From"
// column. Strips the "whatsapp:" prefix off the channel address so
// it reads as a phone number, and prepends the customer's profile
// name when WhatsApp gave us one. Falls back gracefully when
// profileName is empty.
//
//   { profileName: 'John', from: 'whatsapp:+15551234567' }
//     → "WhatsApp · John (+15551234567)"
//   { profileName: null,  from: 'whatsapp:+15551234567' }
//     → "WhatsApp (+15551234567)"
//   { profileName: null,  from: null, waId: '15551234567' }
//     → "WhatsApp (+15551234567)"
function buildOriginLabel(session) {
  let number = "";
  if (session.from) {
    number = String(session.from).replace(/^whatsapp:/i, "");
  } else if (session.waId) {
    number = `+${session.waId}`;
  }
  const numPart = number ? ` (${number})` : "";
  if (session.profileName) {
    return `WhatsApp · ${session.profileName}${numPart}`;
  }
  return `WhatsApp${numPart}`;
}

// Twilio media URLs require HTTP Basic Auth using AccountSid +
// AuthToken. Returns the raw bytes as a Buffer.
async function downloadTwilioMedia(url) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  }
  const res = await axios.get(url, {
    auth: { username: sid, password: token },
    responseType: "arraybuffer",
    // Generous timeout — Twilio's media CDN is generally fast but a
    // chunky video can take a second or two.
    timeout: 30000,
    // Follow redirects (Twilio responds 307 from the URL we get into
    // a regional CDN).
    maxRedirects: 5,
  });
  return Buffer.from(res.data);
}

// Sharp pipeline — mirrors routes/widgetRoutes/specialOrder.js so the
// widget + whatsapp channels produce identically-sized archives.
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

module.exports = { archiveSessionAsSpecialOrder };
