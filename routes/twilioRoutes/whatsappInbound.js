// Twilio WhatsApp inbound + fallback webhook.
//
// Routes:
//   POST /webhook/twilio/whatsapp           ← primary inbound
//   POST /webhook/twilio/whatsapp/fallback  ← Twilio falls over here
//                                              if the primary 5xxs
//                                              or times out
//
// Both share the same handler; the fallback variant stamps
// `viaFallback: true` on the persisted event so an outage in the
// primary can be spotted by querying for those rows.
//
// On every well-formed inbound message:
//   1. Verify X-Twilio-Signature via Twilio's official SDK.
//   2. ACK Twilio immediately with an empty TwiML <Response/>. We
//      don't reply via TwiML because content templates require the
//      Messages REST API (TwiML only supports freeform text/media),
//      and our state-machine replies need to vary per session
//      anyway.
//   3. Persist the raw event into imb_whatsapp_event (upsert by
//      MessageSid so retries collapse).
//   4. Hand the parsed payload off to the workflow state machine
//      (utils/whatsappWorkflow.js) which owns session lookup, reply
//      decisions, and the special-order archive on completion.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { validateTwilioRequest } = require("../../utils/twilioSignature");
const { handleInboundMessage } = require("../../utils/whatsappWorkflow");
const twiml = require("twilio").twiml;

const COLLECTION = "imb_whatsapp_event";

function makeHandler(viaFallback) {
  return async function (req, res) {
    try {
      if (!validateTwilioRequest(req)) {
        console.warn(
          `[twilio inbound${viaFallback ? " fallback" : ""}] signature verification failed`,
        );
        return res.sendStatus(403);
      }

      // ACK first with an empty TwiML response. Twilio is happy with
      // 200 + any body; the empty <Response/> is the canonical way
      // to say "I received this and I'm not auto-replying via TwiML."
      const empty = new twiml.MessagingResponse();
      res.type("text/xml").send(empty.toString());

      // Everything below runs AFTER the ACK — Twilio doesn't wait.
      // Wrap each step in its own try so one failure doesn't poison
      // the others.

      try {
        await persistInbound(req.body, viaFallback);
      } catch (e) {
        console.error(
          "[twilio inbound] persistInbound failed:",
          e.message || e,
        );
      }

      // Hand off to the workflow state machine. It owns the
      // session, the replies (list-picker template OR freeform text
      // depending on state), and the special-order archive on
      // completion. handleInboundMessage swallows its own errors so
      // we don't need a try/catch here, but keep one anyway as
      // belt-and-braces.
      try {
        await handleInboundMessage(req.body);
      } catch (e) {
        console.error(
          "[twilio inbound] workflow failed:",
          e && e.code ? `code=${e.code} ` : "",
          e.message || e,
        );
      }
    } catch (e) {
      // Belt and braces — shouldn't reach here because the inner
      // tries catch their own failures, but if some pre-ACK code
      // throws we must not double-send a response.
      console.error("[twilio inbound] handler error:", e.message || e);
      if (!res.headersSent) {
        res.sendStatus(500);
      }
    }
  };
}

// Upsert the parsed Twilio form payload into the shared events
// collection. MessageSid is unique per inbound message so retries
// collapse into the same document.
async function persistInbound(body, viaFallback) {
  if (!body || !body.MessageSid) {
    console.warn("[twilio inbound] dropping event without MessageSid");
    return;
  }

  // Media: Twilio sends NumMedia + MediaUrl0..N + MediaContentType0..N
  // — flatten into a single array so the schema's easier to query.
  const numMedia = parseInt(body.NumMedia || "0", 10) || 0;
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    media.push({
      url: body[`MediaUrl${i}`] || null,
      contentType: body[`MediaContentType${i}`] || null,
    });
  }

  const db = await connectToDatabase();
  await db.collection(COLLECTION).updateOne(
    { eventId: body.MessageSid },
    {
      $set: {
        eventId: body.MessageSid,
        provider: "twilio",
        kind: "message",
        messageSid: body.MessageSid,
        accountSid: body.AccountSid || null,
        // From / To stay in their original 'whatsapp:+...' form for
        // outbound parity — `waId` carries the bare digits when we
        // need them for matching elsewhere.
        from: body.From || null,
        to: body.To || null,
        waId: body.WaId || null,
        profileName: body.ProfileName || null,
        body: body.Body || "",
        numMedia,
        media,
        viaFallback: !!viaFallback,
        // Keep the entire form payload verbatim — small footprint
        // and useful for debugging unfamiliar fields without a
        // schema migration.
        raw: body,
        receivedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

router.post("/", makeHandler(false));
router.post("/fallback", makeHandler(true));

module.exports = router;
