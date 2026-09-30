// Public read endpoints for the Spare Parts widget (iMobile website, user ask
// 2026-09-30): browse the live spare parts by Brand → Series → Model → part
// type, or search. No prices (the user's choice); each part carries its Zoho
// item id, and the widget links it to imobilestore.com.au/products/<id>.
//
//   GET /widget/spareParts/catalog               brands → series → models
//   GET /widget/spareParts/parts?brand=&model=   the parts for one model
//   GET /widget/spareParts/parts?tools=1         the tools
//   GET /widget/spareParts/search?q=             matching models and parts
//
// Everything comes from utils/sparePartsCatalog (the stock register, kept 10
// minutes in memory) — no Zoho calls. The per-widget CORS allowlist (widget
// name "spare-parts", managed on the Widget Setting page) decides which
// sites' browsers may load it: other origins get a 403; requests without an
// Origin (curl, the backend's own demo page) pass. Its own rate limit,
// mounted before the shared 10/hour submission limiter in widgetRoutes.

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { getAllowedOrigins } = require("../../utils/widgetOrigins");
const { getCatalog, partsForModel, toolParts, search, TYPE_LABELS, PRODUCT_BASE } = require("../../utils/sparePartsCatalog");

const WIDGET_NAME = "spare-parts";

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
      console.error("Spare parts widget CORS check failed:", e);
      return callback(e);
    }
  },
  credentials: false,
  maxAge: 3600,
});

// A shopper clicks through a few models and searches as they type (the
// widget waits for a pause), behind a shared IP at times.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
  skip: (req) => req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET,
});

router.use(readLimiter);
router.options("*", widgetCors);

const text = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);
const cacheFor = (res, secs) => res.set("Cache-Control", `public, max-age=${secs}`);

function fail(res, e, what) {
  console.error(`Spare parts widget ${what} error:`, e && e.message);
  return res.status(502).json({ success: false, message: "Parts are not available right now" });
}

// ── GET /widget/spareParts/catalog ──────────────────────────────────
router.get("/catalog", widgetCors, async (req, res) => {
  try {
    const cat = await getCatalog();
    cacheFor(res, 300);
    return res.json({
      success: true,
      updatedAt: cat.at,
      productBase: PRODUCT_BASE,
      typeLabels: TYPE_LABELS,
      parts: cat.counts.parts,
      tools: cat.counts.tools,
      brands: cat.brands,
    });
  } catch (e) {
    return fail(res, e, "catalog");
  }
});

// ── GET /widget/spareParts/parts ────────────────────────────────────
router.get("/parts", widgetCors, async (req, res) => {
  try {
    const cat = await getCatalog();
    let items;
    if (req.query.tools === "1") items = toolParts(cat);
    else {
      const brand = text(req.query.brand, 60);
      const model = text(req.query.model);
      if (!brand || !model) return res.status(400).json({ success: false, message: "Pick a model" });
      items = partsForModel(cat, brand, model);
    }
    cacheFor(res, 300);
    return res.json({ success: true, items });
  } catch (e) {
    return fail(res, e, "parts");
  }
});

// ── GET /widget/spareParts/search ───────────────────────────────────
router.get("/search", widgetCors, async (req, res) => {
  try {
    const q = text(req.query.q, 80);
    if (q.length < 2) return res.json({ success: true, models: [], items: [], total: 0 });
    const cat = await getCatalog();
    cacheFor(res, 120);
    return res.json({ success: true, ...search(cat, q) });
  } catch (e) {
    return fail(res, e, "search");
  }
});

module.exports = router;
