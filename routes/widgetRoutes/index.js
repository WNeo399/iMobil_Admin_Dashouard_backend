// Public widget endpoints — receive submissions from the embeddable
// widgets shipped out of the iMobile_Widget repo.
//
// Mounted in app.js at /widget OUTSIDE the JWT-authenticated chain
// because the widgets run on third-party sites and can't carry our
// JWT. Defence in depth is layered up via:
//
//   1. CORS allowlist        Per-widget, sourced from the
//                            imb_widget_origins collection (managed
//                            via the System → Widget Origins admin
//                            page). Applied PER-ROUTE in each sub-
//                            router so each widget's CORS check
//                            knows which widget's allowlist to use.
//
//   2. Explicit origin check (inside each route handler) — same
//                            lookup as CORS, but checked again
//                            against Origin / Referer so non-browser
//                            callers (curl, scripts) can't bypass.
//
//   3. Rate limit            Per-IP throttle to blunt abuse. Numbers
//                            are conservative for a form-style
//                            widget; bump if a legitimate use case
//                            needs more.
//
//   4. Honeypot              Implemented per-route. Bots fill every
//                            input including the hidden `_company`
//                            field, humans don't see it.
//
//   5. Strict input limits   Body size / file count / MIME enforced
//                            per route via multer + sharp.

var express = require("express");
var rateLimit = require("express-rate-limit");
var router = express.Router();

const specialOrderRouter = require("./specialOrder");
const svpEnquiryRouter = require("./svpEnquiry");

// ── Rate limit ─────────────────────────────────────────────────────
// 10 submissions per IP per hour. Generous enough for a real user
// who keeps mis-clicking submit, tight enough that a spam burst
// dies fast. Defaults to in-memory storage; graduates to Redis when
// we run more than one backend instance.
//
// CORS / origin checks moved OFF the router level when we made the
// allowlist per-widget — each sub-router now applies its own cors()
// middleware so the right widget's allowlist drives the check.
const widgetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many submissions from this IP. Please try again later.",
    },
    // Skip the limiter for our own dashboard if it ever calls these
    // endpoints (it shouldn't, but cheap insurance).
    skip: (req) => req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET,
});

router.use(widgetLimiter);

// ── Sub-routes ──────────────────────────────────────────────────────
router.use("/specialOrder", specialOrderRouter);
// Apple SVP lookup enquiries — server-to-server JSON (no images / origin
// allowlist), guarded by the rate limit above + an optional shared secret.
router.use("/svpEnquiry", svpEnquiryRouter);

module.exports = router;
