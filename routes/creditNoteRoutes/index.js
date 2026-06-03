// Credit Note OCR ingestion — accepts a client-uploaded PDF, forwards
// it to HandwritingOCR's documents API (using the bearer token from
// .env so the credential never leaves the server), and in parallel
// archives a copy of the same PDF into our S3 credit-note bucket so
// every submitted document has a durable, browsable history.
//
// Mirrors the n8n HTTP Request node at desktop/html/ocr.json:
//   POST /v3/documents
//   file (binary)
//   action = "extractor"
//   extractor_id = "Newvjr8bJiwk"
//
// Auth: gated by zoho:salesOrder:create — same permission the other
// Tools-page endpoints (Buzztech, Location Monitoring) require, so the
// roles that can already use the Tools page also get this endpoint
// without a new permission entry.

var express = require("express");
var axios = require("axios");
var multer = require("multer");
var FormData = require("form-data");
var router = express.Router();
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

// Persistence layer — every successful submit gets a row here so we
// can correlate the OCR document id back to its S3 archive copy
// without re-querying either upstream. Schema is intentionally narrow
// to start with: ocrId, status, s3Key. Extra audit fields can be
// layered on later without a migration.
const CREDIT_NOTE_COLLECTION = "imb_credit_note";

const HANDWRITING_OCR_URL = "https://api.handwritingocr.com/v3/documents";
const EXTRACTOR_ID = "Newvjr8bJiwk";
// Callback URL passed to HandwritingOCR on every submit so the
// extractor knows where to POST its result when processing finishes.
// Points at our public /webhook/creditNoteOcr handler (mounted in
// app.js outside the authenticated chain). Keep this in sync with the
// app's deployed hostname — if the backend moves, OCR will silently
// stop calling back.
const OCR_WEBHOOK_URL = "https://imbadmin.up.railway.app/webhook/creditNoteOcr";

// Kill-switch for the OCR forward. Left in place even though it's `true`
// today because flipping to `false` to test S3 in isolation is useful
// again whenever the OCR endpoint changes shape. The route's response
// shape stays the same in both modes — the `ocr` field carries
// `{ ok: false, skipped: true }` while this flag is off, so the
// frontend can tell whether OCR was actually attempted.
const OCR_ENABLED = true;
// 25 MB cap mirrors the frontend's per-image raw cap; the generated
// PDF is usually well under this because we re-compress images to
// JPEG before adding them.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const GATE = requirePermission("zoho:salesOrder:create");

// ── S3 client (lazy) ────────────────────────────────────────────────
// Built on first use so an absent env var doesn't crash the module at
// load time — the request handler can still return a clean error if
// the credentials are missing instead of taking the whole route down.
let cachedS3Client = null;
function getS3Client() {
  if (cachedS3Client) return cachedS3Client;
  const {
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_REGION,
  } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) return null;
  cachedS3Client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });
  return cachedS3Client;
}

// Slug a username so it's S3-key-safe. Used in the archive key so each
// upload is traceable back to the submitting user without doing a
// secondary lookup.
function userSlug(req) {
  const u = req && req.user && req.user.username;
  if (!u) return "unknown";
  return String(u)
    .replace(/[^a-z0-9-_]/gi, "")
    .toLowerCase() || "unknown";
}

// Upload the PDF buffer to the configured S3 bucket. Returns the
// { bucket, key } pair on success; throws on missing env / SDK error so
// the caller can record the failure in the response.
async function uploadPdfToS3(buffer, filename, req) {
  const client = getS3Client();
  if (!client) {
    throw new Error(
      "S3 credentials not configured — set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_REGION in .env",
    );
  }
  const bucket = process.env.S3_CREDIT_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_CREDIT_BUCKET_NAME is not configured in .env");
  }

  // Key shape: credit-notes/<YYYY-MM-DD>/<ISO-stamp>-<userSlug>-<rand>.pdf
  // Date partition keeps the bucket browseable by day; the timestamp +
  // 6-char random suffix avoids key collisions when two users submit in
  // the same second. The original filename is dropped on purpose — it
  // varies per build and adds nothing the timestamp doesn't already
  // give us.
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rnd = Math.random().toString(36).slice(2, 8);
  const key = `credit-notes/${day}/${stamp}-${userSlug(req)}-${rnd}.pdf`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: "application/pdf",
      // Tag the submitter on the object itself so audit / lifecycle
      // policies can filter without a separate lookup table.
      Metadata: {
        "uploaded-by": userSlug(req),
        "original-filename": String(filename || "credit-note.pdf").slice(0, 200),
      },
    }),
  );
  return { bucket, key };
}

// Forward the uploaded PDF to HandwritingOCR. Throws on any non-2xx so
// the caller can record the failure alongside the S3 outcome.
async function forwardToOcr(file) {
  const token = process.env.HANDWRITING_OCR_TOKEN;
  if (!token) {
    throw new Error(
      "HANDWRITING_OCR_TOKEN is not configured in the backend .env",
    );
  }
  const form = new FormData();
  form.append("file", file.buffer, {
    filename: file.originalname || "credit-note.pdf",
    contentType: file.mimetype || "application/pdf",
    knownLength: file.size,
  });
  form.append("action", "extractor");
  form.append("extractor_id", EXTRACTOR_ID);
  // Tells HandwritingOCR where to POST the extraction result. Without
  // this they'd fall back to whatever URL is configured in their
  // dashboard — explicit per-request is safer (and lets us change the
  // callback path without touching their UI).
  form.append("webhook_url", OCR_WEBHOOK_URL);

  const response = await axios.post(HANDWRITING_OCR_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${token}`,
    },
    // Generous timeout — the n8n flow has historically taken 10–30s
    // for a multi-page handwritten document.
    timeout: 120000,
    // Lift the default size caps so a 20MB PDF doesn't get rejected
    // before it leaves our server.
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return response.data;
}

router.post(
  "/submit",
  GATE,
  // multer's field name must match what the frontend sends ("data").
  // It gets renamed to "file" before forwarding to HandwritingOCR.
  upload.single("data"),
  async function (req, res) {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded — send the PDF under the `data` field.",
      });
    }

    // ── S3-only mode (OCR_ENABLED = false) ──────────────────────
    // Skip the OCR forward entirely; success / failure is decided
    // by the S3 upload alone so the operator can verify the archive
    // path in isolation. The `ocr` field still appears in the
    // response with `skipped: true` so the frontend can render an
    // appropriate "OCR disabled" message instead of pretending the
    // upload happened.
    if (!OCR_ENABLED) {
      const [s3Settled] = await Promise.allSettled([
        uploadPdfToS3(req.file.buffer, req.file.originalname, req),
      ]);
      const s3 =
        s3Settled.status === "fulfilled"
          ? { ok: true, bucket: s3Settled.value.bucket, key: s3Settled.value.key }
          : { ok: false, message: extractAwsMessage(s3Settled.reason) };

      const ocr = {
        ok: false,
        skipped: true,
        message: "OCR upload disabled (set OCR_ENABLED = true in routes/creditNoteRoutes/index.js to re-enable).",
      };

      if (!s3.ok) {
        console.error("S3 archive failed:", s3.message);
        return res.status(502).json({
          success: false,
          message: s3.message,
          ocr,
          s3,
        });
      }
      return res.json({ success: true, data: null, ocr, s3 });
    }

    // ── Normal mode (OCR + S3 in parallel) ──────────────────────
    // Treating them as independent operations means an S3 outage
    // doesn't block OCR processing (and vice versa) — the response
    // reports each outcome separately so the user knows exactly
    // what landed and what didn't.
    const [ocrSettled, s3Settled] = await Promise.allSettled([
      forwardToOcr(req.file),
      uploadPdfToS3(req.file.buffer, req.file.originalname, req),
    ]);

    const ocr =
      ocrSettled.status === "fulfilled"
        ? { ok: true, data: ocrSettled.value }
        : { ok: false, message: extractAxiosMessage(ocrSettled.reason) };
    const s3 =
      s3Settled.status === "fulfilled"
        ? { ok: true, bucket: s3Settled.value.bucket, key: s3Settled.value.key }
        : { ok: false, message: extractAwsMessage(s3Settled.reason) };

    if (!ocr.ok) {
      console.error("HandwritingOCR submit failed:", ocr.message);
    }
    if (!s3.ok) {
      console.error("S3 archive failed:", s3.message);
    }

    // Overall success is gated on OCR — that's the user-visible action.
    // S3 archive failures are surfaced as warnings rather than errors
    // so the OCR result is still reachable to the caller.
    if (!ocr.ok) {
      // Map common upstream codes to friendlier messages.
      let userMessage = ocr.message;
      const code = ocrSettled.reason && ocrSettled.reason.response && ocrSettled.reason.response.status;
      if (code === 401 || code === 403) {
        userMessage = "HandwritingOCR rejected the token. Check HANDWRITING_OCR_TOKEN in .env.";
      } else if (code === 413) {
        userMessage = "PDF is too large for HandwritingOCR. Reduce the number of pages or image quality.";
      }
      return res
        .status(code && code >= 400 ? code : 502)
        .json({ success: false, message: userMessage, ocr, s3 });
    }

    // Persist the (ocrId, status, s3Key) triple so the OCR job can be
    // reconciled back to its S3 archive copy later without a separate
    // join across the two upstreams. Wrapped in its own try/catch
    // because OCR + S3 already happened — a Mongo blip shouldn't make
    // the whole submit look like a failure. The outcome rides on the
    // response so the frontend can warn the user if the bookkeeping
    // row was missed.
    const mongo = await persistCreditNoteRecord({
      ocrData: ocr.data,
      s3Key: s3.ok ? s3.key : null,
    });

    return res.json({
      success: true,
      data: ocr.data,
      ocr,
      s3,
      mongo,
    });
  },
);

// Insert one row into imb_credit_note. Returns
//   { ok: true, _id }                — happy path
//   { ok: false, message }           — Mongo unreachable / write failed
// Never throws — the caller treats this as bookkeeping only.
async function persistCreditNoteRecord({ ocrData, s3Key }) {
  try {
    const db = await connectToDatabase();
    const doc = {
      ocrId: (ocrData && (ocrData.id || ocrData.document_id)) || null,
      status: (ocrData && ocrData.status) || null,
      s3Key: s3Key || null,
    };
    const result = await db.collection(CREDIT_NOTE_COLLECTION).insertOne(doc);
    return { ok: true, _id: String(result.insertedId) };
  } catch (e) {
    console.error("imb_credit_note insert failed:", e.message || e);
    return { ok: false, message: e.message || "Mongo insert failed" };
  }
}

// Pull the best human-readable message out of an axios error / generic Error.
function extractAxiosMessage(err) {
  if (!err) return "OCR submit failed";
  const body = err.response && err.response.data;
  if (body && typeof body === "object" && body.message) return body.message;
  if (typeof body === "string" && body) return body;
  return err.message || "OCR submit failed";
}

// AWS SDK v3 errors carry the metadata on $metadata + a name field; the
// message is usually self-explanatory.
function extractAwsMessage(err) {
  if (!err) return "S3 archive failed";
  if (err.name && err.message) return `${err.name}: ${err.message}`;
  return err.message || "S3 archive failed";
}

module.exports = router;
