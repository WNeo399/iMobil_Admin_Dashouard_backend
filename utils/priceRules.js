// The pricing formula (user rule, 2026-09-16) for items that carry a cost
// price, evaluated with a ±5% tolerance. Shared by the daily snapshot and
// the price-push endpoint so both compute the same verdict.
//
//   Service pack (Samsung / iPhone / Google):
//     WholeSale (cost+2)×1.10 · SVIP ×1.15 · VIP ×1.20 · Platinum ×1.25
//   Screen / housing / battery / back cover:
//     WholeSale (cost+2)×1.10 · SVIP ×1.20 · VIP ×1.25 · Platinum ×1.30
//   Others:
//     WholeSale cost×1.15 (no +2) · SVIP (cost+2)×1.20 · VIP ×1.25 · Platinum ×1.30

// Rates that mean "not really priced yet" — they render but are never
// evaluated against the rule (the Missing Price tile owns them).
const PRICE_PLACEHOLDERS = new Set([9999.99, 9000, 8888, 7777, 7000, 6000]);

const DEVIATION = 0.05;
const r2 = (v) => Math.round(v * 100) / 100;

// Which formula family an item belongs to, from the signals the snapshot
// row carries: our catalogue category, Zoho classification, catalogue
// quality, and the item name as the fallback.
function priceRuleFamily(row) {
  const n = String(row.name || "").toLowerCase();
  const q = String(row.quality || "").toLowerCase();
  if (q.includes("service pack") || n.includes("service pack")) return "service-pack";
  const cat = String(row.category || "").toLowerCase();
  const cls = String(row.classification || "").toLowerCase();
  if (
    ["screen", "battery", "back cover glass", "frame"].includes(cat) ||
    cls.includes("lcd") ||
    cls === "battery" ||
    /housing|back ?cover|backcover|lcd|digitizer|\bscreen\b|battery/.test(n)
  ) {
    return "major-part";
  }
  return "other";
}

function expectedPrices(cost, family) {
  const c2 = cost + 2;
  if (family === "service-pack") {
    return { wholesale: r2(c2 * 1.1), svip: r2(c2 * 1.15), vip: r2(c2 * 1.2), platinum: r2(c2 * 1.25) };
  }
  if (family === "major-part") {
    return { wholesale: r2(c2 * 1.1), svip: r2(c2 * 1.2), vip: r2(c2 * 1.25), platinum: r2(c2 * 1.3) };
  }
  return { wholesale: r2(cost * 1.15), svip: r2(c2 * 1.2), vip: r2(c2 * 1.25), platinum: r2(c2 * 1.3) };
}

// Evaluate one row: { rule, expected, broken }. Only rates that actually
// exist (and aren't placeholders) are judged — a missing rate is the
// Missing Price tile's business, not a rule breach. No cost → no verdict.
function evaluatePriceRule(row) {
  const cost = Number(row.purchasePrice);
  if (!(cost > 0)) return { rule: null, expected: null, broken: false };
  const rule = priceRuleFamily(row);
  const expected = expectedPrices(cost, rule);
  const actual = {
    wholesale: row.priceWholesale,
    svip: row.priceSvip,
    vip: row.priceVip,
    platinum: row.pricePlatinum,
  };
  let broken = false;
  for (const k of Object.keys(expected)) {
    const a = actual[k];
    if (a == null || PRICE_PLACEHOLDERS.has(a)) continue;
    const e = expected[k];
    if (e > 0 && Math.abs(a - e) / e > DEVIATION) {
      broken = true;
      break;
    }
  }
  return { rule, expected, broken };
}

module.exports = { PRICE_PLACEHOLDERS, DEVIATION, priceRuleFamily, expectedPrices, evaluatePriceRule };
