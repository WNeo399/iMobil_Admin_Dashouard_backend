// Public widget endpoints — receive submissions from the embeddable
// widgets shipped out of the iMobile_Widget repo.
//
// Mounted in app.js at /widget OUTSIDE the JWT-authenticated chain
// because the widgets run on third-party sites and can't carry our
// JWT. Defence in depth is layered up via:
//
//   1. CORS allowlist        Only origins in WIDGET_ALLOWED_ORIGINS
//                            get the Access-Control-Allow-Origin
//                            header. Browsers refuse to send credentials
//                            cross-origin without the matching ACAO.
//
//   2. Explicit origin check (in each route handler — see
//                             specialOrder.js). Rejects any submission
//                             whose Origin / Referer isn't on the
//                             allowlist, in case a non-browser client
//                             bypasses CORS.
//
//   3. Rate limit            Per-IP throttle to blunt abuse. Numbers
//                            are conservative for a form-style widget
//                            — bump if a legitimate use case needs
//                            more.
//
//   4. Honeypot              Implemented per-route. Bots fill every
//                            input including the hidden `_company`
//                            field, humans don't see it.
//
//   5. Strict input limits   Body size / file count / MIME enforced
//                            per route via multer + sharp.

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var router = express.Router();

const specialOrderRouter = require("./specialOrder");

// ── Origin allowlist ────────────────────────────────────────────────
// Parsed once at module load from comma-separated WIDGET_ALLOWED_ORIGINS.
// Empty / unset means "no origins allowed" — the widget can't talk to
// the backend at all until ops sets the env var. Failing closed is
// safer than failing open for a public endpoint.
const ALLOWED_ORIGINS = String(process.env.WIDGET_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
    console.warn(
        "[widget] WIDGET_ALLOWED_ORIGINS is empty — widget endpoints will reject all submissions. " +
            "Set the env var to a comma-separated list of origins to enable.",
    );
}

// Exported so per-route handlers can run the same allowlist check
// against Origin / Referer (CORS alone trusts the browser).
router.allowedOrigins = ALLOWED_ORIGINS;

// ── CORS middleware ────────────────────────────────────────────────
// Per-router so the rest of the backend keeps its existing
// permissive cors() (which the dashboard uses with credentials). The
// widget side stays restrictive.
const widgetCors = cors({
    origin(origin, callback) {
        // No Origin header — same-origin or curl-style call. Let it
        // through; the per-route origin check will still reject any
        // submission that needs an Origin (a real browser embed
        // always sends one).
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, origin);
        return callback(new Error(`Origin ${origin} not allowed`));
    },
    // Widgets don't send cookies — keep credentials off so a stolen
    // origin can't impersonate a logged-in user.
    credentials: false,
    // OPTIONS preflight responses cached for an hour so the browser
    // doesn't re-check on every submission.
    maxAge: 3600,
});

router.use(widgetCors);
// Explicitly handle OPTIONS so the preflight gets the right CORS
// headers even before reaching the per-route handler.
router.options("*", widgetCors);

// ── Rate limit ─────────────────────────────────────────────────────
// 10 submissions per IP per hour. Generous enough for a real user
// who keeps mis-clicking submit, tight enough that a spam burst
// dies fast. Defaults to in-memory storage; graduates to Redis when
// we run more than one backend instance.
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

module.exports = router;
