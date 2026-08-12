// Public read endpoints for the Exploded Diagram widget.
//
//   GET /widget/explodedDiagram/catalog      brands → models → diagrams
//   GET /widget/explodedDiagram/diagram/:id  one published diagram
//
// Only PUBLISHED diagrams are visible here. Unlike the form widgets these
// are read-only GETs of non-sensitive data, so enforcement is softer:
// the per-widget CORS allowlist (widget name "exploded-diagram", managed
// on the Widget Setting page) decides which sites' browsers may embed,
// but there is no hard in-handler 403 — a curl of public catalog data is
// not worth failing closed over. A gentler dedicated rate limit applies
// (the shared /widget limiter is 10/hour, sized for form submissions —
// mounted before it in widgetRoutes/index.js).

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { getAllowedOrigins } = require("../../utils/widgetOrigins");

const WIDGET_NAME = "exploded-diagram";
const DIAGRAMS = "exploded_diagrams";

const widgetCors = cors({
  origin: async (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / direct requests
    try {
      const allowed = await getAllowedOrigins(WIDGET_NAME);
      if (allowed.has(origin)) return callback(null, origin);
      return callback(new Error(`Origin ${origin} not allowed`));
    } catch (e) {
      console.error("Exploded widget CORS check failed:", e);
      return callback(e);
    }
  },
  credentials: false,
  maxAge: 3600,
});

// Browsing the picker fires a handful of GETs — size the limit for a
// human clicking around, not a form being spammed.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
  skip: (req) => req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET,
});

router.use(readLimiter);
router.options("*", widgetCors);

// ── GET /widget/explodedDiagram/catalog ─────────────────────────────
router.get("/catalog", widgetCors, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const rows = await db
      .collection(DIAGRAMS)
      .find(
        { status: "published" },
        { projection: { brand: 1, model: 1, title: 1 } },
      )
      .sort({ brand: 1, model: 1, title: 1 })
      .limit(2000)
      .toArray();

    // brand → model → diagrams
    const brands = [];
    const brandIx = new Map();
    for (const r of rows) {
      let b = brandIx.get(r.brand);
      if (!b) {
        b = { brand: r.brand, models: [], _ix: new Map() };
        brandIx.set(r.brand, b);
        brands.push(b);
      }
      let m = b._ix.get(r.model);
      if (!m) {
        m = { model: r.model, diagrams: [] };
        b._ix.set(r.model, m);
        b.models.push(m);
      }
      m.diagrams.push({ id: String(r._id), title: r.title || "" });
    }
    brands.forEach((b) => delete b._ix);

    return res.json({ success: true, brands });
  } catch (e) {
    console.error("Exploded widget catalog error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the catalog" });
  }
});

// ── GET /widget/explodedDiagram/diagram/:id ─────────────────────────
router.get("/diagram/:id", widgetCors, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const d = await db
      .collection(DIAGRAMS)
      .findOne({ _id: new ObjectId(req.params.id), status: "published" });
    if (!d) return res.status(404).json({ success: false, message: "Diagram not found" });
    return res.json({
      success: true,
      diagram: {
        id: String(d._id),
        brand: d.brand,
        model: d.model,
        title: d.title || "",
        image: {
          url: d.image && d.image.url,
          width: d.image && d.image.width,
          height: d.image && d.image.height,
        },
        hotspots: (d.hotspots || []).map((h) => ({
          id: h.id,
          partNumber: h.partNumber || "",
          title: h.title || "",
          points: h.points,
          products: (h.products || []).map((p) => ({
            title: p.title || "",
            sku: p.sku || "",
            commerceId: p.commerceId || "",
            variantId: p.variantId || "",
            imageUrl: p.imageUrl || "",
            url: p.url || "",
          })),
        })),
      },
    });
  } catch (e) {
    console.error("Exploded widget diagram error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the diagram" });
  }
});

module.exports = router;
