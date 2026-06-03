// Public webhook endpoint that HandwritingOCR posts to when an
// extraction job finishes. Mounted OUTSIDE the authenticated router
// chain in app.js because OCR doesn't hold our JWT — the endpoint
// authenticates the request by looking up our own ocrId in
// imb_credit_note (an unknown id is treated as a 404, so a random
// internet caller can't write to arbitrary rows).
//
// TODO: HandwritingOCR also sends an `x-signature: sha256=...` header
// (see desktop/html/ocrreturn.json) — once a shared webhook secret is
// configured in their dashboard, verify the HMAC here before parsing.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { parseOcrResult } = require("./parser");

const CREDIT_NOTE_COLLECTION = "imb_credit_note";

// POST /webhook/creditNoteOcr
// Body: HandwritingOCR's extraction payload (see desktop/html/ocrreturn.json).
router.post("/creditNoteOcr", async function (req, res) {
  try {
    const body = req.body || {};
    const ocrId = body.id;
    if (!ocrId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing `id` on webhook body." });
    }

    // Parse only when OCR says it succeeded. A "failed" or "rejected"
    // payload still updates the row's status so the dashboard can show
    // the failure state, but we don't try to extract data from it.
    let updateFields;
    if (body.status === "processed") {
      const parsed = parseOcrResult(body);
      updateFields = {
        status: body.status,
        creditNo: parsed.creditNo,
        itemCount: parsed.itemCount,
        items: parsed.items,
        returnNote: parsed.returnNote,
        ocrProcessedAt: new Date(),
      };
    } else {
      updateFields = {
        status: body.status || "unknown",
        ocrProcessedAt: new Date(),
      };
    }

    const db = await connectToDatabase();
    const result = await db.collection(CREDIT_NOTE_COLLECTION).updateOne(
      { ocrId },
      { $set: updateFields },
    );

    if (result.matchedCount === 0) {
      // 404 rather than 5xx — the request was well-formed, we just
      // don't have a record for this id. Returning a non-5xx prevents
      // OCR from retrying the webhook on every backoff window.
      console.warn(
        `[creditNoteOcr] no imb_credit_note record for ocrId=${ocrId}`,
      );
      return res
        .status(404)
        .json({ success: false, message: `No record for ocrId ${ocrId}` });
    }

    return res.json({
      success: true,
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (error) {
    console.error("creditNoteOcr webhook failed:", error.message || error);
    // 5xx — OCR will retry on transient errors, which is what we want
    // for an actual server bug (Mongo down, etc).
    return res.status(500).json({
      success: false,
      message: error.message || "Webhook handler failed",
    });
  }
});

module.exports = router;
