// Spare-parts / accessories stock register refresh.
//
// Reads the whole active catalogue out of Zoho once — stock, attributes,
// 90 days of sales — joins it to our own product catalogue and open
// purchase orders, and updates ONE row per item in imb_stock_items
// (utils/stockItems): catalogue fields at the top level, the numbers under
// `metrics`. New items are inserted, items Zoho no longer lists are flagged
// inactive; nothing is duplicated per day. The Stock Monitoring pages then
// answer every list, tile and sort from Mongo, and read live stock from
// Zoho only for the rows on screen.
//
//   node bin/stockSnapshot.js              dry run — reports, writes nothing
//   node bin/stockSnapshot.js --apply      refreshes the register
//   node bin/stockSnapshot.js --days=180   a deeper sales window (default 90)
//
// Re-running just refreshes again, so it is safe to run twice. Designed to
// be the entrypoint of the Sealos cron container (and the dashboard's
// "Update Now"), which is why it takes no arguments it cannot default and
// exits non-zero on failure.

require("dotenv").config();

const { connectToDatabase } = require("../utils/mongodb");
const {
  fetchItemAttributes,
  fetchItemDetails,
  itemLocation,
  itemCatalogueFields,
  fetchItemListFields,
  fetchWindowRows,
  OFFLINE_SALE_SCOPES,
} = require("../utils/zohoStock");
const { getViewData } = require("../utils/zohoRequest");
const { isNoiseName, ARCHIVE_COLLECTION } = require("../utils/stockUniverse");
// Zoho's id for the item's main image; only the id is stored, routes build
// the URL when a page reads it. null = the item has no image.
const { imageIdOf } = require("../utils/productImage");
const { evaluatePriceRule } = require("../utils/priceRules");
// A collection is a filter over the register (2026-09-22): its members are
// found with a Mongo query, so the tags are stamped AFTER the rows are
// written, from the rows just written.
const { resolveCollectionItemIds, SCOPE_BY_STORE, TAG_FIELD_BY_STORE } = require("../utils/collectionFilter");

const {
  ITEMS,
  ACCESSORY_CLASSIFICATIONS,
  ACCESSORY_BRANDS,
  openPurchasesBySku,
  skuKey,
  num,
  stockFlags,
  emptySaleUnits,
  roundSaleUnits,
  splitRow,
  ensureIndexes,
} = require("../utils/stockItems");
const RUNS = "imb_stock_runs";
const PRODUCTS = "imb_products";
const COLLECTIONS = "productCollections";
const COLLECTION_GROUPS = "productCollectionsGroups";

// The universe: anything Zoho says is Active (with a SKU). The old
// "Location IS NOT NULL" requirement was dropped (2026-09-15): an active
// item without a shelf is still a real SKU in use. Criteria matches (the
// shared name rules in utils/stockUniverse) are NOT dropped — they are
// flagged `archived` and live in the Archive bucket, together with items
// archived by hand; a "keep" override pins an item as never-archived.
// The collections are a tag on these rows, not the boundary of them — the
// items outside them sell more than the ones inside.
const UNIVERSE = `"Status" = 'Active'`;

// Accessories are told apart three ways (2026-09-15) — Classification is
// right when present, but items carrying none (cables, protectors among
// them) would otherwise land in parts:
//   1. Zoho Classification in ACCESSORY_CLASSIFICATIONS (utils/stockItems,
//      shared with the hourly sync);
//   2. membership in any accessoryCollections collection (the accessory
//      pages' own data set);
//   3. a Zoho Brand from the accessory-brand list (ACCESSORY_BRANDS, same
//      module).
// Everything else counts as a spare part.

// The four Zoho price lists the Price Monitoring page shows, keyed by the
// snapshot field suffix. Expected PRICE order (user-confirmed 2026-09-15):
// SVIP and WholeSale each sit at or below VIP, which sits at or below
// Platinum — but SVIP vs WholeSale has NO fixed order (either may be the
// cheaper of the two).
const PRICE_LISTS = {
  platinum: "2591985000001439015",
  vip: "2591985000000103001",
  svip: "2591985000078196985",
  wholesale: "2591985000000103011",
};
const PRICES_VIEW_URL =
  "https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936194/data";
// Rates that mean "not really priced yet" — pushed as stand-ins during the
// 2026-09 price update. They render, but the health flags ignore them.
const PRICE_PLACEHOLDERS = new Set([9999.99, 9000, 8888, 7777, 7000, 6000]);

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
  // Criteria matches stay in — they become the Archive bucket at build.
  const attributes = await stage("attributes", () => fetchItemAttributes(UNIVERSE));
  const attrById = new Map(attributes.map((r) => [r["Item ID"], r]));
  const itemIds = [...attrById.keys()];
  log(`  items:      ${itemIds.length} active`);

  // Manual archive / keep overrides.
  const overrideByItem = new Map(
    (await db.collection(ARCHIVE_COLLECTION).find({}).toArray()).map((d) => [String(d.itemId), d.mode]),
  );
  log(`  overrides:  ${overrideByItem.size} manual archive/keep entries`);

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

  // ── 2b. the list-only fields ──────────────────────────────────────
  // Shown in store and Zoho's category live on the items list alone
  // (fetchItemListFields) — one more pass.
  const listById = await stage("storefront", () => fetchItemListFields());
  log(`  storefront: ${[...listById.values()].filter((v) => v.showInStore).length} of ${listById.size} listed items shown in store`);

  // ── 3. collection tags ────────────────────────────────────────────
  // Stamped after the write (step 9): a collection is a filter over the
  // register, and the rows it should match are the ones about to be
  // written. Only the folder each collection sits in is known now.
  const groupByCollection = new Map();
  for (const g of await db.collection(COLLECTION_GROUPS).find({}).toArray()) {
    for (const c of g.collections || []) {
      if (c && c.title) groupByCollection.set(c.title, g.title);
    }
  }

  // ── 4. sales, one read for every bucket ───────────────────────────
  const sales = await stage("sales", async () => {
    const { salesRows, adjustmentRows, reasonByAdjustment } = await fetchWindowRows(DAYS);
    const now = Date.now();
    const byItem = new Map();
    const at = (id) => {
      if (!byItem.has(id)) {
        byItem.set(id, { units: {}, lastSaleAt: null });
        for (const b of BUCKETS) byItem.get(id).units[b] = emptySaleUnits();
      }
      return byItem.get(id);
    };
    // Every window counts by scope: orders under `online`, each counted
    // adjustment reason under its own name, and the total across all.
    const record = (id, qty, when, scope) => {
      if (!id || !qty) return;
      const e = at(id);
      const d = parseWhen(when);
      if (!d) return;
      const ageDays = (now - d.getTime()) / 86400000;
      for (const b of BUCKETS) {
        if (ageDays > b) continue;
        e.units[b].total += qty;
        e.units[b][scope] += qty;
      }
      if (!e.lastSaleAt || d > e.lastSaleAt) e.lastSaleAt = d;
    };
    for (const r of salesRows) {
      record(r["Product ID"], num(r["Quantity"]), r["Created Time"], "online");
    }
    for (const r of adjustmentRows) {
      const scope = OFFLINE_SALE_SCOPES[reasonByAdjustment.get(r["Inventory Adjustment ID"])];
      if (!scope) continue;
      // Stock leaving is a negative adjustment; flip it so sales read positive.
      record(r["Product ID"], num(r["Quantity Adjusted"]) * -1, r["Created Time"], scope);
    }
    log(`  sales:      ${salesRows.length} order rows + ${adjustmentRows.length} adjustments` +
      ` → ${byItem.size} items with movement`);
    return byItem;
  });

  // ── 5. our own catalogue and open purchase lines, by SKU ──────────
  const { productBySku, poBySku } = await stage("joins", async () => {
    const products = await db.collection(PRODUCTS)
      .find({}, { projection: { sku: 1, brand: 1, category: 1, quality: 1 } })
      .toArray();
    const productBySku = new Map(products.map((p) => [skuKey(p.sku), p]));

    // Spare Parts Purchase lines not yet received (the Tencent sheet until
    // 2026-09-23).
    const poBySku = await openPurchasesBySku(db);
    log(`  joins:      ${productBySku.size} catalogue SKUs · ${poBySku.size} SKUs on open purchase lines`);
    return { productBySku, poBySku };
  });

  // ── 5b. price-list rates ──────────────────────────────────────────
  // One whole-view Analytics read for all four lists; getViewData returns
  // an error BODY (not a throw) on failure, so validate and retry once
  // after the rate-limit window.
  const prices = await stage("prices", async () => {
    const idsIn = Object.values(PRICE_LISTS).map((v) => `'${v}'`).join(",");
    const url =
      `${PRICES_VIEW_URL}?CONFIG=` +
      encodeURIComponent(
        JSON.stringify({
          responseFormat: "json",
          selectedColumns: ["PriceList ID", "Product ID", "PriceList Rate"],
          criteria: `"PriceList ID" IN (${idsIn})`,
        }),
      );
    let priceRows = await getViewData(url);
    if (!Array.isArray(priceRows)) {
      log(`  prices:     first read failed (${JSON.stringify(priceRows).slice(0, 120)}) — waiting 65s`);
      await new Promise((r) => setTimeout(r, 65000));
      priceRows = await getViewData(url);
    }
    if (!Array.isArray(priceRows)) throw new Error("prices view read failed twice");
    const keyByList = new Map(Object.entries(PRICE_LISTS).map(([k, v]) => [v, k]));
    // "AUD 1,234.56" or a bare number — strip to the digits.
    const money = (raw) => {
      const n = parseFloat(String(raw == null ? "" : raw).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const byItem = new Map();
    for (const r of priceRows) {
      const k = keyByList.get(String(r["PriceList ID"]));
      if (!k) continue;
      const pid = String(r["Product ID"]);
      if (!byItem.has(pid)) byItem.set(pid, {});
      byItem.get(pid)[k] = money(r["PriceList Rate"]);
    }
    log(`  prices:     ${priceRows.length} list rows → ${byItem.size} items with a rate`);
    return byItem;
  });

  // ── 6. build the rows ─────────────────────────────────────────────
  const now = startedAt.getTime();
  const rows = [];
  for (const id of itemIds) {
    const a = attrById.get(id);
    const d = detailById.get(id);
    if (!d) continue;

    const sku = String(a.SKU || d.sku || "").trim();
    // An item with no SKU is not a stock-keeping unit — bookkeeping rows
    // ("credit", "startrack shipment refund", …) all lack one.
    if (!sku) continue;
    const key = skuKey(sku);
    // Zoho's catalogue custom fields; the classification decides the scope.
    const cf = itemCatalogueFields(d);
    const classification = cf.classification;
    const s = sales.get(id);
    const po = poBySku.get(key);
    const product = productBySku.get(key);

    const available = num(d.actual_available_for_sale_stock);
    const units = {};
    for (const b of BUCKETS) units[b] = roundSaleUnits(s ? s.units[b] : null);
    const lastSaleAt = s && s.lastSaleAt ? s.lastSaleAt : null;
    const daysSinceSale = lastSaleAt ? (now - lastSaleAt.getTime()) / 86400000 : null;

    const openPoQty = po ? po.qty : 0;

    // Archive bucket: the shared name criteria, or a manual "archive"
    // mark; a manual "keep" pins the item live regardless of criteria.
    const override = overrideByItem.get(id);
    const archived =
      override === "archive" ||
      (override !== "keep" && isNoiseName(a["Item Name"] || d.name));

    // Price health. Placeholder rates are shown but ignored by the flags.
    // Expected order: SVIP ≤ VIP, WholeSale ≤ VIP, VIP ≤ Platinum (and,
    // when VIP is absent, SVIP/WholeSale ≤ Platinum directly) — SVIP vs
    // WholeSale deliberately unordered: either may be the cheaper.
    const pr = prices.get(id) || {};
    const purchase = num(a["Purchase Price"]);
    const rateChain = [pr.wholesale, pr.svip, pr.vip, pr.platinum];
    const realRates = rateChain.filter((v) => v != null && !PRICE_PLACEHOLDERS.has(v));
    const priceMissing = rateChain.some((v) => v == null);
    const pricePlaceholder = rateChain.some((v) => v != null && PRICE_PLACEHOLDERS.has(v));
    const priceBelowCost = purchase > 0 && realRates.some((v) => v < purchase);
    const real = (v) => (v != null && !PRICE_PLACEHOLDERS.has(v) ? v : null);
    const rSvip = real(pr.svip), rWs = real(pr.wholesale), rVip = real(pr.vip), rPlat = real(pr.platinum);
    const lte = (a2, b2) => a2 == null || b2 == null || a2 <= b2 + 1e-9;
    const priceOrderBroken = !(
      lte(rSvip, rVip) && lte(rWs, rVip) && lte(rVip, rPlat) &&
      lte(rSvip, rPlat) && lte(rWs, rPlat)
    );
    // The pricing-formula verdict for cost-priced items (±5% tolerance).
    const ruleEval = evaluatePriceRule({
      name: a["Item Name"] || d.name,
      category: product && product.category ? product.category.name : null,
      classification,
      quality: cf.quality,
      purchasePrice: purchase,
      priceWholesale: pr.wholesale,
      priceSvip: pr.svip,
      priceVip: pr.vip,
      pricePlatinum: pr.platinum,
    });
    rows.push({
      snapshotDate,
      itemId: id,
      sku,
      name: String(a["Item Name"] || d.name || ""),
      // Accessories and spare parts are separate businesses and get
      // separate views. Classification and accessory brand mark an
      // accessory (accessory-collection membership used to as well, but
      // a collection is now a filter over these very rows, and a filter
      // cannot decide the scope it is filtered by); the rest is parts.
      scope:
        ACCESSORY_CLASSIFICATIONS.has(classification) ||
        ACCESSORY_BRANDS.has(String(a.Brand || "").trim())
          ? "accessory"
          : "parts",
      classification,
      subClassification: cf.subClassification,
      quality: cf.quality,
      deviceBrand: cf.deviceBrand,
      deviceSeries: cf.deviceSeries,
      compatibleModels: cf.compatibleModels,
      // Zoho's reorder point — the Accessories page edits it inline.
      reorderLevel: num(d.reorder_level),
      // The shelf from the item record first: Analytics carries it too but
      // hours behind a move (the live page showed 4 of 35 iPad screens on a
      // different shelf from the register on 2026-09-22).
      location: String(itemLocation(d) || a.Location || ""),
      preferVendor: String(a["Prefer Vendor"] || ""),
      zohoBrand: String(a.Brand || ""),
      purchasePrice: num(a["Purchase Price"]),

      // `collections`, `accessoryCollections` and `groups` are stamped in
      // step 9, after the rows exist to be matched.

      // From the old imb_products catalogue, where the SKU matches — brand
      // and category only, until Device Brand and Classification replace
      // them on the pages. Its quality is no longer read: Zoho's Quality
      // above is the record (the catalogue's "Original" was a default).
      brand: product && product.brand ? product.brand.name : null,
      category: product && product.category ? product.category.name : null,
      inCatalogue: !!product,
      imageId: imageIdOf(d),
      // From the items list: shown in the online store, and Zoho's own
      // item category (accessories are organised by it; parts are not).
      showInStore: !!(listById.get(id) || {}).showInStore,
      zohoCategoryId: (listById.get(id) || {}).categoryId || "",
      zohoCategory: (listById.get(id) || {}).category || "",

      available,
      accountingStock: num(d.available_for_sale_stock),
      stockOnHand: num(d.stock_on_hand),
      committed: num(d.actual_committed_stock),

      // Each window by scope: { total, online, inflow, repair, neto, dashboard }.
      units7: units[7],
      units14: units[14],
      units30: units[30],
      units90: units[90],
      lastSaleAt,
      daysSinceSale: daysSinceSale == null ? null : Math.floor(daysSinceSale),

      openPoQty,
      openPoLines: po ? po.lines : 0,
      earliestPoDate: po ? po.earliest : null,

      // The four price-list rates (null = no entry in that list), and the
      // health flags the Price Monitoring tiles count.
      pricePlatinum: pr.platinum == null ? null : pr.platinum,
      priceVip: pr.vip == null ? null : pr.vip,
      priceSvip: pr.svip == null ? null : pr.svip,
      priceWholesale: pr.wholesale == null ? null : pr.wholesale,
      priceMissing,
      pricePlaceholder,
      priceBelowCost,
      priceOrderBroken,
      // The formula family, expected rates, and the ±5% verdict — null /
      // false when the item has no cost price.
      priceRule: ruleEval.rule,
      priceExpected: ruleEval.expected,
      priceRuleBroken: ruleEval.broken,

      // The flags the dashboard tiles count (stockFlags: out of stock /
      // on order / below cover, and days of cover at the 30-day rate).
      ...stockFlags({ available, units30: units[30].total, openPoQty }),
      stale: units[STALE_DAYS].total === 0,
      // The Archive bucket: criteria matches + manual marks (see above).
      // NOT the old "no sales, no stock" meaning — those stay in All Items.
      archived,
      archivedReason: archived ? (override === "archive" ? "manual" : "criteria") : null,
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
    log(`    archive (criteria)       ${count((r) => r.archivedReason === "criteria", list)}`);
    log(`    archive (manual)         ${count((r) => r.archivedReason === "manual", list)}`);
    log(`    price: missing a list    ${count((r) => r.priceMissing, list)}`);
    log(`    price: placeholder       ${count((r) => r.pricePlaceholder, list)}`);
    log(`    price: below cost        ${count((r) => r.priceBelowCost, list)}`);
    log(`    price: order broken      ${count((r) => r.priceOrderBroken, list)}`);
    log(`    price: off formula ±5%   ${count((r) => r.priceRuleBroken, list)}`);
  }

  const durationMs = Date.now() - startedAt.getTime();
  const finishedAt = new Date();
  const run = {
    snapshotDate,
    // When the numbers were taken — the rows' metricsAt.
    metricsAt: finishedAt,
    startedAt,
    finishedAt,
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
      noImage: count((r) => !r.imageId),
    },
    timings,
    applied: APPLY,
  };

  log(`\n  timings: ${Object.entries(timings).map(([k, v]) => `${k} ${Math.round(v / 100) / 10}s`).join(" · ")}`);
  log(`  total:   ${Math.round(durationMs / 100) / 10}s`);

  if (!APPLY) {
    log("\nDRY RUN — nothing written. Pass --apply to store this snapshot.");
    log(`  would refresh ${rows.length} rows in ${ITEMS}`);
    log(`  sample: ${JSON.stringify(rows.find((r) => r.outOfStockUncovered) || rows[0], null, 2).slice(0, 700)}`);
    return;
  }

  // ── 8. write ──────────────────────────────────────────────────────
  // Update in place, one row per item. Every row this run produced gets
  // its catalogue fields and a whole new `metrics`, stamped with the same
  // instant; a row the run did NOT touch is an item Zoho no longer lists,
  // so it is flagged inactive rather than deleted (its manual archive
  // mark and price history stay readable).
  const items = db.collection(ITEMS);
  await ensureIndexes(db);
  const ops = rows.map((row) => {
    const { catalogue, metrics } = splitRow(row);
    return {
      updateOne: {
        filter: { itemId: row.itemId },
        update: {
          $set: { ...catalogue, metrics, metricsAt: finishedAt, active: true, lastSeenAt: finishedAt, inactiveAt: null },
          $setOnInsert: { firstSeenAt: finishedAt },
        },
        upsert: true,
      },
    };
  });
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const r = await items.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    inserted += r.upsertedCount || 0;
  }
  const gone = await items.updateMany(
    { active: true, lastSeenAt: { $lt: finishedAt } },
    { $set: { active: false, inactiveAt: finishedAt } },
  );
  run.counts.inserted = inserted;
  run.counts.inactivated = gone.modifiedCount || 0;

  // ── 9. collection tags ────────────────────────────────────────────
  // Every collection's filter, run against the rows just written; the
  // titles (and the folder each one sits in) go on the member rows, and
  // come off everything else. The dashboard's Collection filter and the
  // Stock Monitoring branch views read these tags.
  const tagT = Date.now();
  let tagged = 0;
  for (const store of ["productCollections", "accessoryCollections"]) {
    const field = TAG_FIELD_BY_STORE[store];
    const byItem = new Map();
    for (const c of await db.collection(store).find({}).toArray()) {
      for (const id of await resolveCollectionItemIds(db, c, SCOPE_BY_STORE[store])) {
        if (!byItem.has(id)) byItem.set(id, []);
        byItem.get(id).push(c.title);
      }
    }
    const tagOps = [];
    for (const [id, titles] of byItem) {
      const set = { [field]: titles };
      if (store === "productCollections") {
        set.groups = [...new Set(titles.map((t) => groupByCollection.get(t)).filter(Boolean))];
      }
      tagOps.push({ updateOne: { filter: { itemId: id }, update: { $set: set } } });
    }
    for (let i = 0; i < tagOps.length; i += 1000) await items.bulkWrite(tagOps.slice(i, i + 1000), { ordered: false });
    const clear = { [field]: [] };
    if (store === "productCollections") clear.groups = [];
    // Inactive rows too — an item that went inactive must not keep its tag.
    await items.updateMany({ itemId: { $nin: [...byItem.keys()] }, [field]: { $ne: [] } }, { $set: clear });
    if (store === "productCollections") tagged = byItem.size;
    log(`  tagged:     ${byItem.size} items in ${store}`);
  }
  run.timings.tags = Date.now() - tagT;
  run.counts.tagged = tagged;
  // The write is a good share of the run now that rows are upserted one by
  // one rather than inserted in bulk — count it in the duration.
  run.timings.write = Date.now() - finishedAt.getTime();
  run.durationMs = Date.now() - startedAt.getTime();
  run.finishedAt = new Date();
  await db.collection(RUNS).insertOne(run);
  log(`\nrefreshed ${rows.length} rows in ${ITEMS} · ${inserted} new · ${gone.modifiedCount || 0} no longer listed`);
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
