// Exyon Accessories (2026-10-08) — Exyon's accessory orders, read from
// their MySQL table `exyon.accessory_orders` (one row per order line, filled
// by their webhook as orders come in from Reebelo / BackMarket …). Read-only.
// The table lives in the `exyon` schema (ExEngine v2), not the pool's default
// `exyon_au`, hence the schema prefix. Mounted under the authenticated chain
// in app.js.
//
//   GET /exyon-accessories/orders?from&to&channel&status&q&page&pageSize
//     → { rows, total, summary, channels, statuses }
//   GET /exyon-accessories/dispatch?channel&status&q
//     → { bySku, multiLine, onPickList, summary, channels, statuses }
//     every order carries `envelope` { size, reasons } (utils/exyonEnvelope)
//   GET  /exyon-accessories/pick-lists              → { lists, today }
//   GET  /exyon-accessories/pick-lists/:day         → { list, lines, summary }
//   POST /exyon-accessories/pick-lists/:day/remove  { orderId }
//   POST /exyon-accessories/pick-lists/today/process { orders: [{ orderId, tracking }] }
//   POST /exyon-accessories/pick-lists/:day/dispatch { orders: [...] } — Confirm dispatch → Neto
//   GET  /exyon-accessories/labels?orderIds=A,B   → shipping label data (address from Neto)

var express = require("express");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { exQuery } = require("../../utils/exDb");
const { connectToDatabase } = require("../../utils/mongodb");
const { imageUrlFromId } = require("../../utils/productImage");
const { zohoIdsForSkus, netoCall } = require("../../utils/neto");
const { envelopeOf } = require("../../utils/exyonEnvelope");

// Admin (*:*:*) and the Exyon Operation role (2026-10-08) — nobody else
// holds exyon:accessory:* (constants/roles.js).
const VIEW = requirePermission("exyon:accessory:view");
// Processing orders onto a pick list / taking one off.
const PICK_EDIT = requirePermission("exyon:accessory:picklist");
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;

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

    const zoho = await zohoItemsFor(rows.map((r) => r.sku));
    return res.json({
      success: true,
      rows: rows.map((r) => {
        const z = zoho.get(String(r.sku || "").trim()) || {};
        return { ...r, notes: String(r.notes || "").trim(), zohoSku: z.zohoSku || "", zohoName: z.zohoName || "", image: z.image || null };
      }),
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

// ── Dispatch ────────────────────────────────────────────────────────────
// The orders still to process (status Pick or New), grouped the way the
// warehouse works through them (user 2026-10-08):
//   bySku     — orders of one SKU, grouped by that SKU (same item together)
//   sameItems — orders of several SKUs whose items match exactly (same SKUs,
//               same quantities), two or more orders per group
//   multiLine — the other several-SKU orders, one by one
// Lines of one order with the same SKU count as one item (quantities added).
// A search keeps whole orders (any line matching), so the groups stay true.
const OPEN_STATUSES = ["pick", "new"];
const skuKey = (sku) => String(sku || "").trim().toLowerCase();
const byPlaced = (a, b) => String(a.datePlaced || "").localeCompare(String(b.datePlaced || "")) || String(a.orderId).localeCompare(String(b.orderId));

function ordersOf(rows) {
  const orders = new Map();
  for (const r of rows) {
    let o = orders.get(r.orderId);
    if (!o) {
      o = { orderId: r.orderId, channel: r.channel, account: r.account, customerName: r.customerName, status: r.status,
        orderTotal: r.orderTotal, datePlaced: r.datePlaced, items: new Map() };
      orders.set(r.orderId, o);
    }
    if (r.datePlaced && (!o.datePlaced || r.datePlaced < o.datePlaced)) o.datePlaced = r.datePlaced;
    const k = skuKey(r.sku);
    const it = o.items.get(k);
    if (it) { it.quantity += Number(r.quantity) || 0; it.lineIds.push(r.lineId); }
    else o.items.set(k, { sku: String(r.sku || "").trim(), productName: r.productName || "", quantity: Number(r.quantity) || 0, unitPrice: r.unitPrice, lineIds: [r.lineId] });
  }
  return [...orders.values()].map((o) => ({ ...o, items: [...o.items.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, it]) => it) }));
}

// Our Zoho item for each Neto SKU — its photo, Zoho SKU, name and shelf
// location. Neto's zoho_id (custom field Misc38) decides (user 2026-10-08);
// a SKU without one falls back to the same SKU in our register, or the
// number in an iShield code ("ishld12774" → 12774). A Neto or register
// failure only loses the photos / locations.
const skuFallbacks = (sku) => {
  const s = String(sku || "").trim();
  const m = /^ishld(\d{3,6})(?:-|$)/i.exec(s);
  return m ? [s, m[1]] : [s];
};
// "N/A" on the register means no location
const cleanLocation = (v) => {
  const s = String(v || "").trim();
  return /^n\/?a$/i.test(s) ? "" : s;
};
async function zohoItemsFor(skus) {
  const out = new Map();
  const list = [...new Set(skus.map((s) => String(s || "").trim()).filter(Boolean))];
  if (!list.length) return out;
  let ids = new Map();
  try {
    ids = await zohoIdsForSkus(list);
  } catch (e) {
    console.error("Exyon accessories — Neto zoho_id:", e.message);
  }
  try {
    const db = await connectToDatabase();
    const col = db.collection("imb_stock_items");
    const proj = { projection: { _id: 0, itemId: 1, sku: 1, name: 1, imageId: 1, location: 1, active: 1 } };
    const idList = [...new Set([...ids.values()].filter(Boolean))];
    const byId = new Map((idList.length ? await col.find({ itemId: { $in: idList } }, proj).toArray() : []).map((r) => [String(r.itemId), r]));
    const wanted = [...new Set(list.filter((s) => !ids.get(s)).flatMap(skuFallbacks))];
    const bySku = new Map();
    for (const r of wanted.length ? await col.find({ sku: { $in: wanted } }, proj).toArray() : []) {
      if (!bySku.has(r.sku) || r.active !== false) bySku.set(r.sku, r); // an active one wins
    }
    for (const s of list) {
      const id = ids.get(s);
      const r = id ? byId.get(id) : skuFallbacks(s).map((c) => bySku.get(c)).find(Boolean);
      if (r) {
        out.set(s, { zohoId: String(r.itemId), zohoSku: r.sku || "", zohoName: r.name || "", location: cleanLocation(r.location), image: imageUrlFromId(r.imageId), via: id ? "neto" : "sku" });
      } else if (id) {
        // Neto names a Zoho item our register doesn't hold (e.g. an inactive one)
        out.set(s, { zohoId: id, zohoSku: "", zohoName: "", location: "", image: null, via: "neto" });
      }
    }
  } catch (e) {
    console.error("Exyon accessories — our items:", e.message);
  }
  return out;
}

// The open orders (Pick / New) as orders with their items, optionally of
// one channel / status.
async function openOrders({ channel, status } = {}) {
  const parts = ["LOWER(TRIM(order_status)) IN (?)"];
  const params = [OPEN_STATUSES];
  if (channel) { parts.push("sales_channel = ?"); params.push(String(channel)); }
  if (status) { parts.push("order_status = ?"); params.push(String(status)); }
  const rows = await exQuery(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${parts.join(" AND ")} ORDER BY date_placed, id LIMIT 5000`, params);
  return ordersOf(rows);
}

// ── Neto's status of the open orders (2026-10-20) ───────────────────────
// Exyon's table keeps an order at Pick for good — it is dispatched in Neto
// (by hand there, or by Confirm dispatch on a pick list) and the table never
// hears (on 2026-10-20 669 of its 676 "open" orders were Dispatched in Neto).
// So the open orders are checked against Neto and its dispatched / cancelled
// ones drop out (user). Answers are kept in Mongo: a final one for good, an
// open one re-asked after a few minutes. Neto out of reach → the cached
// answers only (`checked: false`), the page still loads.
const NETO_STATUS = "exyon_neto_status";
const NETO_FINAL = ["Dispatched", "Cancelled"];
const NETO_OPEN_TTL = 5 * 60 * 1000;
async function netoStatusesOf(orderIds) {
  const statuses = new Map();
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return { statuses, checked: true };
  const db = await connectToDatabase();
  const col = db.collection(NETO_STATUS);
  const now = Date.now();
  const cached = new Map((await col.find({ _id: { $in: ids } }).toArray()).map((c) => [c._id, c]));
  for (const [id, c] of cached) statuses.set(id, c.status);
  const ask = ids.filter((id) => {
    const c = cached.get(id);
    return !c || (!NETO_FINAL.includes(c.status) && now - new Date(c.checkedAt).getTime() > NETO_OPEN_TTL);
  });
  try {
    for (let i = 0; i < ask.length; i += 100) {
      const part = ask.slice(i, i + 100);
      const d = await netoCall("GetOrder", { Filter: { OrderID: part, OutputSelector: ["OrderID", "OrderStatus"] } });
      const got = new Map([].concat(d.Order || []).map((o) => [String(o.OrderID), String(o.OrderStatus || "")]));
      const at = new Date();
      // one Neto doesn't know is kept as "" (open) — asked again later
      const ops = part.map((id) => ({ updateOne: { filter: { _id: id }, update: { $set: { status: got.get(id) || "", checkedAt: at } }, upsert: true } }));
      await col.bulkWrite(ops, { ordered: false });
      for (const id of part) statuses.set(id, got.get(id) || "");
    }
    return { statuses, checked: true };
  } catch (e) {
    console.error("Exyon accessories — Neto order status:", e.message);
    return { statuses, checked: false };
  }
}
async function rememberNetoStatus(orderId, status) {
  const db = await connectToDatabase();
  await db.collection(NETO_STATUS).updateOne({ _id: orderId }, { $set: { status, checkedAt: new Date() } }, { upsert: true });
}

// ── Pick lists (our records) ────────────────────────────────────────────
// One document per day (Melbourne date, like the packing lists), holding a
// snapshot of each order added that day: its items, our item for each SKU,
// and whether it is a single-SKU or a several-SKU ("multi-line") order.
const PICK_LISTS = "exyon_pick_lists";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// a list removed by hand is kept, marked deleted (its `day` renamed so the
// date is free again) — every read leaves it out
const LIVE_LIST = { deletedAt: { $exists: false } };
const todayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" }); // YYYY-MM-DD
let pickIndexReady = false;
async function pickLists() {
  const db = await connectToDatabase();
  const col = db.collection(PICK_LISTS);
  if (!pickIndexReady) {
    await col.createIndex({ day: 1 }, { unique: true });
    await col.createIndex({ "orders.orderId": 1 });
    pickIndexReady = true;
  }
  return col;
}
// orderId → { day, tracking, dispatch } of the pick list entry it is on
// (tracking set once the order is processed on the Dispatch page; dispatch
// once the list's dispatch is confirmed — dispatched / held / failed)
async function pickEntriesOf(orderIds) {
  const out = new Map();
  if (!orderIds.length) return out;
  try {
    const col = await pickLists();
    const docs = await col.find({ "orders.orderId": { $in: orderIds }, ...LIVE_LIST }, { projection: { day: 1, "orders.orderId": 1, "orders.tracking": 1, "orders.dispatch": 1 } }).toArray();
    const wanted = new Set(orderIds);
    for (const d of docs) for (const o of d.orders || []) if (wanted.has(o.orderId)) out.set(o.orderId, { day: d.day, tracking: o.tracking || "", dispatch: o.dispatch || null });
  } catch (e) {
    console.error("Exyon pick lists — days:", e.message);
  }
  return out;
}
// an order as stored on a pick list — as it is now, so a later change in
// Exyon does not alter a printed list
function pickSnapshotOf(o, zoho, now, by) {
  return {
    orderId: o.orderId,
    channel: o.channel || "",
    account: o.account || "",
    customerName: o.customerName || "",
    status: o.status || "",
    datePlaced: o.datePlaced || null,
    multi: o.items.length > 1,
    items: o.items.map((it) => {
      const z = zoho.get(it.sku) || {};
      return { sku: it.sku, productName: it.productName, quantity: it.quantity, lineIds: it.lineIds, zohoId: z.zohoId || "", zohoSku: z.zohoSku || "", zohoName: z.zohoName || "", location: z.location || "", image: z.image || null };
    }),
    addedAt: now,
    addedBy: by,
  };
}
const unitsOf = (o) => (o.items || []).reduce((t, it) => t + (Number(it.quantity) || 0), 0);
// a day's pick list: one line per Zoho item (Neto SKUs that are the same
// Zoho item pick together; a SKU with no Zoho item stands alone) — the units
// from single-SKU orders, from several-SKU orders, and in all. Items with
// single-line units first, then the multi-line-only ones; each part in shelf
// location order (the walk through the warehouse), then by name.
const lineKeyOf = (it) => (it.zohoSku ? `z:${String(it.zohoSku).trim().toLowerCase()}` : `s:${skuKey(it.sku)}`);
function pickLinesOf(list) {
  const lines = new Map();
  for (const o of list.orders || []) {
    for (const it of o.items || []) {
      const k = lineKeyOf(it);
      const l = lines.get(k) || { key: k, zohoSku: it.zohoSku || "", zohoName: it.zohoName || "", location: it.location || "", productName: it.productName || "", netoSkus: [], image: it.image || null, single: 0, multi: 0, total: 0, orders: 0 };
      const q = Number(it.quantity) || 0;
      if (o.multi) l.multi += q; else l.single += q;
      l.total += q;
      l.orders += 1;
      if (it.sku && !l.netoSkus.includes(it.sku)) l.netoSkus.push(it.sku);
      lines.set(k, l);
    }
  }
  const nameOf = (l) => l.zohoName || l.productName;
  // items picked for single-line orders first (user 2026-10-08), then the
  // ones only multi-line orders need; each part by location
  return [...lines.values()].sort((a, b) =>
    (a.single ? 0 : 1) - (b.single ? 0 : 1)
    || (a.location ? 0 : 1) - (b.location ? 0 : 1)
    || a.location.localeCompare(b.location, undefined, { numeric: true })
    || nameOf(a).localeCompare(nameOf(b)));
}
const dispatchStatusOf = (o) => (o && o.dispatch && o.dispatch.status) || "";
function pickSummaryOf(list) {
  const orders = list.orders || [];
  const multi = orders.filter((o) => o.multi);
  return {
    orders: orders.length,
    // Confirm dispatch: shipped (pushed to Neto, or Neto already had it) /
    // held back with a reason / still to confirm (incl. a failed push)
    dispatched: orders.filter((o) => dispatchStatusOf(o) === "dispatched").length,
    held: orders.filter((o) => dispatchStatusOf(o) === "held").length,
    toConfirm: orders.filter((o) => !["dispatched", "held"].includes(dispatchStatusOf(o))).length,
    singleOrders: orders.length - multi.length,
    multiOrders: multi.length,
    units: orders.reduce((t, o) => t + unitsOf(o), 0),
    singleUnits: orders.filter((o) => !o.multi).reduce((t, o) => t + unitsOf(o), 0),
    multiUnits: multi.reduce((t, o) => t + unitsOf(o), 0),
    skus: new Set(orders.flatMap((o) => (o.items || []).map(lineKeyOf))).size,
  };
}

router.get("/pick-lists", VIEW, async function (req, res) {
  try {
    const col = await pickLists();
    const docs = await col.find(LIVE_LIST, { projection: { history: 0 } }).sort({ day: -1 }).limit(180).toArray();
    return res.json({
      success: true,
      today: todayKey(),
      lists: docs.map((d) => ({ day: d.day, ...pickSummaryOf(d), createdAt: d.createdAt, createdBy: d.createdBy, updatedAt: d.updatedAt, updatedBy: d.updatedBy })),
    });
  } catch (error) {
    console.error("Exyon pick lists error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load the pick lists" });
  }
});

router.get("/pick-lists/:day", VIEW, async function (req, res) {
  try {
    if (!DAY_RE.test(req.params.day)) return res.status(400).json({ success: false, message: "Bad day" });
    const col = await pickLists();
    const list = await col.findOne({ day: req.params.day, ...LIVE_LIST }, { projection: { history: 0 } });
    if (!list) return res.status(404).json({ success: false, message: "No pick list for that day" });
    const zoho = await zohoItemsFor((list.orders || []).flatMap((o) => (o.items || []).map((it) => it.sku)));
    const orders = [...(list.orders || [])].sort(byPlaced)
      .map((o) => ({ ...o, items: (o.items || []).map((it) => ({ ...it, ...(zoho.get(String(it.sku || "").trim()) || {}) })) }));
    const now = { ...list, orders };
    return res.json({ success: true, list: now, lines: pickLinesOf(now), summary: pickSummaryOf(now) });
  } catch (error) {
    console.error("Exyon pick list error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load the pick list" });
  }
});

// Take an order off a day's list (it shows as not listed again).
router.post("/pick-lists/:day/remove", PICK_EDIT, async function (req, res) {
  try {
    const orderId = String((req.body && req.body.orderId) || "");
    if (!DAY_RE.test(req.params.day) || !orderId) return res.status(400).json({ success: false, message: "Which order?" });
    const col = await pickLists();
    const now = new Date();
    const by = actor(req);
    // a dispatched order stays — its record of what went to Neto with it
    const on = await col.findOne({ day: req.params.day, ...LIVE_LIST }, { projection: { orders: { $elemMatch: { orderId } } } });
    if (on && on.orders && dispatchStatusOf(on.orders[0]) === "dispatched") {
      return res.status(400).json({ success: false, message: `${orderId} is already dispatched — it stays on the list` });
    }
    const r = await col.updateOne(
      { day: req.params.day, "orders.orderId": orderId },
      { $pull: { orders: { orderId } }, $set: { updatedAt: now, updatedBy: by }, $push: { history: { at: now, by, action: "removed", orderId } } },
    );
    if (!r.modifiedCount) return res.status(404).json({ success: false, message: "That order is not on this list" });
    return res.json({ success: true });
  } catch (error) {
    console.error("Exyon pick list remove error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to remove the order" });
  }
});

// Processed on the Dispatch page (user 2026-10-08): each order with the
// tracking number scanned for it goes on today's pick list — or, already on
// a list, gets the tracking number there. Exyon / Neto are not touched yet:
// the order's status and the push to Neto come later.
//   POST /pick-lists/today/process { orders: [{ orderId, tracking }] }
//     → { day, added, updated, warnings }
const TRACKING_RE = /^[A-Za-z0-9._/-]{4,60}$/;
router.post("/pick-lists/today/process", PICK_EDIT, async function (req, res) {
  const bad = (message) => res.status(400).json({ success: false, message });
  try {
    const asked = Array.isArray(req.body && req.body.orders) ? req.body.orders : [];
    const list = [];
    for (const x of asked) {
      const orderId = String((x && x.orderId) || "").trim();
      const tracking = String((x && x.tracking) || "").replace(/\s+/g, "");
      if (!orderId) continue;
      if (!TRACKING_RE.test(tracking)) return bad(`${orderId}: "${tracking}" doesn't look like a tracking number`);
      list.push({ orderId, tracking });
    }
    if (!list.length) return bad("Scan a tracking number for at least one order");
    if (list.length > 200) return bad("Up to 200 orders at a time");
    const ids = list.map((x) => x.orderId);
    if (new Set(ids).size !== ids.length) return bad("An order is in the list twice");
    const seen = new Map();
    for (const x of list) {
      if (seen.has(x.tracking)) return bad(`${x.tracking} was scanned for both ${seen.get(x.tracking)} and ${x.orderId}`);
      seen.set(x.tracking, x.orderId);
    }

    // already on a pick list → the tracking number goes there; the rest must
    // still be open orders, and join today's list
    const entries = await pickEntriesOf(ids);
    const newIds = ids.filter((id) => !entries.has(id));
    let fresh = [];
    if (newIds.length) {
      const byId = new Map((await openOrders()).map((o) => [o.orderId, o]));
      const gone = newIds.filter((id) => !byId.has(id));
      if (gone.length) return bad(`${gone.join(", ")}: no longer an open order — refresh the page`);
      fresh = newIds.map((id) => byId.get(id));
    }
    const trackingOf = new Map(list.map((x) => [x.orderId, x.tracking]));
    const now = new Date();
    const by = actor(req);
    const day = todayKey();
    const col = await pickLists();
    if (fresh.length) {
      const zoho = await zohoItemsFor(fresh.flatMap((o) => o.items.map((it) => it.sku)));
      const docs = fresh.map((o) => ({ ...pickSnapshotOf(o, zoho, now, by), tracking: trackingOf.get(o.orderId), processedAt: now, processedBy: by }));
      await col.updateOne(
        { day },
        {
          $setOnInsert: { day, createdAt: now, createdBy: by },
          $set: { updatedAt: now, updatedBy: by },
          $push: { orders: { $each: docs }, history: { at: now, by, action: "processed", orderIds: docs.map((d) => d.orderId) } },
        },
        { upsert: true },
      );
    }
    for (const [id, e] of entries) {
      const tracking = trackingOf.get(id);
      await col.updateOne(
        { day: e.day, "orders.orderId": id },
        {
          $set: { "orders.$.tracking": tracking, "orders.$.processedAt": now, "orders.$.processedBy": by, updatedAt: now, updatedBy: by },
          $push: { history: { at: now, by, action: "processed", orderId: id, tracking, ...(e.tracking && e.tracking !== tracking ? { was: e.tracking } : {}) } },
        },
      );
    }

    // a tracking number that is also on another order — worth a look, not a stop
    const warnings = [];
    const others = await col.find({ "orders.tracking": { $in: [...seen.keys()] }, ...LIVE_LIST }, { projection: { day: 1, "orders.orderId": 1, "orders.tracking": 1 } }).toArray();
    for (const d of others) {
      for (const o of d.orders || []) {
        if (o.tracking && seen.has(o.tracking) && seen.get(o.tracking) !== o.orderId) warnings.push(`${o.tracking} is also on ${o.orderId} (${d.day})`);
      }
    }
    return res.json({ success: true, day, added: fresh.length, updated: entries.size, warnings });
  } catch (error) {
    console.error("Exyon pick list process error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to process the orders" });
  }
});

// Confirm dispatch (user 2026-10-20): every order on a day's list is taken to
// be picked and shipped that day — the warehouse confirms it, and each order
// is either
//   dispatched — pushed to Neto as Dispatched: each line's tracking number
//                (the label scanned when it was processed), carrier
//                "Australia Post" (on every dispatched line in Neto,
//                2026-10-20), QuantityShipped = its quantity; NO customer
//                email (user). One Neto already has as Dispatched is just
//                recorded, not pushed again.
//   held       — not shipped (insufficient stock…): stays on the list,
//                flagged with its reason (user), until dispatched or taken off.
// An order with no tracking number can't be dispatched (user): scan one —
// sent here as `tracking` — or hold it. One Neto call per order, each result
// saved as it comes; a push that fails is kept as "failed" to try again.
//   POST /pick-lists/:day/dispatch
//     { orders: [{ orderId, dispatch: true, tracking? } | { orderId, dispatch: false, reason, note? }], dryRun? }
//     → { results: [{ orderId, outcome: dispatched | already | held | failed | dry-run, message?, payload? }] }
// dryRun: nothing saved, nothing sent — the Neto request each order would get.
const HOLD_REASONS = ["Insufficient stock", "Damaged item", "Address issue", "Customer cancelled", "Other"];
const NETO_SHIPPING_METHOD = "Australia Post";
const confirming = new Set(); // days being confirmed right now (one at a time)
router.post("/pick-lists/:day/dispatch", PICK_EDIT, async function (req, res) {
  const bad = (message) => res.status(400).json({ success: false, message });
  const day = req.params.day;
  if (!DAY_RE.test(day)) return bad("Bad day");
  const dryRun = !!(req.body && req.body.dryRun);
  if (!dryRun && confirming.has(day)) return res.status(409).json({ success: false, message: "This list is being confirmed by someone else right now — try again in a moment" });
  if (!dryRun) confirming.add(day);
  try {
    const col = await pickLists();
    const list = await col.findOne({ day, ...LIVE_LIST }, { projection: { orders: 1 } });
    if (!list) return res.status(404).json({ success: false, message: "No pick list for that day" });
    const onList = new Map((list.orders || []).map((o) => [o.orderId, o]));

    const asked = Array.isArray(req.body && req.body.orders) ? req.body.orders : [];
    const plan = [];
    const results = [];
    for (const x of asked) {
      const orderId = String((x && x.orderId) || "").trim();
      if (!orderId) continue;
      const entry = onList.get(orderId);
      if (!entry) return bad(`${orderId} is not on this list`);
      if (plan.some((p) => p.orderId === orderId)) return bad(`${orderId} is in the request twice`);
      if (dispatchStatusOf(entry) === "dispatched") { results.push({ orderId, outcome: "already", message: "Already dispatched" }); continue; }
      if (x.dispatch === true) {
        const tracking = String(x.tracking || entry.tracking || "").replace(/\s+/g, "");
        if (!TRACKING_RE.test(tracking)) return bad(`${orderId} has no tracking number — scan its label, or hold it back with a reason`);
        plan.push({ orderId, entry, dispatch: true, tracking });
      } else if (x.dispatch === false) {
        const reason = String(x.reason || "").trim();
        if (!HOLD_REASONS.includes(reason)) return bad(`${orderId}: pick why it isn't dispatched`);
        plan.push({ orderId, entry, dispatch: false, reason, note: String(x.note || "").trim().slice(0, 300) });
      }
    }
    if (!plan.length && !results.length) return bad("Nothing to confirm");

    // Neto: each order's status and lines, before pushing anything
    const sendIds = plan.filter((p) => p.dispatch).map((p) => p.orderId);
    const neto = new Map();
    for (let i = 0; i < sendIds.length; i += 100) {
      const d = await netoCall("GetOrder", { Filter: { OrderID: sendIds.slice(i, i + 100), OutputSelector: ["OrderID", "OrderStatus", "OrderLine", "OrderLine.SKU", "OrderLine.Quantity", "OrderLine.ShippingTracking"] } });
      for (const o of [].concat(d.Order || [])) neto.set(String(o.OrderID), o);
    }

    const by = actor(req);
    const save = async (p, dispatch, extra = {}) => {
      if (dryRun) return;
      const at = new Date();
      await col.updateOne(
        { day, "orders.orderId": p.orderId },
        {
          $set: { "orders.$.dispatch": { ...dispatch, at, by }, ...extra, updatedAt: at, updatedBy: by },
          $push: { history: { at, by, action: `dispatch:${dispatch.status}`, orderId: p.orderId, ...(dispatch.reason ? { reason: dispatch.reason } : {}), ...(dispatch.error ? { error: dispatch.error } : {}) } },
        },
      );
    };
    for (const p of plan) {
      if (!p.dispatch) {
        await save(p, { status: "held", reason: p.reason, note: p.note });
        results.push({ orderId: p.orderId, outcome: dryRun ? "dry-run" : "held", message: p.reason });
        continue;
      }
      // a tracking number scanned in the confirm popup lands on the entry too
      const trackingSet = p.tracking !== (p.entry.tracking || "")
        ? { "orders.$.tracking": p.tracking, "orders.$.processedAt": new Date(), "orders.$.processedBy": by } : {};
      const n = neto.get(p.orderId);
      if (!n) {
        await save(p, { status: "failed", error: "Neto has no such order" }, trackingSet);
        results.push({ orderId: p.orderId, outcome: "failed", message: "Neto has no such order" });
        continue;
      }
      const status = String(n.OrderStatus || "");
      if (status === "Dispatched") {
        const netoTracking = [...new Set([].concat(n.OrderLine || []).map((l) => String(l.ShippingTracking || "").trim()).filter(Boolean))].join(", ");
        await save(p, { status: "dispatched", neto: "already", netoTracking }, trackingSet);
        await rememberNetoStatus(p.orderId, "Dispatched").catch(() => {});
        results.push({ orderId: p.orderId, outcome: "already", message: "Neto already had it as Dispatched" });
        continue;
      }
      if (status === "Cancelled") {
        await save(p, { status: "failed", error: "Cancelled in Neto" }, trackingSet);
        results.push({ orderId: p.orderId, outcome: "failed", message: "Cancelled in Neto" });
        continue;
      }
      const lines = [].concat(n.OrderLine || []).filter((l) => String(l.SKU || "").trim());
      const payload = {
        Order: [{
          OrderID: p.orderId,
          OrderStatus: "Dispatched",
          OrderLine: lines.map((l) => ({
            SKU: String(l.SKU).trim(),
            QuantityShipped: Number(l.Quantity) || 0,
            TrackingDetails: { ShippingMethod: NETO_SHIPPING_METHOD, TrackingNumber: p.tracking },
          })),
        }],
      };
      if (dryRun) { results.push({ orderId: p.orderId, outcome: "dry-run", message: `Neto ${status || "?"} → Dispatched`, payload }); continue; }
      try {
        const r = await netoCall("UpdateOrder", payload);
        const warning = r.Ack === "Warning" && r.Messages ? JSON.stringify(r.Messages).slice(0, 300) : "";
        await save(p, { status: "dispatched", neto: "pushed", tracking: p.tracking, ...(warning ? { warning } : {}) }, trackingSet);
        await rememberNetoStatus(p.orderId, "Dispatched").catch(() => {});
        results.push({ orderId: p.orderId, outcome: "dispatched", ...(warning ? { message: warning } : {}) });
      } catch (e) {
        await save(p, { status: "failed", error: String(e.message || e).slice(0, 300) }, trackingSet);
        results.push({ orderId: p.orderId, outcome: "failed", message: e.message });
      }
    }
    return res.json({ success: true, dryRun, results });
  } catch (error) {
    console.error("Exyon pick list dispatch error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to confirm the dispatch" });
  } finally {
    if (!dryRun) confirming.delete(day);
  }
});

// Shipping labels (user 2026-10-08), one per order: the delivery address and
// phone from Neto (GetOrder — Exyon's table has no address), the items and
// the tracking number from the order's pick list entry.
//   GET /labels?orderIds=A,B → { labels: [{ orderId, channel, ref2, tracking,
//     address: { name, company, street1, street2, city, state, postcode, country, phone } | null,
//     items: [{ name, sku, zohoSku, quantity }] }], missing: [orderIds Neto didn't find] }
// Neto hands out the address as a group: "ShipAddress" brings ShipFirstName,
// ShipStreetLine1 … ShipPhone (the single field names bring nothing)
const NETO_SHIP_FIELDS = ["OrderID", "SalesChannel", "CustomerRef1", "ShipAddress", "OrderLine", "OrderLine.SKU", "OrderLine.ProductName", "OrderLine.Quantity"];
router.get("/labels", VIEW, async function (req, res) {
  try {
    const ids = [...new Set(String(req.query.orderIds || "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 200);
    if (!ids.length) return res.status(400).json({ success: false, message: "Which orders?" });

    // the pick list entries: items (as snapshotted) + tracking
    const col = await pickLists();
    const docs = await col.find({ "orders.orderId": { $in: ids }, ...LIVE_LIST }, { projection: { day: 1, orders: 1 } }).toArray();
    const entry = new Map();
    for (const d of docs) for (const o of d.orders || []) if (ids.includes(o.orderId)) entry.set(o.orderId, o);

    // Neto: the delivery address
    const neto = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const d = await netoCall("GetOrder", { Filter: { OrderID: ids.slice(i, i + 100), OutputSelector: NETO_SHIP_FIELDS } });
      for (const o of d.Order || []) neto.set(String(o.OrderID), o);
    }
    // our Zoho SKU for lines that only Neto knows
    const netoOnlySkus = ids.filter((id) => !entry.has(id) && neto.has(id))
      .flatMap((id) => [].concat(neto.get(id).OrderLine || []).map((l) => String(l.SKU || "").trim()));
    const zoho = netoOnlySkus.length ? await zohoItemsFor(netoOnlySkus) : new Map();

    const str = (v) => String(v == null ? "" : v).trim();
    const labels = ids.map((id) => {
      const e = entry.get(id);
      const n = neto.get(id);
      const items = e
        ? (e.items || []).map((it) => ({ name: it.productName || "", sku: it.sku || "", zohoSku: it.zohoSku || "", quantity: Number(it.quantity) || 0 }))
        : [].concat((n && n.OrderLine) || []).map((l) => {
          const sku = str(l.SKU);
          return { name: str(l.ProductName), sku, zohoSku: (zoho.get(sku) || {}).zohoSku || "", quantity: Number(l.Quantity) || 0 };
        });
      const address = n ? {
        name: [str(n.ShipFirstName), str(n.ShipLastName)].filter(Boolean).join(" "),
        company: str(n.ShipCompany),
        street1: str(n.ShipStreetLine1),
        street2: str(n.ShipStreetLine2),
        city: str(n.ShipCity),
        state: str(n.ShipState),
        postcode: str(n.ShipPostCode),
        country: str(n.ShipCountry),
        phone: str(n.ShipPhone),
      } : null;
      return {
        orderId: id,
        channel: (e && e.channel) || (n && str(n.SalesChannel)) || "",
        ref2: (n && (str(n.CustomerRef1) || str(n.SalesChannel))) || (e && e.channel) || "",
        tracking: (e && e.tracking) || "",
        // no name and no street = no address to print
        address: address && (address.name || address.street1) ? address : null,
        items,
      };
    });
    return res.json({ success: true, labels, missing: labels.filter((l) => !l.address).map((l) => l.orderId) });
  } catch (error) {
    console.error("Exyon labels error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load the labels" });
  }
});

router.get("/dispatch", VIEW, async function (req, res) {
  try {

    // the option lists: every open order, before the filters
    const all = await exQuery(`SELECT sales_channel AS channel, order_status AS status, COUNT(DISTINCT order_id) AS n
      FROM ${TABLE} WHERE LOWER(TRIM(order_status)) IN (?) GROUP BY sales_channel, order_status`, [OPEN_STATUSES]);
    const tally = (key) => [...all.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + Number(r.n)), new Map())]
      .filter(([v]) => v).map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n);

    let orders = await openOrders({ channel: req.query.channel, status: req.query.status });
    // what Neto already dispatched / cancelled drops out (user 2026-10-20)
    const neto = await netoStatusesOf(orders.map((o) => o.orderId));
    const netoDone = orders.filter((o) => NETO_FINAL.includes(neto.statuses.get(o.orderId))).length;
    orders = orders.filter((o) => !NETO_FINAL.includes(neto.statuses.get(o.orderId)));
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q) {
      orders = orders.filter((o) => [o.orderId, o.customerName, ...o.items.flatMap((it) => [it.sku, it.productName])]
        .some((v) => String(v || "").toLowerCase().includes(q)));
    }

    const zoho = await zohoItemsFor(orders.flatMap((o) => o.items.map((it) => it.sku)));
    orders = orders.map((o) => ({ ...o, items: o.items.map((it) => ({ ...it, ...(zoho.get(it.sku) || {}) })) }));

    // the three tabs (user 2026-10-08): orders on no pick list yet split into
    //   bySku     — single-line orders, grouped by their SKU
    //   multiLine — multi-line orders, one by one
    // and onPickList — the orders already on a pick list (processed or not)
    const entry = await pickEntriesOf(orders.map((o) => o.orderId));
    // dispatched from a pick list = done, whatever Neto's cached answer says
    orders = orders.filter((o) => dispatchStatusOf(entry.get(o.orderId)) !== "dispatched");
    // envelope: the size the order ships in, from its items (user 2026-10-20);
    // dispatch: held back / a failed push, from its pick list
    const brief = (o) => {
      const e = entry.get(o.orderId) || {};
      return { orderId: o.orderId, channel: o.channel, account: o.account, customerName: o.customerName,
        status: o.status, datePlaced: o.datePlaced, orderTotal: o.orderTotal, pickDay: e.day || null, tracking: e.tracking || "",
        dispatch: e.dispatch || null, envelope: envelopeOf(o.items) };
    };
    const sku = new Map();
    const multiLine = [];
    const onPickList = [];
    for (const o of orders) {
      if (entry.has(o.orderId)) {
        onPickList.push({ ...brief(o), items: o.items });
      } else if (o.items.length === 1) {
        const it = o.items[0];
        const k = skuKey(it.sku);
        const g = sku.get(k) || { key: k, sku: it.sku, productName: it.productName, image: it.image || null, zohoSku: it.zohoSku || "", zohoName: it.zohoName || "", location: it.location || "", units: 0, orders: [] };
        g.units += it.quantity;
        g.orders.push({ ...brief(o), quantity: it.quantity, unitPrice: it.unitPrice, lineIds: it.lineIds });
        sku.set(k, g);
      } else {
        multiLine.push({ ...brief(o), items: o.items });
      }
    }
    const bySku = [...sku.values()]
      .map((g) => ({ ...g, orders: g.orders.sort(byPlaced) }))
      .sort((a, b) => b.orders.length - a.orders.length || b.units - a.units || a.sku.localeCompare(b.sku));
    multiLine.sort(byPlaced);
    // on a pick list: the ones still to process (no tracking number) first
    onPickList.sort((a, b) => (a.tracking ? 1 : 0) - (b.tracking ? 1 : 0) || byPlaced(a, b));

    const units = orders.reduce((t, o) => t + o.items.reduce((u, it) => u + it.quantity, 0), 0);
    return res.json({
      success: true,
      bySku,
      multiLine,
      onPickList,
      summary: {
        orders: orders.length,
        units,
        skuGroups: bySku.length,
        skuOrders: bySku.reduce((t, g) => t + g.orders.length, 0),
        multiLine: multiLine.length,
        onPickList: onPickList.length,
        processed: onPickList.filter((o) => o.tracking).length,
        // left out because Neto already has them as Dispatched / Cancelled;
        // netoChecked false = Neto didn't answer (cached answers only)
        netoDone,
        netoChecked: neto.checked,
      },
      channels: tally("channel"),
      statuses: tally("status"),
    });
  } catch (error) {
    console.error("Exyon accessory dispatch error:", error);
    return res.status(502).json({ success: false, message: error.message || "Failed to load the orders to dispatch" });
  }
});

module.exports = router;
