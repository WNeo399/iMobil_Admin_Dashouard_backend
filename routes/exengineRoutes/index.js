// ExEngine insights — sales analytics over the Exyon MySQL view
// `vw_invoiced_order_items` (one row per invoiced device). Mounted under the
// authenticated chain in app.js.
//
//   GET /exengine/insights?days=90  → { summary, window, topModels, trend, bySource }
//
// The raw view rows are fetched once and cached (the view has correlated
// subqueries, so we avoid re-scanning it per request); the aggregation runs in
// Node so the "fast moving" window and model grouping are easy to tune.

var express = require("express");
var router = express.Router();
const { exQuery } = require("../../utils/exDb");

const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, rows: null };

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Product Name is "Brand Model Capacity Colour Grade" (e.g. "Apple iPhone 16
// Pro Max 256GB Desert Titanium Grade A"). The model = the part before the
// capacity token; for items with no capacity (accessories) we cut at "Grade".
function extractModel(name) {
  let s = String(name || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+\d+\s?(GB|TB)\b.*$/i, ""); // drop capacity onward
  s = s.replace(/\s+Grade\b.*$/i, ""); // drop grade onward (no-capacity items)
  return s.trim() || "Unknown";
}

async function getRows() {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await exQuery(
    "SELECT `Product Name` AS name, `unit_price` AS price, `Invoice Date` AS invDate, " +
      "`Grade` AS grade, `Stock Source` AS source " +
      "FROM vw_invoiced_order_items WHERE `Invoice Date` IS NOT NULL",
  );
  cache = { at: Date.now(), rows };
  return rows;
}

function buildInsights(rows, days) {
  const now = Date.now();
  const winMs = days > 0 ? days * 86400000 : 0;

  let units = 0, revenue = 0, winUnits = 0, winRevenue = 0;
  let first = null, last = null;
  const monthMap = new Map(); // ym -> { units, revenue }
  const sourceMap = new Map(); // source -> { units, revenue }
  const winModels = new Map(); // model -> { units, revenue }  (within the window)
  const allModels = new Set();
  const modelMonth = new Map(); // model -> Map(ym -> units)   (all time)
  const modelTotal = new Map(); // model -> total units        (all time)

  for (const r of rows) {
    const d = r.invDate ? new Date(r.invDate) : null;
    if (!d || isNaN(d.getTime())) continue;
    const t = d.getTime();
    const price = Number(r.price) || 0;
    const model = extractModel(r.name);
    allModels.add(model);

    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
    units++; revenue += price;

    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const m = monthMap.get(ym) || { units: 0, revenue: 0 };
    m.units++; m.revenue += price; monthMap.set(ym, m);

    const src = r.source || "Unknown";
    const sm = sourceMap.get(src) || { units: 0, revenue: 0 };
    sm.units++; sm.revenue += price; sourceMap.set(src, sm);

    // Per-model monthly units (all time) for the comparative model trend.
    const mMonth = modelMonth.get(model) || new Map();
    mMonth.set(ym, (mMonth.get(ym) || 0) + 1);
    modelMonth.set(model, mMonth);
    modelTotal.set(model, (modelTotal.get(model) || 0) + 1);

    if (!winMs || now - t <= winMs) {
      winUnits++; winRevenue += price;
      const mm = winModels.get(model) || { units: 0, revenue: 0 };
      mm.units++; mm.revenue += price; winModels.set(model, mm);
    }
  }

  const topModels = [...winModels.entries()]
    .map(([model, v]) => ({
      model,
      units: v.units,
      revenue: round2(v.revenue),
      avgPrice: v.units ? round2(v.revenue / v.units) : 0,
    }))
    .sort((a, b) => b.units - a.units || b.revenue - a.revenue)
    .slice(0, 15);

  const trend = [...monthMap.entries()]
    .map(([ym, v]) => ({ ym, units: v.units, revenue: round2(v.revenue) }))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  const bySource = [...sourceMap.entries()]
    .map(([source, v]) => ({ source, units: v.units, revenue: round2(v.revenue) }))
    .sort((a, b) => b.units - a.units);

  // Comparative per-model monthly trend for the busiest models (all time),
  // each aligned to the overall `months` axis.
  const months = trend.map((t) => t.ym);
  const modelTrends = [...modelTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([model, total]) => {
      const mMonth = modelMonth.get(model) || new Map();
      return { model, total, units: months.map((ym) => mMonth.get(ym) || 0) };
    });

  return {
    range: { first: first ? new Date(first) : null, last: last ? new Date(last) : null },
    summary: { units, revenue: round2(revenue), avgPrice: units ? round2(revenue / units) : 0, models: allModels.size },
    window: { days, units: winUnits, revenue: round2(winRevenue), avgPrice: winUnits ? round2(winRevenue / winUnits) : 0 },
    topModels,
    trend,
    months,
    modelTrends,
    bySource,
  };
}

router.get("/insights", async function (req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 0), 3650);
    const rows = await getRows();
    const data = buildInsights(rows, days);
    return res.json({ success: true, ...data, syncedAt: new Date(cache.at) });
  } catch (error) {
    console.error("ExEngine insights error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load insights" });
  }
});

module.exports = router;
