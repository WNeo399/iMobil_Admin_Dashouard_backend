// Public webhook endpoint for Meta's WhatsApp Cloud API.
// Mounted in app.js under /webhook (outside the authenticated chain)
// so the resolved paths are:
//   GET  /webhook/whatsapp  → subscription handshake
//   POST /webhook/whatsapp  → inbound notifications
//
// Contract reference:
//   https://developers.facebook.com/docs/graph-api/webhooks/getting-started/
//   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
//
// Env vars required:
//   WHATSAPP_VERIFY_TOKEN  — arbitrary string we picked, echoed by Meta
//                            in the GET handshake's hub.verify_token.
//                            Must match the value entered in the Meta
//                            App Dashboard's webhook configuration UI.
//   WHATSAPP_APP_SECRET    — the Meta App Secret used to HMAC-sign the
//                            POST body (X-Hub-Signature-256). Same secret
//                            shown under App Settings → Basic in the
//                            Meta Developer dashboard.
//
// Persistence: every well-formed inbound message or status update lands
// in the `imb_whatsapp_event` collection. Upserts are keyed by the
// event's own WAMID (`wamid.XXX`), so if Meta retries (it will, on any
// non-200 response, for up to 36 hours) the duplicate POSTs collapse
// into a single document rather than spawning copies.

var express = require("express");
var crypto = require("crypto");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "imb_whatsapp_event";

// ── GET /webhook/whatsapp ───────────────────────────────────────────
// Meta calls this once when you save the webhook URL in the App
// Dashboard. The handshake parameters:
//   hub.mode          = "subscribe"
//   hub.verify_token  = whatever string we configured on Meta's side
//   hub.challenge     = random int Meta wants echoed back as-is
//
// Echo the challenge with 200 only when the token matches; otherwise
// 403 so Meta surfaces the misconfiguration in their UI rather than
// silently subscribing us.
router.get("/whatsapp", function (req, res) {
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expectedToken) {
    console.error(
      "[whatsapp] verification rejected: WHATSAPP_VERIFY_TOKEN env var is not set"
    );
    return res.sendStatus(500);
  }

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === expectedToken) {
    // Plain-text body is required — Meta does a literal === against
    // the challenge it sent, so JSON wrapping or a trailing newline
    // would fail the dashboard check.
    return res.status(200).send(String(challenge));
  }

  console.warn(
    `[whatsapp] verification rejected: mode=${mode} tokenMatched=${token === expectedToken}`
  );
  return res.sendStatus(403);
});

// ── POST /webhook/whatsapp ──────────────────────────────────────────
// Inbound notification. Meta retries any non-200 response immediately,
// then with backoff over 36 hours, so the success path MUST return 200
// even if downstream persistence fails — we just log the persistence
// error and rely on idempotent upserts to recover when Meta retries.
//
// The one exception is the signature check: a mismatch means the
// request didn't come from Meta (or our App Secret is rotated), so 403
// is correct and we want the request to fail loudly.
router.post("/whatsapp", async function (req, res) {
  // 1. Verify the HMAC. The signature is computed over the EXACT bytes
  //    Meta sent, which is why app.js stashes req.rawBody — once
  //    express.json() reparses the body, key ordering / whitespace
  //    differences would break the digest.
  if (!verifySignature(req)) {
    console.warn("[whatsapp] signature verification failed");
    return res.sendStatus(403);
  }

  // 2. Always ack first, then process. This avoids the duplicate-work
  //    trap where Meta retries while we're still mid-write, and also
  //    keeps us comfortably inside whatever undocumented "respond fast"
  //    deadline Meta enforces. The upsert in persistEvents() is
  //    idempotent so a retry that does sneak in is harmless.
  res.sendStatus(200);

  try {
    await persistEvents(req.body);
  } catch (err) {
    // Swallow — 200 has already been sent. Meta won't retry on errors
    // we hit after the ack; persistence is best-effort beyond that.
    console.error("[whatsapp] persistence failed:", err.message || err);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────

// HMAC-SHA256 of the raw request body, hex-encoded, prefixed with
// "sha256=". timingSafeEqual is used to avoid leaking match progress
// via response-time differences; it requires equal-length buffers so
// we bail with a length pre-check.
function verifySignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    console.error(
      "[whatsapp] signature check skipped: WHATSAPP_APP_SECRET env var is not set"
    );
    return false;
  }
  const header = req.get("X-Hub-Signature-256");
  if (!header || !header.startsWith("sha256=")) return false;
  if (!req.rawBody) {
    // Should never happen — app.js attaches rawBody to every JSON
    // request — but defend against a future middleware change that
    // would silently break signature verification.
    console.error("[whatsapp] rawBody missing on request; check app.js wiring");
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");
  const headerDigest = header.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const headerBuf = Buffer.from(headerDigest, "hex");
  if (expectedBuf.length !== headerBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, headerBuf);
}

// Walk the webhook payload's nested entry → changes → value structure
// and persist every inbound message or status update we can identify.
// Documents are upserted by `eventId` (the WAMID) so Meta retries fold
// into the same row instead of inserting duplicates.
//
// Payload shape (abbreviated; see WhatsApp Cloud API docs for the
// full schema):
//   {
//     object: "whatsapp_business_account",
//     entry: [{
//       id: "<WABA id>",
//       changes: [{
//         field: "messages",
//         value: {
//           messaging_product: "whatsapp",
//           metadata: { display_phone_number, phone_number_id },
//           contacts: [{ profile: { name }, wa_id }],
//           messages: [{ id, from, timestamp, type, text: { body }, ... }],
//           statuses: [{ id, status, timestamp, recipient_id, ... }]
//         }
//       }]
//     }]
//   }
async function persistEvents(body) {
  if (!body || body.object !== "whatsapp_business_account") {
    // Not a shape we understand — log and skip so debugging is easy
    // when Meta introduces new event types we haven't mapped yet.
    console.warn(
      `[whatsapp] ignored payload with unexpected object="${body && body.object}"`
    );
    return;
  }

  const db = await connectToDatabase();
  const collection = db.collection(COLLECTION);
  const receivedAt = new Date();
  const ops = [];

  for (const entry of body.entry || []) {
    const wabaId = entry && entry.id;
    for (const change of (entry && entry.changes) || []) {
      const value = change && change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata && value.metadata.phone_number_id;
      // Contacts come in a parallel array — index them by wa_id so we
      // can stamp the sender's profile name onto each message doc.
      const contactsByWaId = {};
      for (const c of value.contacts || []) {
        if (c && c.wa_id) contactsByWaId[c.wa_id] = c;
      }

      // Inbound messages (text, image, audio, button replies, ...)
      for (const m of value.messages || []) {
        if (!m || !m.id) continue;
        const contact = contactsByWaId[m.from] || null;
        ops.push({
          updateOne: {
            filter: { eventId: m.id },
            update: {
              $set: {
                eventId: m.id,
                kind: "message",
                wabaId,
                phoneNumberId,
                from: m.from,
                type: m.type,
                // Preserve the entire message for downstream readers
                // — text, media, interactive, button, etc. all live
                // under different keys we don't want to lose to a
                // shallow extraction.
                message: m,
                contactName:
                  (contact && contact.profile && contact.profile.name) || null,
                // WhatsApp sends timestamps as unix seconds in a string;
                // store both the original and a Date for indexing.
                sentAt: timestampToDate(m.timestamp),
                sentAtRaw: m.timestamp,
                receivedAt,
              },
            },
            upsert: true,
          },
        });
      }

      // Outbound delivery / read / failure receipts. Stored under the
      // same collection so a single query can reconstruct the full
      // lifecycle of any one wamid.
      for (const s of value.statuses || []) {
        if (!s || !s.id) continue;
        ops.push({
          updateOne: {
            // Status events repeat the message's wamid; use a
            // composite key so each status row is independent of the
            // message it refers to.
            filter: { eventId: `${s.id}:${s.status}` },
            update: {
              $set: {
                eventId: `${s.id}:${s.status}`,
                kind: "status",
                wabaId,
                phoneNumberId,
                messageWamid: s.id,
                status: s.status,
                recipientId: s.recipient_id,
                statusAt: timestampToDate(s.timestamp),
                statusAtRaw: s.timestamp,
                status_payload: s,
                receivedAt,
              },
            },
            upsert: true,
          },
        });
      }
    }
  }

  if (ops.length === 0) {
    // Account-change events (template updates, etc.) hit the same
    // endpoint but don't carry messages/statuses — fine to no-op, we
    // just don't store them.
    return;
  }

  await collection.bulkWrite(ops, { ordered: false });
  console.log(`[whatsapp] persisted ${ops.length} event(s)`);
}

function timestampToDate(ts) {
  if (ts == null || ts === "") return null;
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

module.exports = router;
