// Oz matcher — the catalogue lookup half of the "Create Oz Order"
// tool. Parsing + row resolution happen client-side (SheetJS); this
// endpoint takes the already-resolved lines and matches each against
// imb_products following the algorithm in IMB-matching-feature-strategy.md §4.
//
//   POST /catalogue/match
//   body: { lines: ResolvedLine[] }
//   resp: { success, results: MatchResult[] }
//
// ResolvedLine = { model_id, color, category, requestedQuality, source? }
// MatchResult  = { line, status, skus[], availableQualities?, availableColours?, usedQuality? }
//
// Statuses: MATCHED, MATCHED_FALLBACK, NO_QUALITY, NO_COLOUR, NO_PART, MULTIPLE.

var express = require("express");
var router = express.Router();
const { requireAnyPermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const PRODUCTS = "imb_products";

// Reuse the Tools-page permission — the Oz tool lives there and only
// reads the catalogue.
const GATE = requireAnyPermission("zoho:salesOrder:create", "zoho:collection:view");

// Frame quality fallback chain (strategy §4a). When a `frame` line
// requests "No Small Parts" and it isn't stocked for that model, try
// these in order before declaring NO_QUALITY. Configurable here.
const FRAME_FALLBACK = {
  "no small parts": ["A+", "IMB"],
};

// Case/space-insensitive comparison key for quality + colour matching.
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

function shapeSku(p) {
  return {
    sku: p.sku,
    productName: p.productName,
    quality: (p.quality && p.quality.name) || "",
    color: p.color != null ? p.color : null,
  };
}

// Match a single resolved line against a pre-fetched pool of products
// (already filtered to model + category). Pure function over the pool
// so it's easy to reason about + unit-test.
function matchLine(line, pool) {
  const isScreen = norm(line.category) === "screen";
  const requestedQ = norm(line.requestedQuality);
  const requestedC = line.color ? norm(line.color) : null;

  if (!pool || pool.length === 0) {
    return { line, status: "NO_PART", skus: [] };
  }

  const availableQualities = [
    ...new Set(pool.map((p) => (p.quality && p.quality.name) || "").filter(Boolean)),
  ];

  // Resolve which quality we'll actually match on — the requested one,
  // or a fallback for frames.
  let effectiveQuality = requestedQ;
  let usedQuality = null; // set only when a fallback kicks in

  const hasQuality = (qNorm) =>
    pool.some((p) => norm(p.quality && p.quality.name) === qNorm);

  if (!hasQuality(requestedQ)) {
    // Frame fallback chain (only for frame + a configured requested grade).
    let fellBack = false;
    if (norm(line.category) === "frame" && FRAME_FALLBACK[requestedQ]) {
      for (const candidate of FRAME_FALLBACK[requestedQ]) {
        if (hasQuality(norm(candidate))) {
          effectiveQuality = norm(candidate);
          usedQuality = candidate;
          fellBack = true;
          break;
        }
      }
    }
    if (!fellBack) {
      return {
        line,
        status: "NO_QUALITY",
        skus: [],
        availableQualities,
      };
    }
  }

  const poolQ = pool.filter((p) => norm(p.quality && p.quality.name) === effectiveQuality);

  // Colour gate — screens carry no colour, so skip it for them.
  if (!isScreen && requestedC) {
    const availableColours = [
      ...new Set(poolQ.map((p) => (p.color != null ? p.color : null)).filter((c) => c != null)),
    ];
    const hasColour = poolQ.some((p) => norm(p.color) === requestedC);
    if (!hasColour) {
      return {
        line,
        status: "NO_COLOUR",
        skus: [],
        availableColours,
        // Surface the fallback even on a colour miss so the UI can
        // still show "A+ substituted" context when the user re-picks.
        usedQuality: usedQuality || undefined,
      };
    }
  }

  // Final matches: colour-filtered for non-screens, all of poolQ for screens.
  const matches =
    isScreen || !requestedC
      ? poolQ
      : poolQ.filter((p) => norm(p.color) === requestedC);

  const skus = matches.map(shapeSku);
  let status = usedQuality ? "MATCHED_FALLBACK" : "MATCHED";
  if (skus.length > 1) status = "MULTIPLE";

  const result = { line, status, skus };
  if (usedQuality) result.usedQuality = usedQuality;
  return result;
}

router.post("/match", GATE, async (req, res) => {
  try {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    if (lines.length === 0) {
      return res.json({ success: true, results: [] });
    }

    const db = await connectToDatabase();
    const collection = db.collection(PRODUCTS);

    // One pool query per line. Pools are small (a model+category slice),
    // and the (compatible_models.id, category.id) index makes each cheap;
    // fan out in parallel.
    const results = await Promise.all(
      lines.map(async (line) => {
        const modelId = line && line.model_id ? String(line.model_id) : "";
        const category = line && line.category ? String(line.category) : "";
        if (!modelId || !category) {
          return { line, status: "NO_PART", skus: [] };
        }
        const pool = await collection
          .find({ "compatible_models.id": modelId, "category.id": category })
          .toArray();
        return matchLine(line, pool);
      }),
    );

    return res.json({ success: true, results });
  } catch (e) {
    console.error("Oz match error:", e);
    return res.status(500).json({ success: false, message: "Match lookup failed" });
  }
});

module.exports = router;
