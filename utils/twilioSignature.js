// Twilio webhook signature verification.
//
// Twilio computes the X-Twilio-Signature header as:
//   HMAC-SHA1(authToken, fullPublicUrl + sortedKeyValuePairs)
//   then base64-encoded.
//
// "fullPublicUrl" must match EXACTLY what Twilio called — including
// protocol, host, port, path, AND any query string. On Railway we sit
// behind a proxy, so req.host and req.protocol can drift from the
// outside-facing URL; we rebuild it from PUBLIC_BASE_URL (set in
// .env) + req.originalUrl, which is what Twilio actually saw.
//
// We use the official Twilio SDK's validateRequest because the
// canonicalisation (encoded characters, repeated keys, …) has edge
// cases we don't want to re-implement.

const twilio = require("twilio");

function publicUrl(req) {
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    // Fall back to whatever the request reports — works in local dev
    // when PUBLIC_BASE_URL is unset, but Railway will misvalidate
    // unless the env var is set. Logged loudly so the misconfig is
    // findable.
    console.warn(
      "[twilio] PUBLIC_BASE_URL is not set — falling back to req-derived URL; production webhooks may fail signature verification.",
    );
    return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  }
  return base + req.originalUrl;
}

/**
 * Validate the X-Twilio-Signature on an incoming webhook.
 *
 * Returns true when the signature matches OR when the env explicitly
 * skips validation (TWILIO_SKIP_SIG_CHECK=true — for local manual
 * testing only, never in production).
 */
function validateTwilioRequest(req) {
  if (process.env.TWILIO_SKIP_SIG_CHECK === "true") {
    return true;
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error(
      "[twilio] TWILIO_AUTH_TOKEN is not set — all webhooks will be rejected. Set it in .env.",
    );
    return false;
  }
  const signature = req.get("X-Twilio-Signature");
  if (!signature) return false;
  // req.body is already parsed by express.urlencoded() before this
  // runs — Twilio's POSTs are application/x-www-form-urlencoded so
  // we get the flat key→value map validateRequest expects.
  return twilio.validateRequest(
    authToken,
    signature,
    publicUrl(req),
    req.body || {},
  );
}

module.exports = { validateTwilioRequest };
