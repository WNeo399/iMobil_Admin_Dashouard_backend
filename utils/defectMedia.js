// Photos and videos of the defective devices for sale (2026-10-09). They live
// in their OWN bucket (user decision): S3_DEFECT_BUCKET_NAME, in
// S3_DEFECT_BUCKET_REGION (default S3_REGION), with the same key pair as the
// other buckets. Objects are public-read — the website shows them.
//
// Photos go through the server: re-encoded to JPEG (EXIF rotation honoured,
// at most 2000 px) plus a 480 px thumbnail. Videos are too big to pass
// through Railway, so the browser PUTs them straight to S3 on a signed URL
// (the bucket needs a CORS rule for that), and the server records the file
// once the upload is reported done.

const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const MAX_PHOTOS = 12;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 5 * 1024 * 1024;   // the browser shrinks or refuses bigger ones (2026-10-09)
const MAX_VIDEO_SECONDS = 10;
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const UPLOAD_URL_SECONDS = 15 * 60;

let client = null;
function region() {
  return process.env.S3_DEFECT_BUCKET_REGION || process.env.S3_REGION;
}
function bucket() {
  return process.env.S3_DEFECT_BUCKET_NAME || null;
}
function s3() {
  if (client) return client;
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !region()) return null;
  client = new S3Client({ region: region(), credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } });
  return client;
}
function isConfigured() {
  return !!(s3() && bucket());
}
const notConfigured = () => Object.assign(new Error("The media bucket isn't set up on the server (S3_DEFECT_BUCKET_NAME)."), { status: 503 });
const urlOf = (key) => `https://${bucket()}.s3.${region()}.amazonaws.com/${key}`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const folder = (listingNo) => `listings/${String(listingNo || "draft").replace(/[^\w-]/g, "")}`;

// Photos: field "photos", several per request, any image/* sharp reads.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS },
  fileFilter: (req, file, cb) => (/^image\//i.test(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error(`${file.originalname}: only image files`), { badType: true }))),
});
function acceptPhotos(req, res, next) {
  photoUpload.array("photos", MAX_PHOTOS)(req, res, (err) => {
    if (!err) return next();
    const message = err.badType ? err.message
      : err.code === "LIMIT_FILE_SIZE" ? "Each photo must be 25 MB or smaller"
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Up to ${MAX_PHOTOS} photos at a time`
          : "Could not read the photos";
    return res.status(400).json({ success: false, message });
  });
}
// One image, field "poster" — a video's cover frame, captured in the browser.
const posterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => (/^image\//i.test(file.mimetype) ? cb(null, true) : cb(new Error("Only image files are accepted"))) });
function acceptPoster(req, res, next) {
  posterUpload.single("poster")(req, res, (err) => (err ? res.status(400).json({ success: false, message: err.message }) : next()));
}

// Re-encode and store a photo (or a poster) — the media record kept on the listing.
async function storePhoto(file, listingNo, kind = "photo") {
  if (!isConfigured()) throw notConfigured();
  let full;
  try {
    full = await sharp(file.buffer).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
  } catch (e) {
    throw Object.assign(new Error(`${file.originalname || "The file"} is not an image we can read`), { status: 400 });
  }
  const thumb = await sharp(full).resize(480, 480, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  const meta = await sharp(full).metadata();
  const id = newId();
  const key = `${folder(listingNo)}/${id}.jpg`;
  const thumbKey = `${folder(listingNo)}/${id}-thumb.jpg`;
  const c = s3();
  const put = (Key, Body) => c.send(new PutObjectCommand({ Bucket: bucket(), Key, Body, ContentType: "image/jpeg", CacheControl: "public, max-age=31536000, immutable" }));
  await put(key, full);
  await put(thumbKey, thumb);
  return {
    id, kind, key, url: urlOf(key), thumbKey, thumbUrl: urlOf(thumbKey),
    name: String(file.originalname || "").slice(0, 140),
    width: meta.width || null, height: meta.height || null, size: full.length,
    addedAt: new Date(),
  };
}

// A signed PUT the browser uploads a video to. { id, key, url, expiresAt }
async function presignVideo({ listingNo, contentType, size }) {
  if (!isConfigured()) throw notConfigured();
  const ext = VIDEO_TYPES[String(contentType || "").toLowerCase()];
  if (!ext) throw Object.assign(new Error("Videos must be mp4, mov or webm"), { status: 400 });
  const bytes = Number(size) || 0;
  if (bytes <= 0) throw Object.assign(new Error("The video's size is missing"), { status: 400 });
  if (bytes > MAX_VIDEO_BYTES) throw Object.assign(new Error(`A video must be ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB or smaller`), { status: 400 });
  const id = newId();
  const key = `${folder(listingNo)}/${id}.${ext}`;
  // Only the Content-Type is signed: every signed header is one the browser
  // must send on the PUT, and the bucket's CORS must allow it.
  const url = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: UPLOAD_URL_SECONDS });
  return { id, key, url, contentType, expiresAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000) };
}

// Is the uploaded video really there? { size, contentType } or null.
async function headObject(key) {
  if (!isConfigured()) throw notConfigured();
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: r.ContentLength || 0, contentType: r.ContentType || "" };
  } catch (e) {
    return null;
  }
}

// Best effort — the listing forgets the file either way.
async function removeObject(key) {
  if (!key || !isConfigured()) return;
  try { await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })); } catch (e) { /* left in the bucket */ }
}

module.exports = {
  MAX_PHOTOS, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS, VIDEO_TYPES,
  isConfigured, bucket, region, urlOf,
  acceptPhotos, acceptPoster, storePhoto, presignVideo, headObject, removeObject,
};
