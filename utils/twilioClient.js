// Lazy Twilio REST client for outbound message sends.
//
// Same lazy-build pattern as the S3 client: a missing env var should
// surface as a clear error on first use, not crash the whole backend
// at boot. Returns null when the env isn't configured so callers can
// decide whether to skip (best-effort sends) or 500 (required sends).

const twilio = require("twilio");

let cachedClient = null;

function getTwilioClient() {
  if (cachedClient) return cachedClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  cachedClient = twilio(sid, token);
  return cachedClient;
}

module.exports = { getTwilioClient };
