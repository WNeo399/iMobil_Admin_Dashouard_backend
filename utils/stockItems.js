// The stock register: imb_stock_items, ONE row per Zoho item, updated in
// place (2026-09-21, replacing the one-row-per-item-per-day imb_stock_daily).
//
// A row has two halves:
//   · the catalogue — SKU, name, scope, shelf, vendor, collection tags
//     (`collections` / `accessoryCollections`, titles), image, price lists
//     and the price-health flags, archive state; Zoho's own Classification /
//     Sub Classification / Quality / Device Brand / Device Series /
//     Compatible Model (custom fields on the item — the catalogue of record
//     since 2026-09-22), its reorder level, whether it is shown in the
//     online store (`showInStore`, Zoho's show_in_storefront) and Zoho's
//     own item category (`zohoCategory` / `zohoCategoryId`) — the last
//     three read from the items list; and brand/category from the old
//     imb_products catalogue while it lasts. Changes rarely. Collections
//     are filters over these rows (utils/collectionFilter); the tag
//     fields (`collections`, `accessoryCollections`, `groups`) are what
//     the refresh and a collection save stamp from those filters.
//   · `metrics` — stock, the sales windows, open POs, cover and the tile
//     flags. Rewritten whole on every refresh, stamped `metricsAt`.
//
// Keeping the numbers under one sub-document is the seam that lets them
// move to their own collection later without touching the catalogue.
//
// Rows are never deleted: an item Zoho stops listing (inactive, or its SKU
// removed) gets `active: false` and an `inactiveAt`, and every read filters
// on `active: true`. `firstSeenAt` / `lastSeenAt` say when the item entered
// and was last confirmed in the universe.
//
// Routes answer with the row FLATTENED (catalogue + metrics merged), which
// is the shape the pages were built against — nothing on the frontend
// knows the split exists.

const ITEMS = "imb_stock_items";

// The numbers. Everything else the job produces is catalogue.
const METRIC_KEYS = [
  // Physical for-sale stock (shipment-driven) …
  "available",
  // … and the invoice-driven figure Zoho keeps beside it; both come from
  // the same item record, so both are stored (2026-09-22).
  "accountingStock",
  "stockOnHand",
  "committed",
  "units7",
  "units14",
  "units30",
  "units90",
  "lastSaleAt",
  "daysSinceSale",
  "openPoQty",
  "openPoLines",
  "earliestPoDate",
  "outOfStock",
  "outOfStockCovered",
  "outOfStockUncovered",
  "belowMonthCover",
  "stale",
  "daysOfCover",
];
const METRIC_SET = new Set(METRIC_KEYS);

// Sales scopes. A sales window (units7 … units90) is stored as
//   { total, online, inflow, repair, neto, dashboard }
// — orders (Zoho invoices/sales orders) under `online`, and the inventory
// adjustments that are really sales under their own scope, keyed here by
// Zoho's adjustment reason. Anything else that leaves stock (a stock take
// correction, a write-off) is not demand and is not counted.
const OFFLINE_SALE_SCOPES = {
  // InFlow counter trade, posted as a recurring adjustment.
  "Inflow Recurring Adjustment": "inflow",
  // Parts used by the workshop.
  "iMobile Repair Team": "repair",
  // Accessories sold through the Neto storefront.
  "Neto Accessories Sold": "neto",
  // Order Dispatch page scan-outs (added 2026-09-21).
  "Dispatch on Dashboard": "dashboard",
};
const SALE_SCOPES = ["online", ...Object.values(OFFLINE_SALE_SCOPES)];

function emptySaleUnits() {
  const u = { total: 0 };
  for (const s of SALE_SCOPES) u[s] = 0;
  return u;
}
function roundSaleUnits(u) {
  const out = emptySaleUnits();
  if (!u) return out;
  for (const k of Object.keys(out)) out[k] = Math.round((u[k] || 0) * 100) / 100;
  return out;
}

// The universe's edges, shared by the nightly refresh and the hourly sync.
//
// Accessories are told apart three ways — Zoho's Classification (a custom
// field on the item, in the set below), accessory-collection membership, or
// a Zoho Brand from the list after it, drawn
// from the brands on accessory-classified stock. Deliberately NOT Apple /
// Samsung, which brand real parts too. The sync only has the brand to go
// on for a brand-new item; the night's run settles it.
const ACCESSORY_CLASSIFICATIONS = new Set(["Accessory", "Accessory Special Offer"]);
const ACCESSORY_BRANDS = new Set([
  "Accessory", "iShield", "Roar", "Ugly Rubber UR", "X.One", "Halosure",
  "Remax", "JoyRoom", "HOCO", "COTECi", "Rock", "Blue Nation", "Baseus",
]);
// What is still coming from the supplier: the Spare Parts Purchase lines
// not yet received or cancelled. (Until 2026-09-23 this was the Tencent
// supplier sheet, imb_purchase_order — retired once its open rows were
// imported into the module.)
const PURCHASE_LINES = "imb_spp_orders";
const OPEN_PURCHASE_STATUSES = ["pending", "toConfirm", "ordered", "shipped", "shortage"];

const skuKey = (v) => String(v == null ? "" : v).trim().toUpperCase();
const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// The stock-dependent flags, from a row's stock and its stored demand: the
// tiles' out-of-stock / on-order / below-cover buckets and days of cover
// (stock over the 30-day rate). One definition, so the hourly sync and the
// nightly refresh can't drift.
function stockFlags({ available, units30, openPoQty }) {
  const outOfStock = available <= 0;
  const rate30 = (units30 || 0) / 30;
  return {
    outOfStock,
    outOfStockCovered: outOfStock && openPoQty > 0,
    outOfStockUncovered: outOfStock && openPoQty <= 0,
    belowMonthCover: available < (units30 || 0),
    daysOfCover: rate30 > 0 ? Math.round((available / rate30) * 10) / 10 : null,
  };
}

// Open purchase lines by SKU → { qty, lines, earliest }. A shipped line
// counts what was shipped (it closes at that), the others what was ordered —
// the same figure as the Stock Monitoring On order column.
async function openPurchasesBySku(db) {
  const lines = await db.collection(PURCHASE_LINES)
    .find({ status: { $in: OPEN_PURCHASE_STATUSES } },
      { projection: { sku: 1, status: 1, orderQty: 1, shippedQty: 1, createdAt: 1 } })
    .toArray();
  const bySku = new Map();
  for (const l of lines) {
    const k = skuKey(l.sku);
    if (!k) continue;
    if (!bySku.has(k)) bySku.set(k, { qty: 0, lines: 0, earliest: null });
    const e = bySku.get(k);
    e.qty += num(l.status === "shipped" ? l.shippedQty : l.orderQty);
    e.lines += 1;
    const d = l.createdAt ? new Date(l.createdAt) : null;
    if (d && !Number.isNaN(d.getTime()) && (!e.earliest || d < e.earliest)) e.earliest = d;
  }
  return bySku;
}

// Re-stamp every active item's on-order figures (and the flags that hang on
// them) from the purchase lines — Mongo only, no Zoho call. The hourly sync
// runs it: a line raised, shipped or received changes an item Zoho did not.
async function refreshOnOrder(db, poBySku) {
  const bySku = poBySku || (await openPurchasesBySku(db));
  const col = db.collection(ITEMS);
  const rows = await col.find({ active: true }, {
    projection: { sku: 1, "metrics.available": 1, "metrics.units30": 1, "metrics.openPoQty": 1, "metrics.openPoLines": 1, "metrics.earliestPoDate": 1 },
  }).toArray();
  const time = (d) => (d ? new Date(d).getTime() : null);
  const ops = [];
  for (const r of rows) {
    const m = r.metrics || {};
    const po = bySku.get(skuKey(r.sku));
    const qty = po ? po.qty : 0;
    const lines = po ? po.lines : 0;
    const earliest = po ? po.earliest : null;
    if (num(m.openPoQty) === qty && num(m.openPoLines) === lines && time(m.earliestPoDate) === time(earliest)) continue;
    const u30 = m.units30;
    const units30 = u30 && typeof u30 === "object" ? num(u30.total) : num(u30);
    const set = { "metrics.openPoQty": qty, "metrics.openPoLines": lines, "metrics.earliestPoDate": earliest };
    for (const [k, v] of Object.entries(stockFlags({ available: num(m.available), units30, openPoQty: qty }))) set[`metrics.${k}`] = v;
    ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: set } } });
  }
  for (let i = 0; i < ops.length; i += 500) await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  return ops.length;
}

// A flat job row → { catalogue, metrics }.
function splitRow(row) {
  const catalogue = {};
  const metrics = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "snapshotDate") continue;
    (METRIC_SET.has(k) ? metrics : catalogue)[k] = v;
  }
  return { catalogue, metrics };
}

// A stored row → the flat shape the pages read.
function flatten(doc) {
  if (!doc) return doc;
  const { metrics, ...rest } = doc;
  return { ...rest, ...(metrics || {}) };
}

// The Mongo path of a field name as the pages know it ("units90" →
// "metrics.units90"; catalogue fields are themselves).
function path(field) {
  if (!METRIC_SET.has(field)) return field;
  // A sales window sorts and filters on its total.
  return /^units\d+$/.test(field) ? `metrics.${field}.total` : `metrics.${field}`;
}

// The same, as an aggregation reference ("$metrics.units90").
function ref(field) {
  return `$${path(field)}`;
}

// The calendar day a refresh belongs to, in the warehouse's time zone —
// what the pages call the snapshot date.
function melbourneDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Indexes the pages' queries lean on: every list filters on active + scope
// and sorts on a metric or the SKU; the shelves view groups by location.
async function ensureIndexes(db) {
  const c = db.collection(ITEMS);
  await c.createIndex({ itemId: 1 }, { unique: true });
  await c.createIndex({ active: 1, scope: 1, "metrics.units90.total": -1 });
  // The pre-scope index (units90 was a plain number until 2026-09-21).
  await c.dropIndex("active_1_scope_1_metrics.units90_-1").catch(() => {});
  await c.createIndex({ active: 1, scope: 1, sku: 1 });
  await c.createIndex({ active: 1, scope: 1, archived: 1, "metrics.outOfStock": 1 });
  await c.createIndex({ active: 1, scope: 1, location: 1 });
  await c.createIndex({ active: 1, metricsAt: -1 });
  // The Stock Monitoring list asks for a collection's rows by its title.
  await c.createIndex({ active: 1, collections: 1 });
  await c.createIndex({ active: 1, accessoryCollections: 1 });
}

module.exports = {
  ITEMS,
  METRIC_KEYS,
  OFFLINE_SALE_SCOPES,
  SALE_SCOPES,
  emptySaleUnits,
  roundSaleUnits,
  ACCESSORY_CLASSIFICATIONS,
  ACCESSORY_BRANDS,
  openPurchasesBySku,
  refreshOnOrder,
  skuKey,
  num,
  stockFlags,
  splitRow,
  flatten,
  path,
  ref,
  melbourneDate,
  ensureIndexes,
};
