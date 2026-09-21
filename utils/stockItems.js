// The stock register: imb_stock_items, ONE row per Zoho item, updated in
// place (2026-09-21, replacing the one-row-per-item-per-day imb_stock_daily).
//
// A row has two halves:
//   · the catalogue — SKU, name, scope, classification, shelf, vendor,
//     collections, our own brand/category/quality, image, price lists and
//     the price-health flags, archive state. Changes rarely.
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
  "available",
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
// Accessories are told apart three ways — Classification (Analytics),
// accessory-collection membership, or a Zoho Brand from this list, drawn
// from the brands on accessory-classified stock. Deliberately NOT Apple /
// Samsung, which brand real parts too. The sync only has the brand to go
// on for a brand-new item; the night's run settles it.
const ACCESSORY_BRANDS = new Set([
  "Accessory", "iShield", "Roar", "Ugly Rubber UR", "X.One", "Halosure",
  "Remax", "JoyRoom", "HOCO", "COTECi", "Rock", "Blue Nation", "Baseus",
]);
// A PO line still owes us stock until it is received (or cancelled).
const OPEN_PO_STATUSES = { $nin: ["received", "cancelled"] };

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
}

module.exports = {
  ITEMS,
  METRIC_KEYS,
  OFFLINE_SALE_SCOPES,
  SALE_SCOPES,
  emptySaleUnits,
  roundSaleUnits,
  ACCESSORY_BRANDS,
  OPEN_PO_STATUSES,
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
