// Public read endpoint for the Notification widget (iMobile website popup).
//
//   GET /widget/notification/active   the notifications inside their time
//                                     period right now (active ones only)
//
// The time period is decided here, on the server's clock, not the shopper's.
// The per-widget CORS allowlist (widget name "notification", managed on the
// Widget Setting page) decides which sites' browsers may load it: other
// origins get a 403; requests without an Origin (curl, the backend's own demo
// page) pass. Its own gentle rate limit; mounted before the shared 10/hour
// submission limiter in widgetRoutes/index.js. Notifications are managed in
// routes/websiteRoutes/notifications.js.

var express = require("express");
var cors = require("cors");
var crypto = require("crypto");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { getAllowedOrigins } = require("../../utils/widgetOrigins");

const WIDGET_NAME = "notification";
const NOTIFICATIONS = "imb_web_notifications";
// several at once pop up one after the other; this is enough of that
const MAX_AT_ONCE = 5;

const widgetCors = cors({
  origin: async (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / direct requests
    try {
      const allowed = await getAllowedOrigins(WIDGET_NAME);
      if (allowed.has(origin)) return callback(null, origin);
      // Refuse outright: app.js's global cors() has already answered "*",
      // so leaving the headers off would not stop the browser.
      const err = new Error(`Origin ${origin} not allowed`);
      err.status = 403;
      return callback(err);
    } catch (e) {
      console.error("Notification widget CORS check failed:", e);
      return callback(e);
    }
  },
  credentials: false,
  maxAge: 3600,
});

// One GET per page view; sized for shoppers browsing a site behind one
// shared IP (an office, a phone carrier), not for a form.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
});

// Changes with what the shopper reads, so a corrected notification shows again
// to those who closed it; a longer time period or the switch does not.
function versionOf(n) {
  return crypto.createHash("sha1").update([n.title, n.message, n.buttonText, n.link].join("\n")).digest("hex").slice(0, 10);
}

router.use(readLimiter);
router.options("*", widgetCors);

// ── GET /widget/notification/active ─────────────────────────────────
router.get("/active", widgetCors, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const now = new Date();
    const rows = await db
      .collection(NOTIFICATIONS)
      .find({ active: true, startAt: { $lte: now }, endAt: { $gte: now } })
      .sort({ startAt: -1 })
      .limit(MAX_AT_ONCE)
      .toArray();

    // A change shows on the site within a minute.
    res.set("Cache-Control", "public, max-age=60");
    return res.json({
      success: true,
      notifications: rows.map((n) => ({
        id: String(n._id),
        version: versionOf(n),
        title: n.title || "",
        message: n.message || "",
        buttonText: n.buttonText || "",
        link: n.link || "",
        newTab: !!n.newTab,
        frequency: n.frequency || "visit",
      })),
    });
  } catch (e) {
    console.error("Notification widget error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the notifications" });
  }
});

module.exports = router;
