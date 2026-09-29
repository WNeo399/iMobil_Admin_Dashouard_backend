// Public read endpoint for the Banner Carousel widget (iMobile website).
//
//   GET /widget/bannerCarousel/banners   the active banners, in order
//
// Same soft enforcement as the exploded-diagram reads: the per-widget CORS
// allowlist (widget name "banner-carousel", managed on the Widget Setting
// page) decides which sites' browsers may load it, with no hard in-handler
// 403 — the banners are public storefront content anyway. Its own gentle
// rate limit; mounted before the shared 10/hour submission limiter in
// widgetRoutes/index.js. Banners are managed in routes/websiteRoutes.

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { getAllowedOrigins } = require("../../utils/widgetOrigins");

const WIDGET_NAME = "banner-carousel";
const BANNERS = "imb_web_banners";
const DEVICES = ["desktop", "tablet", "mobile"];

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
      console.error("Banner widget CORS check failed:", e);
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
  skip: (req) => req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET,
});

router.use(readLimiter);
router.options("*", widgetCors);

// ── GET /widget/bannerCarousel/banners ──────────────────────────────
router.get("/banners", widgetCors, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const rows = await db
      .collection(BANNERS)
      .find({ active: true })
      .sort({ order: 1, createdAt: 1 })
      .limit(50)
      .toArray();

    const banners = rows
      .filter((b) => b.images && DEVICES.every((d) => b.images[d] && b.images[d].url))
      .map((b) => {
        const images = {};
        for (const d of DEVICES) {
          const img = b.images[d];
          images[d] = { url: img.url, width: img.width || null, height: img.height || null };
        }
        return {
          id: String(b._id),
          title: b.title || "",
          link: b.link || "",
          newTab: !!b.newTab,
          images,
        };
      });

    // A banner change shows on the site within a minute.
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ success: true, banners });
  } catch (e) {
    console.error("Banner widget error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the banners" });
  }
});

module.exports = router;
