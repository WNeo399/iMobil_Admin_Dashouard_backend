// Hourly incremental sync of the stock register (imb_stock_items) from
// Zoho Inventory.
//
// Zoho's item list takes a `last_modified_time` and returns only the items
// changed after it — an edit, a status change, or a stock movement all
// count. Measured 2026-09-21: ~155 items an hour against a 19k catalogue.
// So each run reads just those (1 list call per 200, 1 details call per
// 100), and updates their rows in place: name, SKU, shelf, image, purchase
// price, Zoho's catalogue custom fields (classification, sub classification,
// quality, device brand / series / compatible models), reorder level, the
// shown-in-store flag (which the list row carries), our old catalogue
// match, the archive rule, and current stock (physical and accounting) with
// the stock-dependent flags. New items are inserted; an item gone inactive (or
// left without a SKU) is flagged inactive at once.
//
// What it deliberately leaves to the nightly refresh (bin/stockSnapshot.js):
// the sales windows and everything built on them, price lists and price
// health, and collection tags (all Analytics reads), and
// noticing deleted items (a "modified since" list never shows those). A new
// item therefore arrives with its Zoho fields and empty demand, and is
// filled in that night; its scope is guessed from the Zoho brand until then.
//
// State lives in imb_sync_state (one doc): the watermark `since`, a lock so
// two callers (the external trigger, the dashboard's manual run, the CLI —
// or two backends sharing the database) never run at once, and the last
// result for the dashboard. The watermark is read back with a five-minute
// overlap so a change landing on the boundary is never missed — an item
// synced twice is merely rewritten with the same values.
//
// Nothing here schedules itself: an external scheduler calls
// /integration/stockSync (routes/stockSyncRoutes) hourly, or runs
// bin/stockItemsSync.js. runStockItemsSync() is one pass.

const { connectToDatabase } = require("./mongodb");
const { handleZohoInventoryRequest } = require("./zohoRequest");
const { fetchItemDetails, itemLocation, itemCatalogueFields, listFields, ORGANIZATION_ID } = require("./zohoStock");
const {
  ITEMS,
  openPurchasesBySku,
  refreshOnOrder,
  ACCESSORY_CLASSIFICATIONS,
  ACCESSORY_BRANDS,
  skuKey,
  num,
  stockFlags,
  emptySaleUnits,
} = require("./stockItems");
const { imageIdOf } = require("./productImage");
const { isNoiseName, ARCHIVE_COLLECTION } = require("./stockUniverse");

const STATE = "imb_sync_state";
const STATE_ID = "stockItems";
const PRODUCTS = "imb_products";

const PAGE = 200;
// 25 pages = 5,000 changed items in one pass — far above an hour's worth.
// Past that the run stops and the watermark advances only as far as it
// read, so the rest is picked up next time rather than the quota burnt.
const MAX_PAGES = 25;
const OVERLAP_MS = 5 * 60 * 1000;
// A lock older than this belongs to a run that died; take it over.
const LOCK_STALE_MS = 15 * 60 * 1000;

// Zoho wants "2026-09-21T02:03:44+0000"; it answers with "+1000" offsets
// that Date() only parses once a colon is put in.
function zohoTime(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "+0000");
}
function parseZohoTime(s) {
  const d = new Date(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Items modified after `since`, oldest first. { items, complete } — complete
// is false when MAX_PAGES was hit.
async function listModifiedSince(since) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://www.zohoapis.com/inventory/v1/items?organization_id=${ORGANIZATION_ID}` +
      `&per_page=${PAGE}&page=${page}&sort_column=last_modified_time&sort_order=A` +
      `&last_modified_time=${encodeURIComponent(zohoTime(since))}`;
    const r = await handleZohoInventoryRequest(url);
    if (!r || r.code !== 0) {
      throw new Error(`Zoho items list failed: ${(r && r.message) || "no response"}`);
    }
    items.push(...(r.items || []));
    if (!(r.page_context && r.page_context.has_more_page)) return { items, complete: true };
  }
  return { items, complete: false };
}

// Take the lock, or report who holds it. Returns the state doc on success.
async function acquireLock(db, now) {
  const state = db.collection(STATE);
  let doc = await state.findOne({ _id: STATE_ID });
  if (!doc) {
    try {
      await state.insertOne({ _id: STATE_ID, running: false, since: null });
    } catch (e) {
      // Someone else created it a moment ago.
    }
    doc = await state.findOne({ _id: STATE_ID });
  }
  const r = await state.updateOne(
    {
      _id: STATE_ID,
      $or: [{ running: { $ne: true } }, { runningSince: { $lt: new Date(now.getTime() - LOCK_STALE_MS) } }],
    },
    { $set: { running: true, runningSince: now } },
  );
  return r.matchedCount ? doc : null;
}

async function runStockItemsSync({ log = () => {}, trigger = "schedule" } = {}) {
  const startedAt = new Date();
  const db = await connectToDatabase();
  const state = db.collection(STATE);
  const items = db.collection(ITEMS);

  const doc = await acquireLock(db, startedAt);
  if (!doc) {
    log("stock sync: already running elsewhere — skipped");
    return { skipped: "running" };
  }

  try {
    // The watermark: where the last run got to; failing that, the newest
    // time the register was confirmed against Zoho; failing that, an hour.
    let since = doc.since ? new Date(doc.since) : null;
    if (!since) {
      const newest = await items.find({}, { projection: { lastSeenAt: 1 } }).sort({ lastSeenAt: -1 }).limit(1).next();
      since = (newest && newest.lastSeenAt) || new Date(startedAt.getTime() - 60 * 60 * 1000);
    }
    const readFrom = new Date(since.getTime() - OVERLAP_MS);
    // New rows take the register's current stamp so they don't move the
    // pages' "as of" — that belongs to the full refresh.
    const stamp = await items.find({ active: true }, { projection: { metricsAt: 1 } }).sort({ metricsAt: -1 }).limit(1).next();
    const metricsAt = (stamp && stamp.metricsAt) || startedAt;

    const { items: listed, complete } = await listModifiedSince(readFrom);
    const ids = [...new Set(listed.map((i) => String(i.item_id)))];
    // show_in_storefront and the Zoho category live on the list row, not
    // the detail record.
    const listById = new Map(listed.map((i) => [String(i.item_id), listFields(i)]));
    log(`stock sync: ${ids.length} items modified since ${readFrom.toISOString()}${complete ? "" : " (capped — more next run)"}`);

    let changed = 0, inserted = 0, inactivated = 0;
    if (ids.length) {
      const [details, existingRows, overrides, products, poBySku] = await Promise.all([
        fetchItemDetails(ids),
        items.find({ itemId: { $in: ids } }, { projection: { itemId: 1, active: 1, scope: 1, "metrics.units30": 1 } }).toArray(),
        db.collection(ARCHIVE_COLLECTION).find({ itemId: { $in: ids } }, { projection: { itemId: 1, mode: 1 } }).toArray(),
        // Same joins as the nightly run: our catalogue, and open purchase
        // lines (Spare Parts Purchase), by SKU.
        db.collection(PRODUCTS).find({}, { projection: { sku: 1, brand: 1, category: 1, quality: 1 } }).toArray(),
        openPurchasesBySku(db),
      ]);
      const existingById = new Map(existingRows.map((r) => [r.itemId, r]));
      const overrideById = new Map(overrides.map((o) => [String(o.itemId), o.mode]));
      const productBySku = new Map(products.map((p) => [skuKey(p.sku), p]));

      const ops = [];
      for (const d of details) {
        const id = String(d.item_id);
        const sku = String(d.sku || "").trim();
        const existing = existingById.get(id);
        // The universe is Active with a SKU; anything else is out.
        if (String(d.status).toLowerCase() !== "active" || !sku) {
          if (existing && existing.active) {
            ops.push({ updateOne: { filter: { itemId: id }, update: { $set: { active: false, inactiveAt: startedAt, lastSeenAt: startedAt } } } });
            inactivated++;
          }
          continue;
        }
        const key = skuKey(sku);
        const name = String(d.name || "");
        const product = productBySku.get(key);
        const po = poBySku.get(key);
        const override = overrideById.get(id);
        const archived = override === "archive" || (override !== "keep" && isNoiseName(name));
        const available = num(d.actual_available_for_sale_stock);
        const openPoQty = po ? po.qty : 0;
        const u30 = existing && existing.metrics ? existing.metrics.units30 : null;
        const units30 = u30 && typeof u30 === "object" ? num(u30.total) : num(u30);
        const flags = stockFlags({ available, units30, openPoQty });
        const zohoBrand = String(d.brand || "");
        const cf = itemCatalogueFields(d);

        const set = {
          sku,
          name,
          location: String(itemLocation(d) || ""),
          zohoBrand,
          purchasePrice: num(d.purchase_rate),
          imageId: imageIdOf(d),
          showInStore: !!(listById.get(id) || {}).showInStore,
          zohoCategoryId: (listById.get(id) || {}).categoryId || "",
          zohoCategory: (listById.get(id) || {}).category || "",
          // Zoho's catalogue custom fields and reorder point — an edit in
          // Zoho shows on the pages within the hour.
          classification: cf.classification,
          subClassification: cf.subClassification,
          quality: cf.quality,
          deviceBrand: cf.deviceBrand,
          deviceSeries: cf.deviceSeries,
          compatibleModels: cf.compatibleModels,
          reorderLevel: num(d.reorder_level),
          brand: product && product.brand ? product.brand.name : null,
          category: product && product.category ? product.category.name : null,
          inCatalogue: !!product,
          archived,
          archivedReason: archived ? (override === "archive" ? "manual" : "criteria") : null,
          active: true,
          inactiveAt: null,
          lastSeenAt: startedAt,
          stockAt: startedAt,
          "metrics.available": available,
          "metrics.accountingStock": num(d.available_for_sale_stock),
          "metrics.stockOnHand": num(d.stock_on_hand),
          "metrics.committed": num(d.actual_committed_stock),
          "metrics.openPoQty": openPoQty,
          "metrics.openPoLines": po ? po.lines : 0,
          "metrics.earliestPoDate": po ? po.earliest : null,
        };
        for (const [k, v] of Object.entries(flags)) set[`metrics.${k}`] = v;

        // A new item: the fields only the nightly run can fill start empty.
        const setOnInsert = {
          firstSeenAt: startedAt,
          metricsAt,
          scope: ACCESSORY_CLASSIFICATIONS.has(cf.classification) || ACCESSORY_BRANDS.has(zohoBrand) ? "accessory" : "parts",
          preferVendor: "",
          collections: [],
          accessoryCollections: [],
          groups: [],
          pricePlatinum: null,
          priceVip: null,
          priceSvip: null,
          priceWholesale: null,
          priceMissing: true,
          pricePlaceholder: false,
          priceBelowCost: false,
          priceOrderBroken: false,
          priceRule: null,
          priceExpected: null,
          priceRuleBroken: false,
          "metrics.units7": emptySaleUnits(),
          "metrics.units14": emptySaleUnits(),
          "metrics.units30": emptySaleUnits(),
          "metrics.units90": emptySaleUnits(),
          "metrics.lastSaleAt": null,
          "metrics.daysSinceSale": null,
          "metrics.stale": true,
        };
        ops.push({ updateOne: { filter: { itemId: id }, update: { $set: set, $setOnInsert: setOnInsert }, upsert: true } });
        changed++;
      }
      for (let i = 0; i < ops.length; i += 500) {
        const r = await items.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        inserted += r.upsertedCount || 0;
      }
    }

    // On order for every item, not just the ones Zoho changed: purchase
    // lines move without Zoho knowing.
    const onOrderRestamped = await refreshOnOrder(db);

    // Advance the watermark: to the start of this run when everything was
    // read, else only as far as the newest item actually processed.
    let nextSince = startedAt;
    if (!complete) {
      const times = listed.map((i) => parseZohoTime(i.last_modified_time)).filter(Boolean);
      nextSince = times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : since;
    }
    const result = {
      trigger,
      startedAt,
      ms: Date.now() - startedAt.getTime(),
      listed: ids.length,
      changed,
      inserted,
      inactivated,
      onOrderRestamped,
      complete,
    };
    await state.updateOne(
      { _id: STATE_ID },
      { $set: { running: false, since: nextSince, lastRunAt: startedAt, lastResult: result, lastError: null } },
    );
    log(`stock sync: ${changed} updated · ${inserted} new · ${inactivated} inactivated · ${onOrderRestamped} on-order restamped · ${result.ms}ms`);
    return result;
  } catch (error) {
    await state.updateOne(
      { _id: STATE_ID },
      { $set: { running: false, lastRunAt: startedAt, lastError: { at: new Date(), message: error.message } } },
    );
    log(`stock sync FAILED: ${error.message}`);
    throw error;
  }
}

// The dashboard's view of the sync: when it last ran and how it went.
async function getStockItemsSyncState(db) {
  const doc = await db.collection(STATE).findOne({ _id: STATE_ID }, { projection: { _id: 0 } });
  if (!doc) return null;
  return {
    since: doc.since || null,
    running: !!doc.running,
    lastRunAt: doc.lastRunAt || null,
    lastResult: doc.lastResult || null,
    lastError: doc.lastError || null,
  };
}

module.exports = { runStockItemsSync, getStockItemsSyncState };
