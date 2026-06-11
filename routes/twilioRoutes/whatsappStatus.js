// Twilio WhatsApp outbound delivery-status callback.
//
//   POST /webhook/twilio/whatsapp/status
//
// Fires for every state transition of an OUTBOUND message we sent
// (queued / sent / delivered / read / failed / undelivered). We
// upsert a per-(MessageSid, status) row into imb_whatsapp_event so
// the full lifecycle of any one message can be reconstructed with a
// single query — even when out-of-order deliveries land status
// callbacks in an unexpected sequence.
//
// Doesn't fire an auto-reply (it's the wrong scenario for one) and
// doesn't carry a Body — only the message metadata + new status.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { validateTwilioRequest } = require("../../utils/twilioSignature");
const twiml = require("twilio").twiml;

const COLLECTION = "imb_whatsapp_event";

router.post("/", async function (req, res) {
  try {
    if (!validateTwilioRequest(req)) {
      console.warn("[twilio status] signature verification failed");
      return res.sendStatus(403);
    }

    // ACK immediately. Same empty-TwiML pattern as the inbound
    // handler — content-type isn't strictly required for status
    // callbacks but staying consistent keeps the two routes' wire
    // behaviour aligned.
    const empty = new twiml.MessagingResponse();
    res.type("text/xml").send(empty.toString());

    try {
      await persistStatus(req.body);
    } catch (e) {
      console.error("[twilio status] persistStatus failed:", e.message || e);
    }
  } catch (e) {
    console.error("[twilio status] handler error:", e.message || e);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

async function persistStatus(body) {
  if (!body || !body.MessageSid || !body.MessageStatus) {
    console.warn(
      "[twilio status] dropping event without MessageSid or MessageStatus",
    );
    return;
  }

  // Composite eventId so each status row stands alone — a single
  // message produces multiple status callbacks (queued → sent →
  // delivered → read) and we want them all queryable.
  const eventId = `${body.MessageSid}:${body.MessageStatus}`;

  const db = await connectToDatabase();
  await db.collection(COLLECTION).updateOne(
    { eventId },
    {
      $set: {
        eventId,
        provider: "twilio",
        kind: "status",
        messageSid: body.MessageSid,
        accountSid: body.AccountSid || null,
        from: body.From || null,
        to: body.To || null,
        status: body.MessageStatus,
        // Twilio sets these on failed/undelivered. Stored even when
        // empty so a query for `errorCode != null` still works as
        // expected (returns the missing-or-null rows distinct from
        // the failed ones).
        errorCode: body.ErrorCode || null,
        errorMessage: body.ErrorMessage || null,
        raw: body,
        receivedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

module.exports = router;
