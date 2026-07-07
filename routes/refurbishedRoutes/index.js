// Refurbished Phones — read-only views over the external scraper MySQL's
// stg_reebelo_offers table (Reebelo marketplace offer snapshots, one row per
// offer per scrape date). Defaults to the latest scrape date (current snapshot).
//
//   GET /refurbished/summary?date=  → dashboard aggregates
//   GET /refurbished/filters?date=  → distinct brands / grades / sellers / dates
//   GET /refurbished/offers?…       → paginated, filterable list
//
// Mounted under the authenticated chain in app.js. Gated by refurb:offer:view.

var express = require("express");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { query } = require("../../utils/scraperDb");

const VIEW = requirePermission("refurb:offer:view");
const TABLE = "stg_reebelo_offers";

async function latestDate() {
  const rows = await query(`SELECT MAX(scraped_date) d FROM ${TABLE}`);
  return (rows[0] && rows[0].d) || null;
}

// Requested date (validated YYYY-MM-DD) or the latest snapshot.
async function resolveDate(req) {
  const d = String(req.query.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return latestDate();
}

// ── GET /refurbished/summary ────────────────────────────────────────
router.get("/summary", VIEW, async function (req, res) {
  try {
    const date = await resolveDate(req);
    if (!date) return res.json({ success: true, date: null, empty: true });

    const [totals] = await query(
      `SELECT COUNT(*) offers, COUNT(DISTINCT model) models, COUNT(DISTINCT sold_by) sellers,
              MIN(price) minPrice, MAX(price) maxPrice, ROUND(AVG(price)) avgPrice
       FROM ${TABLE} WHERE scraped_date = ?`, [date]);
    const byBrand = await query(
      `SELECT brand, COUNT(*) count, ROUND(AVG(price)) avgPrice FROM ${TABLE}
       WHERE scraped_date = ? AND brand IS NOT NULL AND brand <> ''
       GROUP BY brand ORDER BY count DESC LIMIT 12`, [date]);
    const byGrade = await query(
      `SELECT grade, COUNT(*) count FROM ${TABLE}
       WHERE scraped_date = ? AND grade IS NOT NULL AND grade <> ''
       GROUP BY grade ORDER BY count DESC`, [date]);
    const topSellers = await query(
      `SELECT sold_by seller, COUNT(*) count, ROUND(AVG(price)) avgPrice FROM ${TABLE}
       WHERE scraped_date = ? AND sold_by IS NOT NULL AND sold_by <> ''
       GROUP BY sold_by ORDER BY count DESC LIMIT 10`, [date]);
    const priceBands = await query(
      `SELECT CASE
                WHEN price < 200 THEN '<$200'
                WHEN price < 500 THEN '$200-500'
                WHEN price < 1000 THEN '$500-1k'
                WHEN price < 2000 THEN '$1k-2k'
                ELSE '$2k+'
              END band, COUNT(*) count
       FROM ${TABLE} WHERE scraped_date = ? AND price IS NOT NULL
       GROUP BY band`, [date]);
    const [meta] = await query(
      `SELECT COUNT(DISTINCT scraped_date) days, MAX(scraped_date) latest FROM ${TABLE}`);

    return res.json({
      success: true, date,
      totals: totals || {},
      byBrand, byGrade, topSellers, priceBands,
      meta: meta || {},
    });
  } catch (error) {
    console.error("Refurbished summary error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load summary" });
  }
});

// ── GET /refurbished/filters ────────────────────────────────────────
router.get("/filters", VIEW, async function (req, res) {
  try {
    const date = await resolveDate(req);
    if (!date) return res.json({ success: true, brands: [], grades: [], sellers: [], dates: [] });
    const brands = await query(`SELECT DISTINCT brand FROM ${TABLE} WHERE scraped_date=? AND brand IS NOT NULL AND brand<>'' ORDER BY brand`, [date]);
    const grades = await query(`SELECT DISTINCT grade FROM ${TABLE} WHERE scraped_date=? AND grade IS NOT NULL AND grade<>'' ORDER BY grade`, [date]);
    const sellers = await query(`SELECT DISTINCT sold_by FROM ${TABLE} WHERE scraped_date=? AND sold_by IS NOT NULL AND sold_by<>'' ORDER BY sold_by`, [date]);
    const dates = await query(`SELECT DISTINCT scraped_date d FROM ${TABLE} ORDER BY scraped_date DESC LIMIT 90`);
    return res.json({
      success: true, date,
      brands: brands.map((r) => r.brand),
      grades: grades.map((r) => r.grade),
      sellers: sellers.map((r) => r.sold_by),
      dates: dates.map((r) => r.d),
    });
  } catch (error) {
    console.error("Refurbished filters error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load filters" });
  }
});

// ── GET /refurbished/offers ─────────────────────────────────────────
const SORTABLE = {
  price: "price", brand: "brand", model: "model", grade: "grade",
  seller: "sold_by", stock: "stock", title: "title",
};
router.get("/offers", VIEW, async function (req, res) {
  try {
    const date = await resolveDate(req);
    if (!date) return res.json({ success: true, total: 0, rows: [], date: null });

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);
    const where = ["scraped_date = ?"];
    const params = [date];
    if (req.query.brand) { where.push("brand = ?"); params.push(String(req.query.brand)); }
    if (req.query.grade) { where.push("grade = ?"); params.push(String(req.query.grade)); }
    if (req.query.seller) { where.push("sold_by = ?"); params.push(String(req.query.seller)); }
    const search = String(req.query.search || "").trim();
    if (search) {
      where.push("(title LIKE ? OR model LIKE ? OR vendor_sku LIKE ? OR reebelo_sku_id LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.join(" AND ");
    const sortCol = SORTABLE[String(req.query.sort)] || "price";
    const order = String(req.query.order).toLowerCase() === "asc" ? "ASC" : "DESC";

    const [{ total }] = await query(`SELECT COUNT(*) total FROM ${TABLE} WHERE ${whereSql}`, params);
    const rows = await query(
      `SELECT id, title, brand, model, variant_colour, internal_memory, battery_health,
              grade, price, sold_by, stock, scraped_date, detail_url, reebelo_detail_url
       FROM ${TABLE} WHERE ${whereSql}
       ORDER BY ${sortCol} ${order}, id ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);

    return res.json({ success: true, date, total, page, pageSize, rows });
  } catch (error) {
    console.error("Refurbished offers error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load offers" });
  }
});

module.exports = router;
