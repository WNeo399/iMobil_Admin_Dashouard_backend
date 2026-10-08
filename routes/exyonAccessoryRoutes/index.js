// Exyon Accessories (2026-10-08) — Exyon's accessory orders, read from
// their MySQL table `exyon.accessory_orders` (one row per order line, filled
// by their webhook as orders come in from Reebelo / BackMarket …). Read-only.
// The table lives in the `exyon` schema (ExEngine v2), not the pool's default
// `exyon_au`, hence the schema prefix. Mounted under the authenticated chain
// in app.js.
//
//   GET /exyon-accessories/orders?from&to&channel&status&q&page&pageSize
//     → { rows, total, summary, channels, statuses }

var express = require("express");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { exQuery } = require("../../utils/exDb");

// Admin-only for now — only admin's wildcard carries exyon:*. Grant
// "exyon:accessory:view" to a role in constants/roles.js to widen.
const VIEW = requirePermission("exyon:accessory:view");

const TABLE = "exyon.accessory_orders";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The WHERE clause for the filters. `except` leaves one filter out (the
// channel / status option lists count everything the other filters keep).
function whereOf(query, except) {
  const parts = [];
  const params = [];
  const { from, to, channel, status } = query;
  const q = String(query.q || "").trim();
  if (DAY.test(from || "")) { parts.push("date_placed >= ?"); params.push(from); }
  if (DAY.test(to || "")) { parts.push("date_placed < DATE_ADD(?, INTERVAL 1 DAY)"); params.push(to); }
  if (channel && except !== "channel") { parts.push("sales_channel = ?"); params.push(String(channel)); }
  if (status && except !== "status") { parts.push("order_status = ?"); params.push(String(status)); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    parts.push("(order_id LIKE ? OR sku LIKE ? OR product_name LIKE ? OR customer_name LIKE ?)");
    params.push(like, like, like, like);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

// Dates come back as written in the table (no time-zone shift).
const COLUMNS = `id, order_line_id AS lineId, order_id AS orderId, sku, product_name AS productName,
  quantity, unit_price AS unitPrice, item_notes AS notes, order_status AS status,
  sales_channel AS channel, username AS account, customer_name AS customerName,
  customer_email AS customerEmail, grand_total AS orderTotal,
  DATE_FORMAT(date_placed, '%Y-%m-%d %H:%i:%s') AS datePlaced,
  detected_via AS detectedVia, source,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS receivedAt`;

router.get("/orders", VIEW, async function (req, res) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 200);
    const w = whereOf(req.query);
    const wChannel = whereOf(req.query, "channel");
    const wStatus = whereOf(req.query, "status");

    const [rows, [summary], channels, statuses] = await Promise.all([
      exQuery(`SELECT ${COLUMNS} FROM ${TABLE} ${w.sql} ORDER BY date_placed DESC, id DESC LIMIT ? OFFSET ?`,
        [...w.params, pageSize, (page - 1) * pageSize]),
      exQuery(`SELECT COUNT(*) AS line_count, COUNT(DISTINCT order_id) AS order_count,
          COALESCE(SUM(quantity), 0) AS units, COALESCE(SUM(quantity * unit_price), 0) AS sales
        FROM ${TABLE} ${w.sql}`, w.params),
      exQuery(`SELECT sales_channel AS value, COUNT(*) AS n FROM ${TABLE} ${wChannel.sql}
        GROUP BY sales_channel ORDER BY n DESC`, wChannel.params),
      exQuery(`SELECT order_status AS value, COUNT(*) AS n FROM ${TABLE} ${wStatus.sql}
        GROUP BY order_status ORDER BY n DESC`, wStatus.params),
    ]);

    return res.json({
      success: true,
      rows: rows.map((r) => ({ ...r, notes: String(r.notes || "").trim() })),
      total: Number(summary.line_count) || 0,
      summary: {
        orders: Number(summary.order_count) || 0,
        lines: Number(summary.line_count) || 0,
        units: Number(summary.units) || 0,
        sales: Math.round((Number(summary.sales) || 0) * 100) / 100,
      },
      channels: channels.filter((c) => c.value),
      statuses: statuses.filter((s) => s.value),
    });
  } catch (error) {
    console.error("Exyon accessory orders error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load the accessory orders" });
  }
});

module.exports = router;
