// Public Apple SVP serial lookup — the genuine-parts check the lookup site
// hits (server-to-server) for each serial. Read-only; no JWT.
//
//   GET /svp/lookup?serial=...  → { success, found, serial }
//
// Mounted OUTSIDE the authenticated chain in app.js. Protected by a per-IP
// rate limit, which the trusted lookup server bypasses by sending the shared
// secret (x-svp-secret === SVP_SUBMIT_SECRET) — otherwise every customer's
// lookup would funnel through the one lookup-server IP and exhaust the limit.

var express = require("express");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { normalizeSerial } = require("../../utils/svpSerial");

const COLLECTION = "imb_svp_serials";

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // per IP per minute for untrusted/direct callers
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many lookups — slow down." },
  // The lookup server authenticates with the shared secret and isn't throttled.
  skip: (req) =>
    !!process.env.SVP_SUBMIT_SECRET &&
    req.get("x-svp-secret") === process.env.SVP_SUBMIT_SECRET,
});

router.get("/lookup", lookupLimiter, async function (req, res) {
  try {
    const serial = normalizeSerial(req.query.serial);
    if (!serial) {
      return res
        .status(400)
        .json({ success: false, message: "A serial number is required." });
    }
    const db = await connectToDatabase();
    // _id IS the normalized serial, so this is an indexed point lookup.
    const hit = await db.collection(COLLECTION).findOne(
      { _id: serial },
      { projection: { _id: 1 } },
    );
    return res.json({ success: true, found: !!hit, serial });
  } catch (error) {
    console.error("SVP public lookup error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Lookup failed. Please try again." });
  }
});

module.exports = router;
