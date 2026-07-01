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

// Per-category quality fallback chains. When a line's requested grade isn't
// stocked for that model, try these (in order) before declaring NO_QUALITY.
// Keys are normalised (lowercase) category + requested-quality. Configurable here.
//   frame: "No Small Parts" → A+ / IMB (strategy §4a)
//   back-cover-glass: "High Quality with Lens" → Original / Aftermarket, so a
//     "Back Cover" line still matches on models that only carry those grades.
const QUALITY_FALLBACK = {
  frame: {
    "no small parts": ["A+", "IMB"],
  },
  "back-cover-glass": {
    "high quality with lens": ["Original", "Aftermarket"],
  },
};

// Case/space-insensitive comparison key for quality + colour matching.
const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

// OZ orders must never use secondhand stock. The "secondhand" marker lives in
// the product NAME (e.g. "… [Secondhand] …") even when quality.name reads
// "Original", so check both. Such products are dropped from the match pool.
const SECONDHAND_RE = /second\s*hand/i;
function isSecondhand(p) {
  if (!p) return false;
  return (
    SECONDHAND_RE.test(p.productName || "") ||
    SECONDHAND_RE.test((p.quality && p.quality.name) || "")
  );
}

// Colour pre-match: a (possibly less-specific) sheet colour like "Black"
// matches a more-specific catalogue colour like "Black Titanium" when every
// word of the requested colour appears in the catalogue colour. `requestedNorm`
// is already normalised (lowercase). Used only when there's no exact match.
function colourTokenMatch(requestedNorm, dbColour) {
  const d = norm(dbColour);
  if (!requestedNorm || !d) return false;
  const rTokens = requestedNorm.split(/\s+/).filter(Boolean);
  if (rTokens.length === 0) return false;
  const dTokens = new Set(d.split(/\s+/).filter(Boolean));
  return rTokens.every((t) => dTokens.has(t));
}

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
    // Per-category fallback chain for the requested grade.
    let fellBack = false;
    const catFallback = QUALITY_FALLBACK[norm(line.category)];
    const chain = catFallback && catFallback[requestedQ];
    if (chain) {
      for (const candidate of chain) {
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
        // Full model+category pool so the UI can offer a "pick a product"
        // dropdown (any quality / colour) instead of just a grade re-pick.
        candidates: pool.map(shapeSku),
      };
    }
  }

  const poolQ = pool.filter((p) => norm(p.quality && p.quality.name) === effectiveQuality);

  // Colour matching — screens carry no colour, so skip it for them. Try an
  // exact colour first; if none, pre-match by token ("Black" → "Black
  // Titanium"). One match auto-selects below; several become MULTIPLE so the
  // user picks.
  let matches;
  if (isScreen || !requestedC) {
    matches = poolQ;
  } else {
    let cm = poolQ.filter((p) => norm(p.color) === requestedC);
    if (cm.length === 0) {
      cm = poolQ.filter((p) => colourTokenMatch(requestedC, p.color));
    }
    if (cm.length === 0) {
      const availableColours = [
        ...new Set(poolQ.map((p) => (p.color != null ? p.color : null)).filter((c) => c != null)),
      ];
      return {
        line,
        status: "NO_COLOUR",
        skus: [],
        availableColours,
        usedQuality: usedQuality || undefined,
        // Full model+category pool so the UI can offer a "pick a product"
        // dropdown instead of just a colour re-pick.
        candidates: pool.map(shapeSku),
      };
    }
    matches = cm;
  }

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
        const rawPool = await collection
          .find({ "compatible_models.id": modelId, "category.id": category })
          .toArray();
        // Never offer secondhand stock on an OZ order.
        const pool = rawPool.filter((p) => !isSecondhand(p));
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
