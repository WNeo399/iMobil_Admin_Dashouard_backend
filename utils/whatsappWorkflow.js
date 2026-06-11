// Twilio WhatsApp conversational state machine.
//
// Powers the special-order flow described in Phase 44:
//   - Customer messages our number → we reply with the list-picker
//     template (HXd44…) when no session is active.
//   - Customer taps "Special Order" → we start a session asking for
//     description + photos.
//   - Each subsequent message updates the session and triggers a
//     reply matching what's still missing:
//       text only         → "please send a photo"
//       photo only        → "please send a description"
//       both present      → thank you + complete the session
//   - Sessions auto-expire after 24h of silence so an abandoned
//     half-filled session can't trap a future customer.
//
// The webhook handler in routes/twilioRoutes/whatsappInbound.js calls
// `handleInboundMessage(body)` once persistence has landed. This
// module owns everything from there: detecting list-picker replies,
// loading/upserting the session, sending the right reply via Twilio's
// Messages API, and archiving completed orders.

const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("./mongodb");
const { getTwilioClient } = require("./twilioClient");
const {
  archiveSessionAsSpecialOrder,
} = require("./whatsappOrderArchive");

const SESSION_COLLECTION = "imb_whatsapp_session";

// The list-picker template that ships with the auto-reply. When the
// customer taps "Special Order" inside it, the payload `special_order_start`
// surfaces in the inbound webhook (see detectListPickerSelection
// below for the exact field).
const TEMPLATE_AUTOREPLY = "HXd444333a8f58cd76818012416fa9b9e1";
const OPTION_SPECIAL_ORDER = "special_order_start";

// 24h of silence → session auto-expires. Evaluated on every inbound
// message access; no background job needed.
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

let _indexEnsured = false;
async function ensureIndex(db) {
  if (_indexEnsured) return;
  // Hot lookup is "active session for this waId" → compound on
  // (waId, state) keeps it sub-ms even as the collection grows.
  await db
    .collection(SESSION_COLLECTION)
    .createIndex({ waId: 1, state: 1 });
  _indexEnsured = true;
}

// ── Public entry point ─────────────────────────────────────────────
/**
 * Handle a single inbound message AFTER the webhook handler has
 * already persisted the raw event into imb_whatsapp_event. Sends the
 * appropriate reply through Twilio's Messages API and mutates the
 * session collection along the way.
 *
 * Best-effort: throws nothing back to the webhook handler — every
 * failure path is logged. The customer-facing reply is the only
 * observable side effect.
 */
async function handleInboundMessage(body) {
  try {
    const waId = body && body.WaId;
    if (!waId) {
      console.warn("[whatsapp workflow] inbound without WaId — ignoring");
      return;
    }
    const db = await connectToDatabase();
    await ensureIndex(db);

    const pickedOption = detectListPickerSelection(body);

    // ── List-picker tap ────────────────────────────────────────
    if (pickedOption === OPTION_SPECIAL_ORDER) {
      const session = await upsertNewSession(db, body);
      await sendText(
        body.From,
        "Great — please send a description of what you'd like to order, along with one or more photos."
      );
      console.log(
        `[whatsapp workflow] started session ${session._id} for waId=${waId}`,
      );
      return;
    }

    // ── Load + expire-check session ────────────────────────────
    let session = await loadActiveSession(db, waId);
    if (session && isSessionExpired(session)) {
      await markSessionExpired(db, session._id);
      console.log(
        `[whatsapp workflow] expired stale session ${session._id} for waId=${waId}`,
      );
      session = null;
    }

    // ── No active session + freeform message → re-show picker ──
    if (!session) {
      await sendTemplate(body.From, TEMPLATE_AUTOREPLY);
      return;
    }

    // ── Active session — append + evaluate ─────────────────────
    const updated = await appendMessageToSession(db, session, body);

    const hasDescription =
      !!(updated.collected && updated.collected.description && updated.collected.description.trim());
    const hasImages =
      !!(updated.collected &&
        Array.isArray(updated.collected.images) &&
        updated.collected.images.length > 0);

    if (hasDescription && hasImages) {
      // Complete — archive into imb_special_orders then thank you.
      try {
        const orderId = await archiveSessionAsSpecialOrder(updated);
        console.log(
          `[whatsapp workflow] order ${orderId} archived for waId=${waId}`,
        );
      } catch (e) {
        // The customer's already done their part — we still mark the
        // session completed but record the archive failure so an
        // admin can re-process later (the raw images URLs are still
        // on the session doc until they expire).
        console.error(
          "[whatsapp workflow] archive failed:",
          e.message || e,
        );
      }
      await markSessionCompleted(db, updated._id);
      await sendText(
        body.From,
        "Thank you. Your special order request has been received. Our team will review the details and contact you shortly.",
      );
      return;
    }

    if (hasDescription && !hasImages) {
      await sendText(
        body.From,
        "Got it — please also send one or more photos of the item.",
      );
      return;
    }

    if (!hasDescription && hasImages) {
      await sendText(
        body.From,
        "Got the photo — please send a description of what you'd like to order.",
      );
      return;
    }

    // Neither yet — happens if the message was empty / unsupported
    // (e.g. emoji-only after trimming). Re-ask both.
    await sendText(
      body.From,
      "Please send a description of what you'd like to order, along with one or more photos.",
    );
  } catch (e) {
    // Last-resort safety net — the webhook handler has already
    // ACK'd Twilio so a throw here just logs and moves on.
    console.error(
      "[whatsapp workflow] handleInboundMessage error:",
      e.message || e,
    );
  }
}

// ── Detection ──────────────────────────────────────────────────────

// Robust detection for the "user tapped Special Order" event.
// Twilio's webhook payload for interactive-message replies has
// varied over the years; check the most specific fields first and
// fall back to body text matching as a last resort. The first real
// tap will log the entire payload (see logUnknownPickerOnce) so we
// can lock in the exact field for this account.
function detectListPickerSelection(body) {
  if (!body) return null;
  // Newer Twilio payloads: dedicated fields
  if (body.ListId) return String(body.ListId).trim();
  if (body.ListItemId) return String(body.ListItemId).trim();
  if (body.ItemId) return String(body.ItemId).trim();
  if (body.ButtonPayload) return String(body.ButtonPayload).trim();
  // Older / Quick Reply: ButtonText carries the visible label
  if (body.ButtonText) {
    const t = String(body.ButtonText).trim();
    if (/special\s*order/i.test(t)) return OPTION_SPECIAL_ORDER;
  }
  // Last resort: body text. Some accounts deliver the option's
  // label verbatim in Body when no payload was configured.
  if (body.Body && /^special\s*order$/i.test(String(body.Body).trim())) {
    return OPTION_SPECIAL_ORDER;
  }
  return null;
}

// ── Session helpers ────────────────────────────────────────────────

async function loadActiveSession(db, waId) {
  return db.collection(SESSION_COLLECTION).findOne({
    waId,
    state: "awaiting_input",
  });
}

function isSessionExpired(session) {
  if (!session) return true;
  const last = session.lastMessageAt || session.startedAt;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > SESSION_TIMEOUT_MS;
}

async function upsertNewSession(db, body) {
  const waId = body.WaId;
  const now = new Date();
  // If any active session already exists for this waId, mark it
  // expired before opening the new one — at most one active session
  // per number, simplifies the lookup contract.
  await db.collection(SESSION_COLLECTION).updateMany(
    { waId, state: "awaiting_input" },
    {
      $set: {
        state: "expired",
        expiredAt: now,
        expireReason: "restarted",
      },
    },
  );
  const doc = {
    waId,
    from: body.From || null,
    profileName: body.ProfileName || null,
    intent: "special_order",
    state: "awaiting_input",
    collected: {
      description: null,
      images: [],
    },
    startedAt: now,
    lastMessageAt: now,
    completedAt: null,
    messageSids: body.MessageSid ? [body.MessageSid] : [],
  };
  const result = await db
    .collection(SESSION_COLLECTION)
    .insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

// Pull description + media off the inbound payload and merge into
// the session. Returns the updated session document for downstream
// evaluation. Description is APPENDED with a newline separator —
// the customer might describe their order across multiple messages.
async function appendMessageToSession(db, session, body) {
  const text = body.Body ? String(body.Body).trim() : "";
  const numMedia = parseInt(body.NumMedia || "0", 10) || 0;
  const newImages = [];
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    if (!url) continue;
    newImages.push({
      twilioUrl: url,
      contentType: body[`MediaContentType${i}`] || null,
      receivedAt: new Date(),
    });
  }

  // Build a clean partial update so we don't rewrite the whole
  // collected object every time.
  const set = { lastMessageAt: new Date() };
  const push = {};

  if (text) {
    const prev =
      (session.collected && session.collected.description) || "";
    set["collected.description"] = prev ? `${prev}\n${text}` : text;
  }
  if (newImages.length > 0) {
    push["collected.images"] = { $each: newImages };
  }
  if (body.MessageSid) {
    push.messageSids = body.MessageSid;
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(push).length) update.$push = push;

  const result = await db.collection(SESSION_COLLECTION).findOneAndUpdate(
    { _id: session._id instanceof ObjectId ? session._id : new ObjectId(String(session._id)) },
    update,
    { returnDocument: "after" },
  );
  // Driver-version unwrap (same defensive pattern as the credit-note
  // patch endpoints).
  return result && (result.value || result);
}

async function markSessionExpired(db, sessionId) {
  await db.collection(SESSION_COLLECTION).updateOne(
    { _id: sessionId },
    {
      $set: {
        state: "expired",
        expiredAt: new Date(),
        expireReason: "timeout",
      },
    },
  );
}

async function markSessionCompleted(db, sessionId) {
  await db.collection(SESSION_COLLECTION).updateOne(
    { _id: sessionId },
    {
      $set: {
        state: "completed",
        completedAt: new Date(),
      },
    },
  );
}

// ── Outbound helpers ───────────────────────────────────────────────

async function sendText(to, body) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  const client = getTwilioClient();
  if (!from || !client) {
    console.warn(
      "[whatsapp workflow] outbound skipped — set TWILIO_WHATSAPP_NUMBER + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.",
    );
    return;
  }
  await client.messages.create({ from, to, body });
}

async function sendTemplate(to, contentSid, contentVariables) {
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  const client = getTwilioClient();
  if (!from || !client) {
    console.warn(
      "[whatsapp workflow] outbound skipped — set TWILIO_WHATSAPP_NUMBER + TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN.",
    );
    return;
  }
  const payload = { from, to, contentSid };
  if (contentVariables) {
    payload.contentVariables = JSON.stringify(contentVariables);
  }
  await client.messages.create(payload);
}

module.exports = {
  handleInboundMessage,
  // Exported for direct testing / observability — not used by the
  // route handler.
  detectListPickerSelection,
  SESSION_COLLECTION,
};
