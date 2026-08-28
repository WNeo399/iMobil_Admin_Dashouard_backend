// Daily spare-parts / accessories stock snapshot.
//
// Reads the whole active + shelved catalogue out of Zoho once — stock,
// attributes, 90 days of sales — joins it to our own product catalogue and
// open purchase orders, and writes one row per item per day. The Stock
// Monitoring dashboard then answers every question from Mongo, with no Zoho
// call in the request path: the sweep takes about a minute, which is fine
// once a day and impossible on page load.
//
//   node bin/stockSnapshot.js              dry run — reports, writes nothing
//   node bin/stockSnapshot.js --apply      writes the snapshot
//   node bin/stockSnapshot.js --days=180   a deeper sales window (default 90)
//
// Re-running for the same day replaces that day's rows, so it is safe to
// run twice. Designed to be the entrypoint of the Sealos cron container,
// which is why it takes no arguments it cannot default and exits non-zero
// on failure.

require("dotenv").config();

const { connectToDatabase } = require("../utils/mongodb");
const {
  getItemIdsFromCriteria,
  resolveCollectionItemIds,
  fetchItemAttributes,
  fetchItemDetails,
  itemLocation,
  fetchWindowRows,
  OFFLINE_SALE_REASONS,
} = require("../utils/zohoStock");

const ITEMS_DAILY = "imb_stock_daily";
const RUNS = "imb_stock_runs";
const PRODUCTS = "imb_products";
const PURCHASE_ORDERS = "imb_purchase_order";
const COLLECTIONS = "productCollections";
const COLLECTION_GROUPS = "productCollectionsGroups";

// The universe: anything Zoho says is active and sitting on a shelf. The
// collections are a tag on these rows, not the boundary of them — they only
// reach 4,886 of ~11,800, and the items outside them sell more than the ones
// inside.
const UNIVERSE = `"Status" = 'Active' AND "Location" IS NOT NULL`;

// Accessories are told apart by Zoho's Classification, which splits them
// perfectly: no accessory-classified item appears in any parts collection.
// Everything else — including the ~3,200 items with no classification at
// all — counts as a spare part.
const ACCESSORY_CLASSIFICATIONS = new Set([
  "Accessory",
  "Accessory Special Offer",
]);

// A PO line still owes us stock until it is received (or cancelled).
const OPEN_PO_STATUSES = { $nin: ["received", "cancelled"] };

// Sales buckets, in days. 90 is the outer window and the one actually read;
// the shorter ones are counted from the same rows.
const BUCKETS = [7, 14, 30, 90];
const DEFAULT_DAYS = 90;
// "Nothing sold for a fortnight" is the staleness test you asked for.
const STALE_DAYS = 14;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DAYS = (() => {
  const arg = args.find((a) => a.startsWith("--days="));
  const n = arg ? Number(arg.split("=")[1]) : DEFAULT_DAYS;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAYS;
})();

const log = (...a) => console.log(...a);
const num = (v) => {
  const n = Number(String(v == null ? "" : v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const skuKey = (v) => String(v == null ? "" : v).trim().toUpperCase();

// Snapshots are keyed by calendar day in Melbourne, because that is the day
// the warehouse means when it says "yesterday's numbers".
function melbourneDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Analytics returns "2026-08-28 12:32:14"; treat it as a plain timestamp.
function parseWhen(v) {
  const d = new Date(String(v || "").replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function main() {
  const startedAt = new Date();
  const snapshotDate = melbourneDate(startedAt);
  const timings = {};
  const stage = async (name, fn) => {
    const t = Date.now();
    const out = await fn();
    timings[name] = Date.now() - t;
    return out;
  };

  log(`snapshot ${snapshotDate} · ${DAYS}-day sales window · ${APPLY ? "APPLY" : "DRY RUN"}`);
  const db = await connectToDatabase();

  // ── 1. the universe, with its attributes ──────────────────────────
  const attributes = await stage("attributes", () => fetchItemAttributes(UNIVERSE));
  const attrById = new Map(attributes.map((r) => [r["Item ID"], r]));
  const itemIds = [...attrById.keys()];
  log(`  items:      ${itemIds.length}`);

  // ── 2. live stock ─────────────────────────────────────────────────
  const details = await stage("stock", () => fetchItemDetails(itemIds));
  const detailById = new Map(details.map((d) => [d.item_id, d]));
  if (details.length !== itemIds.length) {
    // fetchItemDetails throws on a failed batch, so a shortfall here means
    // Zoho knows an id the itemdetails endpoint won't return — worth saying
    // out loud rather than quietly dropping rows.
    log(`  WARNING:    ${itemIds.length - details.length} items returned no detail record`);
  }
  log(`  stock:      ${details.length}`);

  // ── 3. collection tags ────────────────────────────────────────────
  const { collectionsByItem, groupByCollection } = await stage("collections", async () => {
    const groups = await db.collection(COLLECTION_GROUPS).find({}).toArray();
    const groupByCollection = new Map();
    for (const g of groups) {
      for (const c of g.collections || []) {
        if (c && c.title) groupByCollection.set(c.title, g.title);
      }
    }
    const collections = await db.collection(COLLECTIONS).find({}).toArray();
    const collectionsByItem = new Map();
    for (const c of collections) {
      for (const id of await resolveCollectionItemIds(c)) {
        if (!collectionsByItem.has(id)) collectionsByItem.set(id, []);
        collectionsByItem.get(id).push(c.title);
      }
    }
    return { collectionsByItem, groupByCollection };
  });
  log(`  tagged:     ${collectionsByItem.size} items belong to a collection`);

  // ── 4. sales, one read for every bucket ───────────────────────────
  const sales = await stage("sales", async () => {
    const { salesRows, adjustmentRows, reasonByAdjustment } = await fetchWindowRows(DAYS);
    const now = Date.now();
    const byItem = new Map();
    const at = (id) => {
      if (!byItem.has(id)) {
        byItem.set(id, { units: {}, online: 0, offline: 0, lastSaleAt: null });
        for (const b of BUCKETS) byItem.get(id).units[b] = 0;
      }
      return byItem.get(id);
    };
    const record = (id, qty, when, offline) => {
      if (!id || !qty) return;
      const e = at(id);
      const d = parseWhen(when);
      if (d) {
        const ageDays = (now - d.getTime()) / 86400000;
        for (const b of BUCKETS) if (ageDays <= b) e.units[b] += qty;
        if (!e.lastSaleAt || d > e.lastSaleAt) e.lastSaleAt = d;
      }
      if (offline) e.offline += qty;
      else e.online += qty;
    };
    for (const r of salesRows) {
      record(r["Product ID"], num(r["Quantity"]), r["Created Time"], false);
    }
    for (const r of adjustmentRows) {
      const reason = reasonByAdjustment.get(r["Inventory Adjustment ID"]);
      if (!OFFLINE_SALE_REASONS.has(reason)) continue;
      // Stock leaving is a negative adjustment; flip it so sales read positive.
      record(r["Product ID"], num(r["Quantity Adjusted"]) * -1, r["Created Time"], true);
    }
    log(`  sales:      ${salesRows.length} order rows + ${adjustmentRows.length} adjustments` +
      ` → ${byItem.size} items with movement`);
    return byItem;
  });

  // ── 5. our own catalogue and open POs, by SKU ─────────────────────
  const { productBySku, poBySku } = await stage("joins", async () => {
    const products = await db.collection(PRODUCTS)
      .find({}, { projection: { sku: 1, brand: 1, category: 1, quality: 1 } })
      .toArray();
    const productBySku = new Map(products.map((p) => [skuKey(p.sku), p]));

    const poLines = await db.collection(PURCHASE_ORDERS)
      .find({ status: OPEN_PO_STATUSES },
        { projection: { sku: 1, orderQty: 1, shippedQty: 1, orderDate: 1, status: 1 } })
      .toArray();
    const poBySku = new Map();
    for (const l of poLines) {
      const k = skuKey(l.sku);
      if (!k) continue;
      if (!poBySku.has(k)) poBySku.set(k, { qty: 0, lines: 0, earliest: null });
      const e = poBySku.get(k);
      e.qty += num(l.orderQty);
      e.lines += 1;
      // orderDate is a loose "YYYY-M-D" string from the supplier sheet.
      const d = l.orderDate ? new Date(String(l.orderDate).replace(/-/g, "/")) : null;
      if (d && !Number.isNaN(d.getTime()) && (!e.earliest || d < e.earliest)) e.earliest = d;
    }
    log(`  joins:      ${productBySku.size} catalogue SKUs · ${poBySku.size} SKUs on open PO`);
    return { productBySku, poBySku };
  });

  // ── 6. build the rows ─────────────────────────────────────────────
  const now = startedAt.getTime();
  const rows = [];
  for (const id of itemIds) {
    const a = attrById.get(id);
    const d = detailById.get(id);
    if (!d) continue;

    const sku = String(a.SKU || d.sku || "").trim();
    const key = skuKey(sku);
    const classification = String(a.Classification || "").trim();
    const s = sales.get(id);
    const po = poBySku.get(key);
    const product = productBySku.get(key);

    const available = num(d.actual_available_for_sale_stock);
    const units = {};
    for (const b of BUCKETS) units[b] = s ? Math.round(s.units[b] * 100) / 100 : 0;
    const lastSaleAt = s && s.lastSaleAt ? s.lastSaleAt : null;
    const daysSinceSale = lastSaleAt ? (now - lastSaleAt.getTime()) / 86400000 : null;

    // Demand rate from the 30-day window, which is the horizon the tiles
    // talk about; cover is how long stock lasts at that rate.
    const rate30 = units[30] / 30;
    const openPoQty = po ? po.qty : 0;

    const outOfStock = available <= 0;
    rows.push({
      snapshotDate,
      itemId: id,
      sku,
      name: String(a["Item Name"] || d.name || ""),
      // Accessories and spare parts are separate businesses and get
      // separate views; blanks fall to parts by default.
      scope: ACCESSORY_CLASSIFICATIONS.has(classification) ? "accessory" : "parts",
      classification,
      location: String(a.Location || itemLocation(d) || ""),
      preferVendor: String(a["Prefer Vendor"] || ""),
      zohoBrand: String(a.Brand || ""),
      purchasePrice: num(a["Purchase Price"]),

      collections: collectionsByItem.get(id) || [],
      groups: [...new Set((collectionsByItem.get(id) || [])
        .map((t) => groupByCollection.get(t))
        .filter(Boolean))],

      // From our own catalogue, where the SKU matches.
      brand: product && product.brand ? product.brand.name : null,
      category: product && product.category ? product.category.name : null,
      quality: product && product.quality ? product.quality.name : null,
      inCatalogue: !!product,

      available,
      stockOnHand: num(d.stock_on_hand),
      committed: num(d.actual_committed_stock),

      units7: units[7],
      units14: units[14],
      units30: units[30],
      units90: units[90],
      onlineUnits: s ? Math.round(s.online * 100) / 100 : 0,
      offlineUnits: s ? Math.round(s.offline * 100) / 100 : 0,
      lastSaleAt,
      daysSinceSale: daysSinceSale == null ? null : Math.floor(daysSinceSale),

      openPoQty,
      openPoLines: po ? po.lines : 0,
      earliestPoDate: po ? po.earliest : null,

      // The flags the dashboard tiles count.
      outOfStock,
      outOfStockCovered: outOfStock && openPoQty > 0,
      outOfStockUncovered: outOfStock && openPoQty <= 0,
      belowMonthCover: available < units[30],
      stale: units[STALE_DAYS] === 0,
      // No sales and no stock in the whole window: catalogue noise, hidden
      // by default rather than deleted.
      dormant: units[90] === 0 && available <= 0,
      daysOfCover: rate30 > 0 ? Math.round((available / rate30) * 10) / 10 : null,
    });
  }

  // ── 7. report ─────────────────────────────────────────────────────
  const count = (pred, list = rows) => list.filter(pred).length;
  const parts = rows.filter((r) => r.scope === "parts");
  const accessories = rows.filter((r) => r.scope === "accessory");

  log("");
  for (const [label, list] of [["SPARE PARTS", parts], ["ACCESSORIES", accessories]]) {
    log(`  ${label}  ${list.length} items`);
    log(`    out of stock             ${count((r) => r.outOfStock, list)}`);
    log(`      ...with a PO           ${count((r) => r.outOfStockCovered, list)}`);
    log(`      ...with NO PO          ${count((r) => r.outOfStockUncovered, list)}`);
    log(`    under a month's cover    ${count((r) => r.belowMonthCover, list)}`);
    log(`    no sales in ${STALE_DAYS} days      ${count((r) => r.stale, list)}`);
    log(`    dormant (no sales/stock) ${count((r) => r.dormant, list)}`);
  }

  const durationMs = Date.now() - startedAt.getTime();
  const run = {
    snapshotDate,
    startedAt,
    finishedAt: new Date(),
    durationMs,
    ok: true,
    salesWindowDays: DAYS,
    counts: {
      items: rows.length,
      parts: parts.length,
      accessories: accessories.length,
      outOfStock: count((r) => r.outOfStock),
      outOfStockUncovered: count((r) => r.outOfStockUncovered),
      belowMonthCover: count((r) => r.belowMonthCover),
      stale: count((r) => r.stale),
    },
    timings,
    applied: APPLY,
  };

  log(`\n  timings: ${Object.entries(timings).map(([k, v]) => `${k} ${Math.round(v / 100) / 10}s`).join(" · ")}`);
  log(`  total:   ${Math.round(durationMs / 100) / 10}s`);

  if (!APPLY) {
    log("\nDRY RUN — nothing written. Pass --apply to store this snapshot.");
    log(`  would write ${rows.length} rows to ${ITEMS_DAILY} for ${snapshotDate}`);
    log(`  sample: ${JSON.stringify(rows.find((r) => r.outOfStockUncovered) || rows[0], null, 2).slice(0, 700)}`);
    return;
  }

  // ── 8. write ──────────────────────────────────────────────────────
  // Replace the day rather than appending, so a re-run corrects rather
  // than duplicates.
  await db.collection(ITEMS_DAILY).deleteMany({ snapshotDate });
  for (let i = 0; i < rows.length; i += 1000) {
    await db.collection(ITEMS_DAILY).insertMany(rows.slice(i, i + 1000), { ordered: false });
  }
  await db.collection(ITEMS_DAILY).createIndex({ snapshotDate: 1, itemId: 1 }, { unique: true });
  await db.collection(ITEMS_DAILY).createIndex({ snapshotDate: 1, scope: 1, sku: 1 });
  await db.collection(ITEMS_DAILY).createIndex({ snapshotDate: 1, scope: 1, outOfStock: 1 });
  await db.collection(RUNS).insertOne(run);
  log(`\nwrote ${rows.length} rows to ${ITEMS_DAILY} for ${snapshotDate}`);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nSNAPSHOT FAILED:", err.message);
    // A cron that fails silently is worse than none: the dashboard would
    // keep showing yesterday as if it were today. Record the failure so
    // the page can say so, then exit non-zero for the scheduler.
    try {
      const db = await connectToDatabase();
      await db.collection(RUNS).insertOne({
        snapshotDate: melbourneDate(),
        startedAt: new Date(),
        finishedAt: new Date(),
        ok: false,
        error: String(err && err.message).slice(0, 500),
        applied: APPLY,
      });
    } catch (e) {
      console.error("could not record the failure:", e.message);
    }
    process.exit(1);
  });
