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
const { ObjectId } = require("mongodb");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const {
  handleZohoInventoryRequest,
  handleZohoInventoryPutRequest,
  handleZohoInventoryMultipartPostRequest,
  getViewData,
} = require("../../utils/zohoRequest");

// Zoho org + Analytics view ids used by the Zoho-side credit-note
// flow. The Analytics view is the user-provided fallback in case the
// Inventory list endpoint can't resolve a credit note number directly.
const ZOHO_ORG_ID = "746138234";
const ZOHO_WORKSPACE_ID = "1404913000003936002";
const ZOHO_CREDIT_NOTE_VIEW_ID = "1404913000003936107";

// Fixed catalogue item-ids the warehouse uses for the two sentinel
// SKUs in the OCR payload:
//   A9999 → Received Return Device
//   R9999 → Received Device for Repair
// Each entry in returnDevice / repairDevice becomes one Zoho line
// item pointing at the matching id, with the device model going into
// the line item's `description` so the credit note carries the model
// identification without needing a separate product per model.
const ZOHO_ITEM_ID_RETURN_DEVICE = "2591985000341408805";
const ZOHO_ITEM_ID_REPAIR_DEVICE = "2591985000341408783";

// Location the credit note is booked against. This org runs Zoho
// Inventory's "Locations" model, so it's `location_id` both at the
// root of the credit note AND on each line item (the older
// `warehouse_id` field is rejected as "Invalid Element warehouse id").
const ZOHO_CREDIT_NOTE_LOCATION_ID = "2591985000065610085";
// Kept as a separate constant for the line-item stamp in case the
// per-line location ever needs to differ from the root.
const ZOHO_CREDIT_NOTE_WAREHOUSE_ID = "2591985000065610085";

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
const OCR_WEBHOOK_URL = "https://imbadmin-back.up.railway.app/webhook/creditNoteOcr";

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
      // Stamped server-side so the Credit Note list page has a
      // reliable sort key. Existing rows from before this field
      // existed sort to the bottom (null < every date) — fine.
      createdAt: new Date(),
    };
    const result = await db.collection(CREDIT_NOTE_COLLECTION).insertOne(doc);
    return { ok: true, _id: String(result.insertedId) };
  } catch (e) {
    console.error("imb_credit_note insert failed:", e.message || e);
    return { ok: false, message: e.message || "Mongo insert failed" };
  }
}

// ── GET /creditNote/list ─────────────────────────────────────────────
// Paginated list for the Credit Note page. Accepts:
//   ?status=<queued|processed|completed>  optional status filter
//   ?search=<creditNo substring>          optional case-insensitive
//                                          regex match on creditNo
//   ?page=N&pageSize=M                    standard paging
//
// Returns { success, data, total, counts } where `counts` is per-status
// (queued / processed / completed + an `all` rollup). Counts respect the
// search filter so the tree badges update as the user types, but ignore
// the status filter so picking one status doesn't hide the others.
router.get("/list", GATE, async function (req, res) {
  try {
    const { status, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(CREDIT_NOTE_COLLECTION);

    // baseFilter = search only (used for the counts rollup).
    // fullFilter = baseFilter + status (used for the visible page).
    const baseFilter = {};
    if (search) {
      // Escape regex metacharacters so a "+" or "." in a creditNo can't
      // turn the search into an unexpected pattern.
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      baseFilter.creditNo = { $regex: safe, $options: "i" };
    }
    const fullFilter = { ...baseFilter };
    if (status) fullFilter.status = String(status);

    const [data, total, countsRaw] = await Promise.all([
      collection
        .find(fullFilter)
        // createdAt desc with _id as tiebreaker — old rows without
        // createdAt drop to the bottom of the list, new rows surface
        // at the top in insert order.
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(fullFilter),
      collection
        .aggregate([
          { $match: baseFilter },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const counts = { all: 0, queued: 0, processed: 0, completed: 0 };
    for (const c of countsRaw) {
      const key = c._id || "unknown";
      counts[key] = c.count;
      counts.all += c.count;
    }

    return res.json({
      success: true,
      data,
      total,
      page,
      pageSize,
      counts,
    });
  } catch (error) {
    console.error("List credit notes error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to list credit notes" });
  }
});

// ── PATCH /creditNote/:id ───────────────────────────────────────────
// Partial-update endpoint for the small set of OCR-extracted fields the
// user is allowed to correct from the Review dialog before submitting
// to Zoho — currently:
//   - creditNo        (the parcel/credit-note number; OCR misreads happen)
//   - items[]         (specifically the per-row sku, when OCR garbles it
//                      or splits a row incorrectly)
//
// Anything else on the row stays untouched. Items are replaced as a
// whole array — the frontend always sends the current full list, so
// last-write-wins is fine and avoids per-index merge complexity.
//
// Returns the updated row so the caller can sync its local cache
// without a second round-trip.
router.patch("/:id", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const body = req.body || {};
    const update = {};

    // creditNo: trim + non-empty check. Empty string is rejected
    // because every downstream consumer (Zoho lookup, list filter)
    // assumes a non-empty string and silently mis-behaves with "".
    if (Object.prototype.hasOwnProperty.call(body, "creditNo")) {
      const cn = String(body.creditNo || "").trim();
      if (!cn) {
        return res.status(400).json({
          success: false,
          message: "creditNo cannot be empty",
        });
      }
      update.creditNo = cn;
    }

    // items: array of {sku, model?, quantity?}. We coerce each row to
    // the canonical shape and drop unknown fields so the persisted
    // documents stay consistent with what the OCR parser produces.
    // A missing items array means "don't touch items"; an empty array
    // is allowed (legitimate state for a credit note with no lines).
    if (Object.prototype.hasOwnProperty.call(body, "items")) {
      if (!Array.isArray(body.items)) {
        return res.status(400).json({
          success: false,
          message: "items must be an array",
        });
      }
      update.items = body.items.map((it) => {
        const sku = String((it && it.sku) || "").trim();
        const model =
          it && it.model != null && String(it.model).trim() !== ""
            ? String(it.model)
            : null;
        // Quantity stays string-typed to match what the OCR parser
        // produces — keeps the schema stable across rows that came in
        // via OCR and rows the user touched.
        const quantity =
          it && it.quantity != null ? String(it.quantity) : "0";
        return { sku, model, quantity };
      });
      // Recompute itemCount whenever items changes so the list page's
      // Items column stays in sync without a separate write.
      update.itemCount = update.items.length;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Nothing to update — provide creditNo and/or items",
      });
    }

    update.updatedAt = new Date();

    const db = await connectToDatabase();
    const collection = db.collection(CREDIT_NOTE_COLLECTION);
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" },
    );
    // The Node driver's findOneAndUpdate returns either a doc directly
    // (newer driver) or { value: doc } (older driver) — handle both so
    // a driver bump doesn't silently break this endpoint.
    const updatedRow = result && (result.value || result);
    if (!updatedRow || !updatedRow._id) {
      return res
        .status(404)
        .json({ success: false, message: "Credit note record not found" });
    }

    return res.json({ success: true, data: updatedRow });
  } catch (error) {
    console.error("Patch credit note error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update credit note" });
  }
});

// ── DELETE /creditNote/:id ──────────────────────────────────────────
// Remove a credit-note row from imb_credit_note and, best-effort,
// drop the associated PDF from S3. The DB row is the index — leaving
// the S3 object around without it just creates orphan storage. If
// the S3 delete fails we still return success (we logged it) because
// the Mongo deletion is the primary action and recovering the DB
// row is much harder than re-deleting an S3 object.
//
// Same permission gate as the other admin paths
// (zoho:salesOrder:create).
router.delete("/:id", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }
    const db = await connectToDatabase();
    const collection = db.collection(CREDIT_NOTE_COLLECTION);
    // Read first so we know which S3 key (if any) to clean up.
    const row = await collection.findOne({ _id: new ObjectId(id) });
    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: "Credit note record not found" });
    }

    await collection.deleteOne({ _id: new ObjectId(id) });

    // Best-effort S3 cleanup. We surface the outcome on the response
    // (s3 = { ok, message? }) so the caller can warn the user if the
    // object stuck around, but never roll back the DB delete on an
    // S3 failure — the row is gone and the user expects it gone.
    let s3 = { ok: true };
    if (row.s3Key) {
      const client = getS3Client();
      const bucket = process.env.S3_CREDIT_BUCKET_NAME;
      if (!client || !bucket) {
        s3 = { ok: false, message: "S3 not configured; PDF left in bucket" };
      } else {
        try {
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: row.s3Key }),
          );
        } catch (e) {
          console.warn(
            `[creditNote delete] S3 cleanup failed for ${row.s3Key}:`,
            e.message || e,
          );
          s3 = { ok: false, message: e.message || "S3 delete failed" };
        }
      }
    } else {
      s3 = { ok: true, skipped: true };
    }

    return res.json({ success: true, s3 });
  } catch (error) {
    console.error("Delete credit note error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete credit note" });
  }
});

// ── GET /creditNote/:id/zohoDetail ──────────────────────────────────
// Resolve the row's creditNo → Zoho creditnote_id and fetch the full
// Zoho Inventory record in one round trip. Surfaces the bits the
// Review dialog needs to display up front (customer name, pricelist)
// AND returns the whole `creditnote` object so the dialog can pass it
// back on submit without us having to re-fetch.
//
// This used to live inside submitToZoho as steps 2 + 3 — pulling it
// out shaves one Zoho fetch off every submit (since the dialog has
// already done it) and lets the user see who the credit note belongs
// to before committing the change.
//
// Re-called by the frontend whenever the user edits creditNo via the
// PATCH endpoint, so the displayed customer / pricelist stays in sync
// with the new lookup target.
router.get("/:id/zohoDetail", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const db = await connectToDatabase();
    const row = await db
      .collection(CREDIT_NOTE_COLLECTION)
      .findOne({ _id: new ObjectId(id) });
    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: "Credit note record not found" });
    }
    if (!row.creditNo) {
      return res.status(400).json({
        success: false,
        message:
          "This row has no creditNo extracted from OCR — can't locate the Zoho credit note.",
      });
    }

    const zohoCreditNoteId = await findZohoCreditNoteId(row.creditNo);
    if (!zohoCreditNoteId) {
      return res.status(404).json({
        success: false,
        message: `Could not find credit note "${row.creditNo}" in Zoho Inventory.`,
      });
    }

    const detail = await fetchZohoCreditNote(zohoCreditNoteId);
    if (!detail) {
      return res.status(502).json({
        success: false,
        message:
          "Found the Zoho credit note id but couldn't fetch the full record.",
      });
    }

    // Resolve the pricebook id with the contact fallback so empty
    // credit notes (no line items yet) still show a pricelist in the
    // dialog header. The helper only fires the contact lookup when
    // the cheaper line-items read returns nothing.
    const pricebookId = await resolvePricebookId(detail);

    return res.json({
      success: true,
      zohoCreditNoteId,
      customerName: detail.customer_name || null,
      customerId: detail.customer_id || null,
      pricebookId,
      // Status drives the is_draft decision on submit (we only want to
      // keep the draft flag set when the record is currently draft —
      // sending is_draft on an open record would demote it).
      status: detail.status || null,
      // Hand the full record back too so the Review dialog can hold
      // onto it and pass it through to submitToZoho, sparing the
      // backend a re-fetch. The whole shape stays opaque to the
      // frontend — it just stores + forwards.
      detail,
    });
  } catch (error) {
    console.error("zohoDetail error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to fetch Zoho credit note detail",
    });
  }
});

// ── POST /creditNote/:id/submitToZoho ────────────────────────────────
// Pushes the user's matched line items + edited note into the existing
// Zoho Inventory credit note, then re-uploads the S3 PDF as a Zoho
// attachment. On success the row's status flips to "completed" so the
// Credit Note page tree count reflects it and the Review dialog's
// Submit button stays off on re-open. Body:
//   {
//     items: [{ matchedItemId, matchedSku, matchedName, quantity }, ...],
//     note: "..."                       // optional, replaces notes field
//     returnDevice, repairDevice        // A9999/R9999 buckets
//
//     // Optional Zoho-side hints — when the frontend already fetched
//     // the credit note via /zohoDetail it should pass these back so
//     // we skip the resolve + re-fetch entirely. If anything is
//     // missing we fall back to the old find + fetch flow so this
//     // endpoint still works for callers that don't go through the
//     // dialog.
//     zohoCreditNoteId: "...",
//     pricebookId: "...",    // resolved by /zohoDetail (with the
//                            // contact-fallback) so we don't have to
//                            // re-look-it-up for the line stamping
//     existing: { ...the full Zoho creditnote object as returned by
//                  Inventory's GET /creditnotes/:id }
//   }
router.post("/:id/submitToZoho", GATE, async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid id" });
    }
    const items = Array.isArray(req.body && req.body.items)
      ? req.body.items
      : [];
    const note =
      req.body && typeof req.body.note === "string" ? req.body.note : "";
    // Device buckets (A9999 / R9999) — see ZOHO_ITEM_ID_RETURN_DEVICE
    // / _REPAIR_DEVICE above. Each entry maps to its own Zoho line
    // item with model as description.
    const returnDevices = Array.isArray(req.body && req.body.returnDevice)
      ? req.body.returnDevice
      : [];
    const repairDevices = Array.isArray(req.body && req.body.repairDevice)
      ? req.body.repairDevice
      : [];

    // Each regular item must carry a matched Zoho item id; quantity
    // defaults to 1 if missing / non-numeric.
    const usableItems = items
      .map((it) => ({
        item_id: String(it.matchedItemId || ""),
        name: (it.matchedName || "").toString() || undefined,
        quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      }))
      .filter((it) => it.item_id);

    // Devices: keep entries that have either a non-empty model or a
    // positive quantity. Quantity defaults to 1 (a single device
    // received) when missing / zero / non-numeric.
    const usableReturnDevices = returnDevices
      .filter((d) => d && ((d.model && String(d.model).trim()) || Number(d.quantity) > 0))
      .map((d) => ({
        model: String(d.model || "").trim(),
        quantity: Number(d.quantity) > 0 ? Number(d.quantity) : 1,
      }));
    const usableRepairDevices = repairDevices
      .filter((d) => d && ((d.model && String(d.model).trim()) || Number(d.quantity) > 0))
      .map((d) => ({
        model: String(d.model || "").trim(),
        quantity: Number(d.quantity) > 0 ? Number(d.quantity) : 1,
      }));

    // Empty-payload guard removed deliberately: the user can submit
    // a credit note that has no extra line items or devices to add,
    // e.g. when the only change is the note text, the PDF
    // attachment, or the lifecycle status. The PUT below still
    // re-sends Zoho's existing line items unchanged (because
    // mergedLineItems falls back to just `existingLineItems` when
    // nothing was added), and the PDF attach + status flip downstream
    // still run, so an empty payload is a meaningful action — it
    // marks the row as completed and ensures the PDF is on the Zoho
    // credit note.

    const db = await connectToDatabase();
    const collection = db.collection(CREDIT_NOTE_COLLECTION);
    const row = await collection.findOne({ _id: new ObjectId(id) });
    if (!row) {
      return res
        .status(404)
        .json({ success: false, message: "Credit note record not found" });
    }
    if (!row.creditNo) {
      return res.status(400).json({
        success: false,
        message: "This row has no creditNo extracted from OCR — can't locate the Zoho credit note.",
      });
    }

    // 1 + 2. Resolve creditNo → Zoho creditnote_id and load the
    //   existing record. The Review dialog calls /zohoDetail on open
    //   and passes the results back here, so the happy path skips
    //   both Zoho round trips. Anything missing (or a caller that
    //   doesn't go through the dialog) falls through to the original
    //   find + fetch flow so this endpoint still works standalone.
    let zohoCreditNoteId =
      (req.body && req.body.zohoCreditNoteId &&
        String(req.body.zohoCreditNoteId)) ||
      null;
    let existing =
      req.body && req.body.existing && typeof req.body.existing === "object"
        ? req.body.existing
        : null;

    if (!zohoCreditNoteId) {
      zohoCreditNoteId = await findZohoCreditNoteId(row.creditNo);
      if (!zohoCreditNoteId) {
        return res.status(404).json({
          success: false,
          message: `Could not find credit note "${row.creditNo}" in Zoho Inventory.`,
        });
      }
    }

    if (!existing) {
      existing = await fetchZohoCreditNote(zohoCreditNoteId);
      if (!existing) {
        return res.status(502).json({
          success: false,
          message: "Found the Zoho credit note id but couldn't fetch the existing record.",
        });
      }
    }

    // 3. Compose the updated payload. Spread the existing line items
    //    so their line_item_id / rate / name etc. are preserved; append
    //    the new ones at the end.
    const existingLineItems = Array.isArray(existing.line_items)
      ? existing.line_items.map((li) => ({ ...li }))
      : [];

    // Pricelist on a credit note is stored per-line-item on this org,
    // not on the credit-note root. Three-tier resolution:
    //   1. body.pricebookId — Review dialog already resolved it via
    //      /zohoDetail (which handles the contact fallback), so the
    //      happy path skips any extra round trip here.
    //   2. existing.line_items[0].pricebook_id — the cheap read off
    //      the credit note's existing rows.
    //   3. resolvePricebookId(existing) — falls all the way back to
    //      the customer's default pricebook via the Contacts API for
    //      the no-items-yet case.
    // Existing line items already carry their own pricebook_id + rate
    // (we just spread them above), so re-sending those is a no-op;
    // the stamp only matters for the NEW line items below.
    let linePricebookId =
      (req.body && req.body.pricebookId && String(req.body.pricebookId)) ||
      (existingLineItems[0] && existingLineItems[0].pricebook_id) ||
      null;
    if (!linePricebookId) {
      linePricebookId = await resolvePricebookId(existing);
    }
    const stampPricebook = (li) =>
      linePricebookId ? { ...li, pricebook_id: linePricebookId } : li;

    // ── Dedupe new items against existing lines ───────────────────
    // When the user picks a match whose item_id is already on the
    // credit note, we OVERWRITE the existing line's quantity with
    // the dialog value instead of appending a duplicate. Rules:
    //
    //   1. Aggregate the dialog rows by matched item_id, summing
    //      qtys — so two dialog rows of the same itemId (qty 3 +
    //      qty 2) collapse into one update (qty 5).
    //
    //   2. Walk the existing line items in order. The FIRST existing
    //      occurrence of a matched item_id keeps its line_item_id
    //      (so Zoho's history of that line stays intact) and gets
    //      the user's qty. Subsequent occurrences of the same
    //      item_id are dropped — Zoho's line_items array can't carry
    //      multiple lines for the same catalogue item once we've
    //      committed to "the dialog qty is the authoritative qty
    //      for that item."
    //
    //   3. Item ids the user picked that aren't on the credit note
    //      yet get appended as new lines, stamped with the resolved
    //      pricebook so the rates match.
    //
    //   4. Devices (A9999 / R9999) are NOT deduped — each represents
    //      a distinct physical unit and getting them collapsed
    //      together would lose the per-device model description.
    //      They always append.
    const userItemQty = new Map();
    const userItemSample = new Map();
    for (const it of usableItems) {
      if (!it || !it.item_id) continue;
      const id = String(it.item_id);
      userItemQty.set(id, (userItemQty.get(id) || 0) + (Number(it.quantity) || 0));
      if (!userItemSample.has(id)) userItemSample.set(id, it);
    }

    const handledItemIds = new Set();
    const mergedExistingLineItems = [];
    for (const li of existingLineItems) {
      if (!li || !li.item_id) {
        // No item_id (rare; some line types don't have one) — keep
        // verbatim and don't try to merge.
        mergedExistingLineItems.push({ ...li });
        continue;
      }
      const id = String(li.item_id);
      if (userItemQty.has(id)) {
        if (!handledItemIds.has(id)) {
          // First existing occurrence — keep the line_item_id and
          // every other field, just replace qty. Note: the existing
          // line already carries its own pricebook_id; we don't
          // stampPricebook here because that's only for NEW lines.
          handledItemIds.add(id);
          mergedExistingLineItems.push({ ...li, quantity: userItemQty.get(id) });
        }
        // Subsequent existing duplicate — drop. Falling through the
        // loop without pushing accomplishes that.
      } else {
        // User didn't touch this item — preserve verbatim.
        mergedExistingLineItems.push({ ...li });
      }
    }

    // New line items: one per unique itemId the user picked that
    // wasn't already on the credit note. Quantity is the summed
    // total from step 1.
    const newLineItems = [];
    for (const [itemId, qty] of userItemQty) {
      if (handledItemIds.has(itemId)) continue;
      const sample = userItemSample.get(itemId);
      newLineItems.push(
        stampPricebook({
          item_id: itemId,
          name: sample && sample.name ? sample.name : undefined,
          quantity: qty,
        }),
      );
    }

    // Device lines — each entry in usableReturnDevices / usable
    // RepairDevices becomes its own Zoho line item pointing at the
    // fixed catalogue item-id, with the model on the description.
    // Quantity comes from the parsed/edited row. Always appended
    // (no dedup — see rule 4 in the dedup block above).
    const returnDeviceLineItems = usableReturnDevices.map((d) =>
      stampPricebook({
        item_id: ZOHO_ITEM_ID_RETURN_DEVICE,
        quantity: d.quantity,
        description: d.model,
      }),
    );
    const repairDeviceLineItems = usableRepairDevices.map((d) =>
      stampPricebook({
        item_id: ZOHO_ITEM_ID_REPAIR_DEVICE,
        quantity: d.quantity,
        description: d.model,
      }),
    );

    // Stamp the location on EVERY line item (existing + new + device)
    // so each returned line books into the right Zoho location.
    //
    // NOTE: this org runs Zoho Inventory's "Locations" model, not the
    // older "Warehouses" model — so the per-line field is `location_id`,
    // NOT `warehouse_id`. The existing line items we spread back came
    // from Zoho's READ response, which still includes a `warehouse_id`
    // field; sending that back on the PUT gets rejected with "Invalid
    // Element warehouse_id". So strip warehouse_id off every line before
    // stamping location_id. Same id as the root location_id.
    const mergedLineItems = mergedExistingLineItems
      .concat(newLineItems, returnDeviceLineItems, repairDeviceLineItems)
      .map((li) => {
        const { warehouse_id, ...rest } = li || {};
        return { ...rest, location_id: ZOHO_CREDIT_NOTE_WAREHOUSE_ID };
      });

    const updatePayload = {
      // PUT requires the date back (Zoho will reject if omitted).
      date: existing.date,
      // Book the credit note against the configured warehouse location.
      location_id: ZOHO_CREDIT_NOTE_LOCATION_ID,
      line_items: mergedLineItems,
    };
    // Preserve customer linkage so the PUT doesn't unbind it.
    if (existing.customer_id) updatePayload.customer_id = existing.customer_id;
    if (note) updatePayload.notes = note;
    // Keep the credit note in draft. `is_draft: true` is the
    // documented Zoho flag — without it the PUT auto-promotes a
    // draft to "open" once required fields land. Only sent when the
    // record was already draft going in; records past draft (open /
    // closed / void) are left untouched.
    if ((existing.status || "").toLowerCase() === "draft") {
      updatePayload.is_draft = true;
    }

    // 4. PUT the update.
    const updateUrl =
      `https://www.zohoapis.com/inventory/v1/creditnotes/${zohoCreditNoteId}` +
      `?organization_id=${ZOHO_ORG_ID}`;
    const updateResp = await handleZohoInventoryPutRequest(
      updateUrl,
      updatePayload,
    );
    if (!updateResp || updateResp.code !== 0) {
      const msg =
        (updateResp && (updateResp.message ||
          (updateResp.error && updateResp.error.message))) ||
        "Zoho rejected the credit-note update";
      console.error("Zoho creditnote PUT failed:", updateResp);
      return res
        .status(502)
        .json({ success: false, message: msg, zohoResponse: updateResp });
    }

    // 5. Best-effort PDF attach. The credit-note update has already
    //    landed at this point — an attach failure shouldn't roll back
    //    the line-item write, so we record the outcome and surface it
    //    on the response.
    let attach = { ok: false, message: "no s3 key on row" };
    if (row.s3Key) {
      try {
        const pdfBuffer = await downloadS3Object(row.s3Key);
        const form = new FormData();
        form.append("attachment", pdfBuffer, {
          filename: extractFilename(row.s3Key),
          contentType: "application/pdf",
          knownLength: pdfBuffer.length,
        });
        const attachUrl =
          `https://www.zohoapis.com/inventory/v1/creditnotes/${zohoCreditNoteId}/attachment` +
          `?organization_id=${ZOHO_ORG_ID}`;
        const attachResp = await handleZohoInventoryMultipartPostRequest(
          attachUrl,
          form,
        );
        if (attachResp && attachResp.code === 0) {
          attach = { ok: true };
        } else {
          attach = {
            ok: false,
            message:
              (attachResp && attachResp.message) ||
              "Zoho rejected the attachment",
          };
        }
      } catch (e) {
        console.warn("Zoho creditnote attach failed:", e.message || e);
        attach = { ok: false, message: e.message || "attach failed" };
      }
    }

    // 6. Mark our row as completed + remember the Zoho id so the
    //    Review dialog's Submit stays off on re-open.
    await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: "completed",
          zohoCreditNoteId,
          zohoSubmittedAt: new Date(),
        },
      },
    );

    return res.json({
      success: true,
      zohoCreditNoteId,
      attach,
    });
  } catch (error) {
    console.error("submitToZoho error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to submit to Zoho",
    });
  }
});

// Resolve a creditNo (the display number like "CN-12345") to its Zoho
// creditnote_id. Two-tier:
//   1. Zoho Inventory's /creditnotes list with the contains filter —
//      cheap, no Analytics-side latency.
//   2. Fallback to the Analytics view 1404913000003936107 the user
//      pointed at when (1) returns nothing.
// Returns the id as a string, or null when neither hit a match.
async function findZohoCreditNoteId(creditNo) {
  // (1) Try Inventory first.
  try {
    const url =
      `https://www.zohoapis.com/inventory/v1/creditnotes` +
      `?organization_id=${ZOHO_ORG_ID}` +
      `&creditnote_number_contains=${encodeURIComponent(creditNo)}`;
    const resp = await handleZohoInventoryRequest(url);
    if (resp && resp.code === 0 && Array.isArray(resp.creditnotes)) {
      // Prefer an exact match if multiple rows came back from "contains".
      const exact = resp.creditnotes.find(
        (cn) => cn.creditnote_number === creditNo,
      );
      const chosen = exact || resp.creditnotes[0];
      if (chosen && chosen.creditnote_id) {
        return String(chosen.creditnote_id);
      }
    }
  } catch (e) {
    console.warn(
      "Zoho Inventory credit-note search failed, falling back to Analytics:",
      e.message || e,
    );
  }

  // (2) Analytics fallback. Same workspace as the rest of the app's
  // Analytics queries.
  try {
    const safe = String(creditNo).replace(/'/g, "''");
    const config = {
      responseFormat: "json",
      selectedColumns: ["Credit Note ID", "Credit Note Number"],
      criteria: `"Credit Note Number" = '${safe}'`,
    };
    const url =
      `https://analyticsapi.zoho.com/restapi/v2/workspaces/${ZOHO_WORKSPACE_ID}` +
      `/views/${ZOHO_CREDIT_NOTE_VIEW_ID}/data?CONFIG=` +
      encodeURIComponent(JSON.stringify(config));
    const rows = await getViewData(url);
    if (Array.isArray(rows) && rows.length > 0) {
      const cnId = rows[0]["Credit Note ID"];
      if (cnId) return String(cnId);
    }
  } catch (e) {
    console.warn("Analytics credit-note lookup failed:", e.message || e);
  }

  return null;
}

// Fetch the credit note's full Zoho record. Returns the `creditnote`
// object on success, or null when Zoho responds with anything else.
async function fetchZohoCreditNote(creditnoteId) {
  const url =
    `https://www.zohoapis.com/inventory/v1/creditnotes/${creditnoteId}` +
    `?organization_id=${ZOHO_ORG_ID}`;
  const resp = await handleZohoInventoryRequest(url);
  if (resp && resp.code === 0 && resp.creditnote) {
    return resp.creditnote;
  }
  return null;
}

// Resolve the pricebook (pricelist) id for a credit note.
//
// Two-tier:
//   1. existing.line_items[0].pricebook_id — on this org Zoho stores
//      the pricebook per-line, so as long as there's at least one
//      existing item we can read it straight off without an extra
//      round trip.
//   2. Fall back to the customer's default pricebook via the Contacts
//      API. Only kicks in when (1) returns nothing — i.e. a freshly
//      created credit note that has no items yet — so the cheap path
//      stays cheap for the common case.
//
// Returns the pricebook_id as a string, or null when neither tier
// produced one (e.g. customer has no default pricebook, or the
// contact lookup failed).
async function resolvePricebookId(existing) {
  if (existing && Array.isArray(existing.line_items)) {
    const fromLineItems =
      existing.line_items[0] && existing.line_items[0].pricebook_id;
    if (fromLineItems) return String(fromLineItems);
  }
  // Need a customer to fall back on. Without customer_id we can't
  // query — the credit note must already be linked to a contact.
  if (!existing || !existing.customer_id) return null;
  try {
    const url =
      `https://www.zohoapis.com/inventory/v1/contacts/${existing.customer_id}` +
      `?organization_id=${ZOHO_ORG_ID}`;
    const resp = await handleZohoInventoryRequest(url);
    if (
      resp &&
      resp.code === 0 &&
      resp.contact &&
      resp.contact.pricebook_id
    ) {
      return String(resp.contact.pricebook_id);
    }
  } catch (e) {
    // Swallow — caller treats null as "no pricelist", which makes
    // the new line items use Zoho's catalogue default rate. Better
    // than failing the whole submit on a flaky contacts call.
    console.warn(
      "Contact pricebook fallback failed:",
      e.message || e,
    );
  }
  return null;
}

// Download an S3 object to a Buffer. Reuses the lazy S3 client + the
// bucket from .env (S3_CREDIT_BUCKET_NAME). Streams the response Body
// into a Buffer so the FormData upload can pass it through directly.
async function downloadS3Object(key) {
  const client = getS3Client();
  if (!client) {
    throw new Error("S3 client not configured");
  }
  const bucket = process.env.S3_CREDIT_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_CREDIT_BUCKET_NAME is not configured");
  }
  const out = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return await streamToBuffer(out.Body);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Last path segment of an S3 key (no leading slash needed) — used as
// the filename for the Zoho attachment so the upload preserves the
// user's original date stamp instead of a generic name.
function extractFilename(key) {
  if (!key) return "credit-note.pdf";
  const parts = String(key).split("/");
  return parts[parts.length - 1] || "credit-note.pdf";
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
