// Photos on Spare Parts Purchase lines (user ask 2026-10-06): a New Product
// or Special Order has no Zoho item to take a picture from, so the person
// ordering it can attach one or more photos. Stored in S3 like the SQT case
// photos: re-encoded to a JPEG (EXIF rotation honoured, at most 1600 px),
// under spp-orders/<orderNo>/<id>.jpg.

const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const MAX_IMAGES = 6;

let client = null;
function s3() {
  if (client) return client;
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) return null;
  client = new S3Client({ region: S3_REGION, credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } });
  return client;
}
const bucket = () => process.env.S3_WIDGET_BUCKET_NAME || process.env.S3_CREDIT_BUCKET_NAME || null;

// One image per request, field "image", up to 15 MB, any image/* sharp reads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (/^image\//i.test(file.mimetype) ? cb(null, true) : cb(new Error("Only image files are accepted"))),
});
// multer's own errors (size, type) as a clean 400
function acceptImage(req, res, next) {
  upload.single("image")(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));
}

// Re-encode and store; returns the image record kept on the line, or throws
// with `status` set for a request-side problem.
async function storeImage(file, orderNo) {
  const c = s3();
  const b = bucket();
  if (!c || !b) throw Object.assign(new Error("S3 is not configured on the server"), { status: 500 });
  let jpeg;
  try {
    jpeg = await sharp(file.buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();
  } catch (e) {
    throw Object.assign(new Error("Could not read that image file"), { status: 400 });
  }
  const meta = await sharp(jpeg).metadata();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const key = `spp-orders/${String(orderNo || "line").replace(/[^\w-]/g, "")}/${id}.jpg`;
  await c.send(new PutObjectCommand({ Bucket: b, Key: key, Body: jpeg, ContentType: "image/jpeg", CacheControl: "public, max-age=86400" }));
  return {
    id,
    key,
    url: `https://${b}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`,
    name: String(file.originalname || "").slice(0, 140),
    width: meta.width || null,
    height: meta.height || null,
  };
}

// Best effort: the line forgets the image either way.
async function removeImage(key) {
  const c = s3();
  const b = bucket();
  if (!c || !b || !key) return;
  try { await c.send(new DeleteObjectCommand({ Bucket: b, Key: key })); } catch (e) { /* left in the bucket */ }
}

module.exports = { MAX_IMAGES, acceptImage, storeImage, removeImage };
