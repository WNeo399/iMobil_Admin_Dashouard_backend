// Stock Monitoring — reads the stock register, imb_stock_items: one row per
// Zoho item, refreshed in place by bin/stockSnapshot.js (nightly) and
// utils/stockItemsSync (hourly). See utils/stockItems for the row's shape.
//
// The list, the tiles and the shelves come entirely from the register, so
// the page loads in milliseconds where the live sweep takes a minute and a
// half. The trade is freshness: those are "as of" the last refresh, and the
// summary says so plainly rather than letting yesterday pass for today —
// while the Stock column is overlaid live for the rows on screen.
//
//   GET /stock-monitor/summary               as-of, tile counts, filter options
//   GET /stock-monitor/items                 the working list, filtered and paged
//   GET /stock-monitor/collection-items      a collection's rows (the Stock Monitoring list)
//   GET /stock-monitor/browse-tree           the catalogue as Brand → Series → Classification, with counts
//   GET /stock-monitor/browse-items          one node of that tree: tile counts + a page of rows
//   GET /stock-monitor/shelves               shelf rollup for a stock take
//   GET /stock-monitor/item/:id              one item's row
//   GET /stock-monitor/live?ids=             live stock for the rows on screen
//   GET /stock-monitor/item/:id/sales        who bought it, live from Zoho
//   GET /stock-monitor/item/:id/sales-trend  units per week, live from Analytics
//
// The last three are the exceptions that do hit Zoho: current stock,
// invoice numbers and customer names, and dated sales are not in the
// register (it stores totals, not lines), and they run only for what is on
// screen or for one item when someone opens its drawer.
//
// Reading needs zoho:stock:view — the same permission as the per-collection
// Stock Monitoring page.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const {
  getViewData,
  handleZohoInventoryRequest,
  handleZohoInventoryPutRequest,
  handleZohoInventoryMultipartPostRequest,
  refreshToken,
} = require("../../utils/zohoRequest");
const { mapWithLimit, fetchItemDetails, fetchItemWindowRows, OFFLINE_SALE_SCOPES } = require("../../utils/zohoStock");
const { imageIdOf, imageUrlFromId } = require("../../utils/productImage");
// The register: one row per item, numbers under `metrics`, answered flat.
const { ITEMS, flatten, path: fieldPath, melbourneDate } = require("../../utils/stockItems");
const { runStockItemsSync, getStockItemsSyncState } = require("../../utils/stockItemsSync");
const { startFullRefresh, isFullRefreshRunning, onFullRefreshFinished } = require("../../utils/stockRefresh");
// A collection is a filter over the register — evaluated here on every
// read, so the list is always current.
const { collectionMatch, SCOPE_BY_STORE } = require("../../utils/collectionFilter");

const RUNS = "imb_stock_runs";

const VIEW = requirePermission("zoho:stock:view");

const SCOPES = ["parts", "accessory"];
const MAX_PAGE_SIZE = 200;

// The named lists the tiles link to. Each is a Mongo predicate fragment, so
// a tile and its table are guaranteed to count the same rows — the classic
// way these dashboards drift is a tile and a list disagreeing.
const FILTERS = {
  all: {},
  outOfStock: { "metrics.outOfStock": true },
  // Out of stock with nothing coming: the buy list.
  uncovered: { "metrics.outOfStockUncovered": true },
  onOrder: { "metrics.outOfStockCovered": true },
  belowCover: { "metrics.belowMonthCover": true },
  // "No sales in a fortnight" on its own is most of a long-tail catalogue.
  // Crossed with stock on hand it becomes money sitting on a shelf.
  sittingStill: { "metrics.stale": true, "metrics.available": { $gt: 0 } },
  negative: { "metrics.available": { $lt: 0 } },
  // Sold recently but at zero now — the shortest actionable list there is.
  sellingAndOut: { "metrics.outOfStock": true, "metrics.units90.total": { $gt: 0 } },
  // Price health (the Price Monitoring page's tiles).
  priceMissing: { priceMissing: true },
  pricePlaceholder: { pricePlaceholder: true },
  // The merged "Missing Price" tile: no rate in a list OR a placeholder
  // rate — both mean "not really priced". $expr keeps it clear of the
  // search filter's $or.
  priceUnpriced: { $expr: { $or: ["$priceMissing", "$pricePlaceholder"] } },
  priceBelowCost: { priceBelowCost: true },
  priceOrderBroken: { priceOrderBroken: true },
  // Cost-priced items whose rates sit >5% off the pricing formula.
  priceRuleBroken: { priceRuleBroken: true },
  // Missing product image (the Missing Images page). $type "null" matches an
  // explicit null only: rows written before imageId existed
  // have no field at all and must not read as "no image".
  noImage: { imageId: { $type: "null" } },
  noImageInStock: { imageId: { $type: "null" }, "metrics.available": { $gt: 0 } },
  noImageOutOfStock: { imageId: { $type: "null" }, "metrics.available": { $lte: 0 } },
  // The Archive bucket — criteria matches + manual marks.
  archived: { archived: true },
  // Its no-image slice: the Missing Images page's "archived — view".
  noImageArchived: { archived: true, imageId: { $type: "null" } },
};
// Filters that look inside the Archive bucket; every other view hides it.
const ARCHIVE_FILTERS = new Set(["archived", "noImageArchived"]);

const SORTABLE = new Set([
  "sku", "name", "location", "available", "units7", "units14", "units30",
  "units90", "openPoQty", "daysOfCover", "daysSinceSale",
  "purchasePrice", "pricePlatinum", "priceVip", "priceSvip", "priceWholesale",
]);

function scopeOf(req) {
  const s = String(req.query.scope || "parts");
  return SCOPES.includes(s) ? s : "parts";
}

// The tile aggregation groups on null; the page has no use for that key.
function stripId(doc) {
  const { _id, ...rest } = doc || {};
  return rest;
}

function escapeRegex(v) {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The newest refresh we hold: when the numbers were taken (metricsAt) and
// the warehouse day that falls on, which the pages call the snapshot date.
// A failed run leaves the previous numbers in place, with their own stamp,
// so the UI can say how old they are. An indexed sort-and-take-one, cached
// for a minute: this runs at the top of every request in the module, the
// value changes once a refresh, and the Mongo server is a ~170ms network
// round trip away.
let refreshCache = { value: null, at: 0 };
async function latestRefresh(db) {
  if (refreshCache.value && Date.now() - refreshCache.at < 60000) {
    return refreshCache.value;
  }
  const row = await db
    .collection(ITEMS)
    .find({ active: true }, { projection: { _id: 0, metricsAt: 1 } })
    .sort({ metricsAt: -1 })
    .limit(1)
    .next();
  const value =
    row && row.metricsAt ? { metricsAt: row.metricsAt, snapshotDate: melbourneDate(row.metricsAt) } : null;
  if (value) refreshCache = { value, at: Date.now() };
  return value;
}
async function latestSnapshotDate(db) {
  const r = await latestRefresh(db);
  return r ? r.snapshotDate : null;
}

// The user-set filters (search box and the dropdowns) as a match fragment.
// Shared by /items and /summary so the tiles count exactly the rows the
// table would show under the same filters — the named tile filter itself is
// deliberately NOT in here, or clicking a tile would zero out its siblings.
function baseFilterMatch(req) {
  const q = req.query || {};
  const match = {};
  const search = String(q.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    match.$or = [{ sku: re }, { name: re }];
  }
  for (const [param, field] of [
    ["category", "category"],
    ["quality", "quality"],
    ["brand", "brand"],
    ["collection", "collections"],
    ["location", "location"],
    ["vendor", "preferVendor"],
  ]) {
    const v = String(q[param] || "").trim();
    if (v) match[field] = v;
  }
  return match;
}

// Turn the query string into a match document. Archive rows (criteria
// matches + manual marks) are excluded from every view except the archive
// filter itself.
function buildMatch(req) {
  const q = req.query || {};
  const match = { active: true, scope: scopeOf(req), ...baseFilterMatch(req) };

  const filter = FILTERS[q.filter] ? q.filter : "all";
  Object.assign(match, FILTERS[filter]);

  // The Archive bucket (criteria matches + manual marks) is hidden from
  // every view except its own filters.
  if (!ARCHIVE_FILTERS.has(filter)) match.archived = { $ne: true };

  return { match, filter };
}

// ── POST /stock-monitor/snapshot/run ────────────────────────────────
// The full register refresh on demand (the dashboard's "Update Now"
// button when the overnight run hasn't happened). utils/stockRefresh
// spawns bin/stockSnapshot.js --apply, one run at a time, shared with the
// external trigger; the dashboard polls GET /snapshot/run until it ends.
// Drop the cached stamp when any run ends, so fresh numbers show at once.
onFullRefreshFinished(() => {
  refreshCache = { value: null, at: 0 };
});

router.post("/snapshot/run", VIEW, (req, res) => {
  const r = startFullRefresh((req.user && req.user.username) || "unknown");
  return res.json({ success: true, running: r.running, ...(r.started ? {} : { alreadyRunning: true }) });
});

// ── POST /stock-monitor/sync/run ────────────────────────────────────
// One pass of the hourly sync, now. Seconds, not minutes, so it answers
// with the result rather than polling.
router.post("/sync/run", VIEW, async (req, res) => {
  try {
    const result = await runStockItemsSync({
      log: console.log,
      trigger: `manual:${(req.user && req.user.username) || "unknown"}`,
    });
    refreshCache = { value: null, at: 0 };
    return res.json({ success: true, result });
  } catch (error) {
    return res.status(502).json({ success: false, message: error.message || "Sync failed" });
  }
});

router.get("/snapshot/run", VIEW, (req, res) => {
  return res.json({ success: true, running: isFullRefreshRunning() });
});

// ── GET /stock-monitor/summary ──────────────────────────────────────
// One aggregation for every tile, plus the values the filter selects
// offer. Both are derived from the register, so a category with no rows
// today simply isn't offered.
router.get("/summary", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const refresh = await latestRefresh(db);
    if (!refresh) {
      return res.json({ success: true, snapshotDate: null, metricsAt: null, run: null, counts: null, options: null });
    }
    const { snapshotDate, metricsAt } = refresh;
    const scope = scopeOf(req);
    const base = { active: true, scope };
    // The Archive bucket sits outside every tile; its own count rides in
    // counts.archived for the "view archived" link.
    const live = { ...base, archived: { $ne: true } };
    // The user's filters narrow the tiles too, so the numbers always
    // describe what the table below them would show.
    const filtered = { ...live, ...baseFilterMatch(req) };

    // Every tile counts over the SAME row set the lists show — filters
    // applied. Counting a tile over a wider set than its table is how a
    // dashboard ends up quietly lying: click 92 and get 155.
    const [tiles] = await db
      .collection(ITEMS)
      .aggregate([
        { $match: filtered },
        {
          $group: {
            _id: null,
            items: { $sum: 1 },
            outOfStock: { $sum: { $cond: ["$metrics.outOfStock", 1, 0] } },
            uncovered: { $sum: { $cond: ["$metrics.outOfStockUncovered", 1, 0] } },
            onOrder: { $sum: { $cond: ["$metrics.outOfStockCovered", 1, 0] } },
            belowCover: { $sum: { $cond: ["$metrics.belowMonthCover", 1, 0] } },
            sittingStill: { $sum: { $cond: [{ $and: ["$metrics.stale", { $gt: ["$metrics.available", 0] }] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $lt: ["$metrics.available", 0] }, 1, 0] } },
            sellingAndOut: {
              $sum: { $cond: [{ $and: ["$metrics.outOfStock", { $gt: ["$metrics.units90.total", 0] }] }, 1, 0] },
            },
            priceMissing: { $sum: { $cond: ["$priceMissing", 1, 0] } },
            pricePlaceholder: { $sum: { $cond: ["$pricePlaceholder", 1, 0] } },
            priceUnpriced: { $sum: { $cond: [{ $or: ["$priceMissing", "$pricePlaceholder"] }, 1, 0] } },
            priceRuleBroken: { $sum: { $cond: ["$priceRuleBroken", 1, 0] } },
            priceBelowCost: { $sum: { $cond: ["$priceBelowCost", 1, 0] } },
            priceOrderBroken: { $sum: { $cond: ["$priceOrderBroken", 1, 0] } },
            noImage: { $sum: { $cond: [{ $eq: [{ $type: "$imageId" }, "null"] }, 1, 0] } },
            noImageInStock: {
              $sum: { $cond: [{ $and: [{ $eq: [{ $type: "$imageId" }, "null"] }, { $gt: ["$metrics.available", 0] }] }, 1, 0] },
            },
            noImageOutOfStock: {
              $sum: { $cond: [{ $and: [{ $eq: [{ $type: "$imageId" }, "null"] }, { $lte: ["$metrics.available", 0] }] }, 1, 0] },
            },
            unitsOnHand: { $sum: { $cond: [{ $gt: ["$metrics.available", 0] }, "$metrics.available", 0] } },
          },
        },
      ])
      .toArray();

    const [totals] = await db
      .collection(ITEMS)
      .aggregate([
        { $match: { ...base, ...baseFilterMatch(req) } },
        {
          $group: {
            _id: null,
            all: { $sum: 1 },
            archived: { $sum: { $cond: ["$archived", 1, 0] } },
            noImageArchived: {
              $sum: { $cond: [{ $and: ["$archived", { $eq: [{ $type: "$imageId" }, "null"] }] }, 1, 0] },
            },
          },
        },
      ])
      .toArray();

    // distinct is unavailable (the client runs apiStrict), so the filter
    // options come from grouping. These four dimensions are small — the
    // largest is 39 vendors — so no cap is needed and none is applied:
    // a silently truncated filter list is worse than a slow one.
    //
    // Shelves are deliberately NOT here. There are over a thousand of
    // them, which is a different kind of list; the page reads those from
    // /shelves, which returns every one with its counts.
    const optionsOf = async (field, unwind) => {
      const stages = [{ $match: live }];
      if (unwind) stages.push({ $unwind: `$${field}` });
      stages.push(
        { $match: { [field]: { $nin: [null, ""] } } },
        { $group: { _id: `$${field}`, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      );
      const rows = await db.collection(ITEMS).aggregate(stages).toArray();
      return rows.map((r) => ({ value: r._id, count: r.n }));
    };

    const [categories, collections, vendors, qualities] = await Promise.all([
      optionsOf("category"),
      optionsOf("collections", true),
      optionsOf("preferVendor"),
      optionsOf("quality"),
    ]);

    const [run, sync] = await Promise.all([
      db.collection(RUNS).findOne({}, { sort: { startedAt: -1 } }),
      getStockItemsSyncState(db),
    ]);

    return res.json({
      success: true,
      snapshotDate,
      metricsAt,
      run: run
        ? {
            ok: run.ok !== false,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            durationMs: run.durationMs,
            salesWindowDays: run.salesWindowDays,
            error: run.error || null,
          }
        : null,
      // The hourly sync's last pass, for the "synced N min ago" note.
      sync,
      counts: {
        ...stripId(tiles),
        all: (totals && totals.all) || 0,
        archived: (totals && totals.archived) || 0,
        noImageArchived: (totals && totals.noImageArchived) || 0,
      },
      options: { categories, collections, vendors, qualities },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /stock-monitor/items ────────────────────────────────────────
router.get("/items", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const refresh = await latestRefresh(db);
    if (!refresh) return res.json({ success: true, snapshotDate: null, metricsAt: null, rows: [], total: 0 });
    const { snapshotDate, metricsAt } = refresh;

    const { match, filter } = buildMatch(req);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const sortField = SORTABLE.has(String(req.query.sort)) ? String(req.query.sort) : "units90";
    const order = String(req.query.order) === "asc" ? 1 : -1;

    const [stored, total] = await Promise.all([
      db
        .collection(ITEMS)
        .find(match, {
          projection: {
            _id: 0, itemId: 1, sku: 1, name: 1, location: 1, scope: 1, classification: 1,
            preferVendor: 1, brand: 1, category: 1, quality: 1, collections: 1, inCatalogue: 1,
            archived: 1, archivedReason: 1, purchasePrice: 1,
            pricePlatinum: 1, priceVip: 1, priceSvip: 1, priceWholesale: 1,
            priceMissing: 1, pricePlaceholder: 1, priceBelowCost: 1, priceOrderBroken: 1,
            priceRule: 1, priceExpected: 1, priceRuleBroken: 1, imageId: 1,
            subClassification: 1, deviceBrand: 1, deviceSeries: 1, compatibleModels: 1, reorderLevel: 1, showInStore: 1,
            // The numbers, merged into each row below.
            metrics: 1, metricsAt: 1,
          },
        })
        // _id breaks ties so paging can't repeat or skip a row when many
        // share a sort value — most of them have units90: 0. The merged
        // Missing Price view groups truly-missing rows above placeholder
        // ones before the user's sort applies.
        .sort(
          filter === "priceUnpriced"
            ? { priceMissing: -1, [fieldPath(sortField)]: order, _id: 1 }
            : { [fieldPath(sortField)]: order, _id: 1 },
        )
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection(ITEMS).countDocuments(match),
    ]);
    const rows = stored.map(flatten);

    // 海运 membership, joined live from the pinned collection doc rather
    // than the row's collections array — an item added today badges
    // (and can be toggled) immediately, not after the next refresh.
    try {
      const sea = await db
        .collection("productCollections")
        .findOne({ seaFreight: true }, { projection: { products: 1 } });
      if (sea && Array.isArray(sea.products) && sea.products.length) {
        const seaIds = new Set(sea.products.map((p) => String(p.itemId)));
        for (const r of rows) if (seaIds.has(String(r.itemId))) r.seaFreight = true;
      }
    } catch (e) {
      // The badge is decoration — never fail the list for it.
    }

    // The register stores only the image id; the page gets a usable URL.
    for (const r of rows) r.imageUrl = imageUrlFromId(r.imageId);

    return res.json({ success: true, snapshotDate, metricsAt, filter, page, pageSize, total, rows });
  } catch (error) {
    next(error);
  }
});

// ── GET /stock-monitor/collection-items?collection=<id>[,<id>] ──────
// The Stock Monitoring list: every register row tagged with the named
// collection(s). A comma-list is a branch (every collection under iPhone →
// Screen at once), and each row then says which of them it came from
// (memberOf) so the page's sub-category filter works. Rows carry the four
// sales windows split online / offline, the shelf, the image and the
// hidden / 海运 marks the page shows.
//
// Replaces GET /zoho/collectionStocks for spare parts (2026-09-22): that
// one asked Analytics for the members and Inventory for every row's stock
// on each click — a minute for a big branch. This answers from the register
// in milliseconds; the page then overlays live stock on the rows it shows
// through /live. Each collection's filter is run here, on every read, so
// a rule saved a second ago and an item the hourly sync inserted a minute
// ago both show at once. scope=accessories reads the accessories set.
const HIDDEN = "imb_stock_hidden";

// What the Stock Monitoring lists read of a register row.
const LIST_PROJECTION = {
  _id: 0, itemId: 1, sku: 1, name: 1, location: 1, imageId: 1, reorderLevel: 1,
  classification: 1, subClassification: 1, quality: 1,
  deviceBrand: 1, deviceSeries: 1, compatibleModels: 1, showInStore: 1, metrics: 1,
};
// Units sold in a window, and how many of those were online orders (the
// rest: counter, workshop, Neto, dispatch).
const salesWindow = (u) => ({ total: (u && u.total) || 0, online: (u && u.online) || 0 });
// A register row → the row the Stock Monitoring table renders.
function shapeListRow(r, { hidden, seaIds, memberOf }) {
  const m = r.metrics || {};
  const row = {
    id: r.itemId,
    itemId: r.itemId,
    sku: r.sku,
    productName: r.name,
    location: r.location || "",
    stock: m.available || 0,
    accountingStock: m.accountingStock || 0,
    stockOnHand: m.stockOnHand || 0,
    committed: m.committed || 0,
    reorderLevel: r.reorderLevel || 0,
    imageUrl: imageUrlFromId(r.imageId),
    classification: r.classification || "",
    subClassification: r.subClassification || "",
    quality: r.quality || "",
    deviceBrand: r.deviceBrand || "",
    deviceSeries: r.deviceSeries || "",
    compatibleModels: r.compatibleModels || [],
    showInStore: !!r.showInStore,
    sales: { 7: salesWindow(m.units7), 14: salesWindow(m.units14), 30: salesWindow(m.units30), 90: salesWindow(m.units90) },
  };
  if (memberOf) row.memberOf = memberOf.get(r.itemId) || [];
  if (hidden && hidden.has(r.itemId)) row.hidden = true;
  if (seaIds && seaIds.has(r.itemId)) row.seaFreight = true;
  return row;
}
const byName = (a, b) => a.productName.localeCompare(b.productName);

router.get("/collection-items", VIEW, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.query.collection) ? req.query.collection.join(",") : String(req.query.collection || "");
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length || ids.some((id) => !ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: "Invalid collection id" });
    }
    const accessories = String(req.query.scope || "") === "accessories";
    const store = accessories ? "accessoryCollections" : "productCollections";
    const scope = SCOPE_BY_STORE[store];

    const db = await connectToDatabase();
    const docs = await db
      .collection(store)
      .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { title: 1, filter: 1, products: 1 } })
      .toArray();
    if (!docs.length) return res.status(404).json({ success: false, message: "Collection not found" });
    const refresh = await latestRefresh(db);

    // Each collection's filter, run now. A branch unions them and notes
    // which collection(s) each item came from.
    const memberOf = new Map();
    for (const doc of docs) {
      const members = await db
        .collection(ITEMS)
        .find(collectionMatch(doc, scope), { projection: { _id: 0, itemId: 1 } })
        .toArray();
      for (const m of members) {
        if (!memberOf.has(m.itemId)) memberOf.set(m.itemId, []);
        memberOf.get(m.itemId).push(String(doc._id));
      }
    }
    const stored = await db
      .collection(ITEMS)
      .find({ itemId: { $in: [...memberOf.keys()] } }, { projection: LIST_PROJECTION })
      .toArray();

    const [hiddenDocs, sea] = await Promise.all([
      db.collection(HIDDEN).find({ itemId: { $in: stored.map((r) => r.itemId) } }, { projection: { itemId: 1 } }).toArray(),
      // 海运 membership badge — a parts concept.
      accessories ? null : db.collection("productCollections").findOne({ seaFreight: true }, { projection: { products: 1 } }),
    ]);
    const hidden = new Set(hiddenDocs.map((h) => String(h.itemId)));
    const seaIds = new Set(((sea && sea.products) || []).map((p) => String(p.itemId)));

    const rows = stored
      .map((r) => shapeListRow(r, { hidden, seaIds, memberOf: docs.length > 1 ? memberOf : null }))
      .sort(byName);

    return res.json({
      success: true,
      snapshotDate: refresh ? refresh.snapshotDate : null,
      metricsAt: refresh ? refresh.metricsAt : null,
      rows,
    });
  } catch (error) {
    next(error);
  }
});

// ── Browse: the catalogue as a tree of its own fields ────────────────
// Device Brand → Device Series → Classification → Sub Classification,
// counted from the register, so every active item has a place without a
// collection being written for it (2026-09-22; the Category tree of hand
// made collections stays beside it). An item has ONE brand; its series
// cell may hold several ("Nova Series; P Series") — it then counts under
// each series but once under the brand. Small makers sit under the brand
// "Other" with the maker as the series (Vivo, Nintendo …); OnePlus and
// Realme are series of OPPO (the user's rules, 2026-09-22).
//
// A node is a selection { brand, series, classification, sub }; a level
// left out means "all". NONE stands for a blank value at that level (a
// brand with no series, an unclassified part). TOOL is the "Tool" bucket:
// tools need no device, so brand-less Tools items get their own top-level
// node (straight to sub classification) instead of sitting in "No device".
const NONE = "__none__";
const TOOL = "__tool__";
const CLASS_ORDER = ["Screen", "Housing", "BackCover", "Battery", "Small Parts", "Tools", "Other", "Accessory"];
const nodeLabel = (v, blank) => (v ? v : blank);
const multiSplit = (field) => ({ $split: [{ $ifNull: [`$${field}`, ""] }, "; "] });
// the brand an item files under: its brand, or TOOL for a brand-less tool
const BRAND_EXPR = {
  $let: {
    vars: { b: { $ifNull: ["$deviceBrand", ""] } },
    in: { $cond: [{ $and: [{ $eq: ["$$b", ""] }, { $eq: ["$classification", "Tools"] }] }, TOOL, "$$b"] },
  },
};

function buildBrowseTree(groups) {
  // brand → series → classification → sub, each with a count
  const brands = new Map();
  for (const g of groups) {
    const { b, s, c, u } = g._id;
    const B = brands.get(b) || brands.set(b, { count: 0, series: new Map() }).get(b);
    B.count += g.n;
    const S = B.series.get(s) || B.series.set(s, { count: 0, classes: new Map() }).get(s);
    S.count += g.n;
    const C = S.classes.get(c) || S.classes.set(c, { count: 0, subs: new Map() }).get(c);
    C.count += g.n;
    if (u) C.subs.set(u, (C.subs.get(u) || 0) + g.n);
  }
  const classRank = (c) => { const i = CLASS_ORDER.indexOf(c); return i < 0 ? (c ? CLASS_ORDER.length : CLASS_ORDER.length + 1) : i; };
  const node = (label, count, sel, path, key) => ({ key, label, count, sel, path, browse: true, value: key, children: [] });
  const classNodes = (classes, sel, path, keyBase) =>
    [...classes.entries()]
      .sort((a, b) => classRank(a[0]) - classRank(b[0]) || a[0].localeCompare(b[0]))
      .map(([c, C]) => {
        const label = nodeLabel(c, "Unclassified");
        const n = node(label, C.count, { ...sel, classification: c || NONE }, [...path, label], `${keyBase}|c:${c || NONE}`);
        n.children = [...C.subs.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([u, cnt]) => node(u, cnt, { ...n.sel, sub: u }, [...n.path, u], `${n.key}|u:${u}`));
        return n;
      });
  // biggest brands first, then Other, Tool and the brand-less bucket
  const brandRank = (b) => (b === "" ? 3 : b === TOOL ? 2 : b === "Other" ? 1 : 0);
  const tree = [...brands.entries()]
    .sort((a, b) => brandRank(a[0]) - brandRank(b[0]) || b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([b, B]) => {
      const label = b === TOOL ? "Tool" : nodeLabel(b, "No device");
      const sel = { brand: b || NONE };
      const n = node(label, B.count, sel, [label], `b:${b || NONE}`);
      if (b === TOOL) {
        // Tools: straight to the sub classification (Hand Tools, Soldering …)
        const subs = new Map();
        for (const S of B.series.values()) for (const C of S.classes.values()) for (const [u, cnt] of C.subs) subs.set(u, (subs.get(u) || 0) + cnt);
        n.children = [...subs.entries()].sort((a, b2) => a[0].localeCompare(b2[0])).map(([u, cnt]) => node(u, cnt, { ...sel, sub: u }, [...n.path, u], `${n.key}|u:${u}`));
        return n;
      }
      const named = [...B.series.keys()].filter(Boolean);
      if (!named.length) {
        // No series for this brand (Nokia, HTC …): classifications directly.
        n.children = classNodes(B.series.get("").classes, sel, n.path, n.key);
        return n;
      }
      n.children = [...B.series.entries()]
        .sort((a, b2) => (a[0] === "" ? 1 : b2[0] === "" ? -1 : b2[1].count - a[1].count || a[0].localeCompare(b2[0])))
        .map(([s, S]) => {
          const sl = nodeLabel(s, "No series");
          const sn = node(sl, S.count, { ...sel, series: s || NONE }, [...n.path, sl], `${n.key}|s:${s || NONE}`);
          sn.children = classNodes(S.classes, sn.sel, sn.path, sn.key);
          return sn;
        });
      return n;
    });
  return tree;
}

router.get("/browse-tree", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const groups = await db
      .collection(ITEMS)
      .aggregate([
        { $match: { active: true, scope: scopeOf(req), archived: { $ne: true } } },
        {
          $project: {
            b: BRAND_EXPR,
            series: multiSplit("deviceSeries"),
            c: { $ifNull: ["$classification", ""] },
            u: { $ifNull: ["$subClassification", ""] },
          },
        },
        { $unwind: "$series" },
        { $group: { _id: { b: "$b", s: "$series", c: "$c", u: "$u" }, n: { $sum: 1 } } },
      ])
      .toArray();
    // An item with two series ("Nova Series; P Series") sits under both
    // series but is one item of its brand — count brands without the unwind.
    const brandTotals = await db
      .collection(ITEMS)
      .aggregate([
        { $match: { active: true, scope: scopeOf(req), archived: { $ne: true } } },
        { $group: { _id: BRAND_EXPR, n: { $sum: 1 } } },
      ])
      .toArray();
    const tree = buildBrowseTree(groups);
    const totalByBrand = new Map(brandTotals.map((b) => [b._id, b.n]));
    for (const n of tree) n.count = totalByBrand.get(n.sel.brand === NONE ? "" : n.sel.brand) || n.count;
    const refresh = await latestRefresh(db);
    return res.json({ success: true, metricsAt: refresh ? refresh.metricsAt : null, tree });
  } catch (error) {
    next(error);
  }
});

// The node's rows. Server-paged: the tile counts, the quality breakdown
// (for the Quality filter) and one page of rows come back from a single
// aggregation, under the same match, so tiles and table always agree.
//   brand / series / classification / sub   the node (NONE = blank at that level, brand TOOL = the Tool bucket)
//   quality, seriesIn[], models[], search   the filters above the table (series / model picks: any of them)
//   tile                                    zero | noOnOrder | onOrder | underMonth
//   hidden=1                                the hidden-items review instead
//   days                                    the sales window (7/14/30/90) — Under a Month uses it
//   sort=name|sku|stock|sales, order, page, pageSize; all=1 returns every row (export, capped)
const BROWSE_DAYS = new Set([7, 14, 30, 90]);
const EXPORT_CAP = 5000;
// a series cell can hold several values: match one of them
const oneOf = (field, v) =>
  v === NONE ? { [field]: { $in: ["", null] } } : { [field]: new RegExp(`(^|; )${escapeRegex(v)}(;|$)`) };
const oneOfAny = (field, list) => ({ [field]: new RegExp(`(^|; )(${list.map(escapeRegex).join("|")})(;|$)`) });
// a repeatable query param (models[]=a&models[]=b, or a single value)
const listParam = (v) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean));
// The picked tree node.
function nodeMatch(q) {
  const m = {};
  if (q.brand === TOOL) { m.deviceBrand = { $in: ["", null] }; m.classification = "Tools"; }
  else if (q.brand === NONE) { m.deviceBrand = { $in: ["", null] }; m.classification = { $ne: "Tools" }; }
  else if (q.brand !== undefined) m.deviceBrand = String(q.brand);
  if (q.series !== undefined) Object.assign(m, oneOf("deviceSeries", String(q.series)));
  if (q.classification !== undefined) m.classification = q.classification === NONE ? { $in: ["", null] } : String(q.classification);
  if (q.sub !== undefined) m.subClassification = String(q.sub);
  return m;
}
// The filters above the table: quality, the series / model picks (one
// cascader — a whole series or single models, any of them matches) and
// the search box. Kept apart from the node so the filter options can be
// counted over the whole node while the list is narrowed.
function filterMatch(q) {
  const m = {};
  if (q.quality) m.quality = q.quality === NONE ? { $in: ["", null] } : new RegExp(`^${escapeRegex(q.quality)}$`, "i");
  const ands = [];
  const seriesIn = listParam(q.seriesIn), models = listParam(q.models);
  if (seriesIn.length || models.length) {
    const or = [];
    const named = seriesIn.filter((s) => s !== NONE);
    if (named.length) or.push(oneOfAny("deviceSeries", named));
    if (seriesIn.includes(NONE)) or.push({ deviceSeries: { $in: ["", null] } });
    if (models.length) or.push({ compatibleModels: { $in: models } });
    ands.push({ $or: or });
  }
  const search = String(q.search || "").trim();
  if (search) { const re = new RegExp(escapeRegex(search), "i"); ands.push({ $or: [{ sku: re }, { name: re }] }); }
  if (ands.length) m.$and = ands;
  return m;
}
const browseMatch = (q) => ({ ...nodeMatch(q), ...filterMatch(q) });
// Series → compatible models for the cascader filter, counted over the
// node. A model is filed under ONE series: the one its name carries
// ("Huawei Nova 3e" → Nova, "Galaxy Tab S7" → Tab over S), else the series
// most of its items have, else the bigger series. A "Nova 3e / P20 Lite"
// part lists both models under both series — the name rule keeps each
// where it belongs. Brands without series get a flat model list.
function buildSeriesModels(pairs, modelCounts) {
  const counts = new Map(modelCounts.map((x) => [x._id, x.n]));
  const seriesSize = new Map();
  const perModel = new Map(); // model → Map(series → items)
  for (const g of pairs) {
    const { s, m } = g._id;
    seriesSize.set(s, (seriesSize.get(s) || 0) + g.n);
    const bag = perModel.get(m) || perModel.set(m, new Map()).get(m);
    bag.set(s, (bag.get(s) || 0) + g.n);
  }
  // how much of the series name the model name carries (0 = none):
  // a one-letter series wants its letter before a digit (P20, A52, S21)
  const stemLen = (m, s) => {
    const stem = s.replace(/ Series$/, "");
    if (!stem) return 0;
    const re = stem.length === 1 ? new RegExp(`\\b${escapeRegex(stem)}\\d`) : new RegExp(`\\b${escapeRegex(stem)}\\b`, "i");
    return re.test(m) ? stem.length : 0;
  };
  const bySeries = new Map();
  for (const [m, bag] of perModel) {
    const s = [...bag.keys()].sort((a, b) =>
      stemLen(m, b) - stemLen(m, a) || bag.get(b) - bag.get(a) || seriesSize.get(b) - seriesSize.get(a) || a.localeCompare(b))[0];
    const list = bySeries.get(s) || bySeries.set(s, []).get(s);
    const n = counts.get(m) || bag.get(s);
    list.push({ value: m, label: `${m} (${n})`, count: n });
  }
  const natural = (a, b) => a.value.localeCompare(b.value, undefined, { numeric: true });
  const series = [...bySeries.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  if (series.length === 1 && series[0][0] === "") return series[0][1].sort(natural);
  return series.map(([s, models]) => {
    const n = models.reduce((t, x) => t + x.count, 0);
    return { value: s || NONE, label: `${s || "No series"} (${n})`, count: n, children: models.sort(natural) };
  });
}
const tileMatch = (tile, days) => {
  const units = `$metrics.units${days}.total`;
  switch (tile) {
    case "zero": return { "metrics.available": { $lte: 0 } };
    case "onOrder": return { "metrics.openPoQty": { $gt: 0 } };
    case "noOnOrder": return { "metrics.available": { $lte: 0 }, "metrics.openPoQty": { $not: { $gt: 0 } } };
    case "underMonth": return { $expr: { $and: [{ $gt: [{ $ifNull: [units, 0] }, 0] }, { $lt: [{ $ifNull: ["$metrics.available", 0] }, { $multiply: [{ $ifNull: [units, 0] }, 30 / days] }] }] } };
    default: return {};
  }
};

router.get("/browse-items", VIEW, async (req, res, next) => {
  try {
    const q = req.query || {};
    const scope = scopeOf(req);
    const days = BROWSE_DAYS.has(Number(q.days)) ? Number(q.days) : 30;
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const wantAll = String(q.all || "") === "1";
    const SORTS = { name: "name", sku: "sku", stock: "metrics.available", sales: `metrics.units${days}.total` };
    const sortField = SORTS[String(q.sort)] || "name";
    const order = String(q.order) === "desc" ? -1 : 1;
    const sort = { [sortField]: order, itemId: 1 };

    const db = await connectToDatabase();
    const refresh = await latestRefresh(db);
    const hiddenIds = (await db.collection(HIDDEN).find({}, { projection: { itemId: 1 } }).toArray()).map((h) => String(h.itemId));
    const showHidden = String(q.hidden || "") === "1";
    const filters = filterMatch(q);
    const node = { active: true, scope, archived: { $ne: true }, ...nodeMatch(q) };
    // Hidden items are out of the list and its counts — or ARE the list.
    const nodeBase = { ...node, itemId: showHidden ? { $in: hiddenIds } : { $nin: hiddenIds } };
    const base = { ...nodeBase, ...filters };
    const tile = tileMatch(String(q.tile || ""), days);
    const sea = await db.collection("productCollections").findOne({ seaFreight: true }, { projection: { products: 1 } });
    const seaIds = new Set(((sea && sea.products) || []).map((p) => String(p.itemId)));
    const shape = (r) => shapeListRow(r, { hidden: showHidden ? new Set([r.itemId]) : null, seaIds, memberOf: null });

    if (wantAll) {
      const rows = await db.collection(ITEMS).find({ ...base, ...tile }, { projection: LIST_PROJECTION }).sort(sort).limit(EXPORT_CAP).toArray();
      return res.json({ success: true, total: rows.length, capped: rows.length === EXPORT_CAP, rows: rows.map(shape) });
    }

    const units = { $ifNull: [`$metrics.units${days}.total`, 0] };
    const avail = { $ifNull: ["$metrics.available", 0] };
    const onOrder = { $gt: [{ $ifNull: ["$metrics.openPoQty", 0] }, 0] };
    const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
    // One pass over the node: the filter options (quality, series → model)
    // are counted over the whole node; tiles, total and rows apply the
    // filters — so picking a model never empties the other choices.
    const [out] = await db
      .collection(ITEMS)
      .aggregate([
        { $match: nodeBase },
        {
          $facet: {
            tiles: [
              { $match: filters },
              {
                $group: {
                  _id: null,
                  all: { $sum: 1 },
                  zero: count({ $lte: [avail, 0] }),
                  onOrder: count(onOrder),
                  noOnOrder: count({ $and: [{ $lte: [avail, 0] }, { $not: [onOrder] }] }),
                  underMonth: count({ $and: [{ $gt: [units, 0] }, { $lt: [avail, { $multiply: [units, 30 / days] }] }] }),
                },
              },
            ],
            qualities: [{ $group: { _id: { $ifNull: ["$quality", ""] }, n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }],
            seriesModels: [
              { $project: { series: multiSplit("deviceSeries"), models: { $ifNull: ["$compatibleModels", []] } } },
              { $unwind: "$models" },
              { $unwind: "$series" },
              { $group: { _id: { s: "$series", m: "$models" }, n: { $sum: 1 } } },
            ],
            modelCounts: [{ $unwind: "$compatibleModels" }, { $group: { _id: "$compatibleModels", n: { $sum: 1 } } }],
            total: [{ $match: filters }, { $match: tile }, { $count: "n" }],
            rows: [{ $match: filters }, { $match: tile }, { $sort: sort }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: LIST_PROJECTION }],
          },
        },
      ])
      .toArray();
    const t = (out.tiles && out.tiles[0]) || { all: 0, zero: 0, onOrder: 0, noOnOrder: 0, underMonth: 0 };
    delete t._id;
    // How many of this node's items are hidden — the "N hidden — view" link.
    const hiddenCount = showHidden ? t.all : hiddenIds.length ? await db.collection(ITEMS).countDocuments({ ...node, ...filters, itemId: { $in: hiddenIds } }) : 0;
    return res.json({
      success: true,
      snapshotDate: refresh ? refresh.snapshotDate : null,
      metricsAt: refresh ? refresh.metricsAt : null,
      days,
      tiles: t,
      hiddenCount,
      qualities: (out.qualities || []).map((x) => ({ value: x._id, count: x.n })),
      seriesModels: buildSeriesModels(out.seriesModels || [], out.modelCounts || []),
      total: (out.total && out.total[0] && out.total[0].n) || 0,
      page,
      pageSize,
      rows: (out.rows || []).map(shape),
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /stock-monitor/shelves ──────────────────────────────────────
// A stock take walks the racks, so the shelf is the unit of work.
router.get("/shelves", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const snapshotDate = await latestSnapshotDate(db);
    if (!snapshotDate) return res.json({ success: true, snapshotDate: null, shelves: [] });

    const shelves = await db
      .collection(ITEMS)
      .aggregate([
        { $match: { active: true, scope: scopeOf(req), location: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$location",
            items: { $sum: 1 },
            units: { $sum: { $cond: [{ $gt: ["$metrics.available", 0] }, "$metrics.available", 0] } },
            outOfStock: { $sum: { $cond: ["$metrics.outOfStock", 1, 0] } },
            negative: { $sum: { $cond: [{ $lt: ["$metrics.available", 0] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    return res.json({
      success: true,
      snapshotDate,
      shelves: shelves.map((s) => ({
        location: s._id,
        items: s.items,
        units: s.units,
        outOfStock: s.outOfStock,
        negative: s.negative,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /stock-monitor/item/:itemId ─────────────────────────────────
// The drawer: the item's row from the register. Purchase orders and the
// sales trend come live from Zoho through their own endpoints, so this one
// answers from Mongo alone and the drawer paints at once.
router.get("/item/:itemId", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const refresh = await latestRefresh(db);
    if (!refresh) return res.status(404).json({ success: false, message: "No stock refresh yet" });
    const { snapshotDate, metricsAt } = refresh;

    const stored = await db
      .collection(ITEMS)
      .findOne({ itemId: String(req.params.itemId), active: true }, { projection: { _id: 0 } });
    if (!stored) {
      return res.status(404).json({ success: false, message: "Item not in the stock register" });
    }
    const item = flatten(stored);

    // Purchase orders are NOT returned here: they come from Zoho Inventory
    // via /item/:id/purchase-orders, which is a live read. Keeping them out
    // of this endpoint is what lets the drawer paint immediately.
    return res.json({ success: true, snapshotDate, metricsAt, item });
  } catch (error) {
    next(error);
  }
});

// ── GET /stock-monitor/item/:itemId/sales ───────────────────────────
// Who actually bought this part, and for how much.
//
// Two reads, joined on the invoice id:
//   · Zoho Inventory lists the invoices carrying this item — date, invoice
//     number, customer, status. One call, newest first.
//   · Zoho Analytics has the LINE for this item on each of those invoices,
//     which is where quantity and unit price live. The invoices endpoint
//     only gives the whole-invoice total, which for a seven-line invoice
//     says nothing about our part.
//
// Counter usage (inventory adjustments) is deliberately not merged in: it
// has no customer or invoice, and mixing it into a customer list would
// invent buyers. The item's per-scope units (inflow / repair / neto /
// dashboard) cover it.
const SALES_VIEW_ID = "1404913000003936103";
const ANALYTICS_WORKSPACE_ID = "1404913000003936002";
const ZOHO_ORG_ID = "746138234";
const MAX_SALES_ROWS = 50;

router.get("/item/:itemId/sales", VIEW, async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  const limit = Math.min(MAX_SALES_ROWS, Math.max(1, parseInt(req.query.limit, 10) || 25));

  try {
    const invoiceList = await handleZohoInventoryRequest(
      `https://www.zohoapis.com/inventory/v1/invoices` +
        `?item_id=${encodeURIComponent(itemId)}&organization_id=${ZOHO_ORG_ID}` +
        `&per_page=${limit}&sort_column=date&sort_order=D`,
    );
    const invoices = (invoiceList && Array.isArray(invoiceList.invoices) ? invoiceList.invoices : [])
      .filter((i) => i && i.invoice_id);

    if (!invoices.length) {
      return res.json({ success: true, sales: [], truncated: false });
    }

    // The per-item line for exactly these invoices. Quoting is ours, and
    // the ids are Zoho's own numeric strings, but escape anyway.
    const inClause = invoices
      .map((i) => `'${String(i.invoice_id).replace(/'/g, "''")}'`)
      .join(",");
    const rows = await getViewData(
      `https://analyticsapi.zoho.com/restapi/v2/workspaces/${ANALYTICS_WORKSPACE_ID}` +
        `/views/${SALES_VIEW_ID}/data?CONFIG=` +
        encodeURIComponent(
          JSON.stringify({
            responseFormat: "json",
            selectedColumns: ["Invoice ID", "Quantity", "Item Price", "Total (BCY)", "Created Time"],
            criteria: `("Product ID" = '${itemId}') AND ("Invoice ID" IN (${inClause}))`,
          }),
        ),
    );

    // An Analytics hiccup costs the quantity column, not the whole panel —
    // the invoice list on its own is still worth showing.
    const lineByInvoice = new Map();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const key = String(r["Invoice ID"]);
        const prev = lineByInvoice.get(key) || { quantity: 0, total: 0, price: null };
        // One item can appear on several lines of the same invoice.
        prev.quantity += Number(r.Quantity) || 0;
        prev.total += Number(r["Total (BCY)"]) || 0;
        if (prev.price == null) prev.price = r["Item Price"] || null;
        lineByInvoice.set(key, prev);
      }
    }

    const sales = invoices.map((inv) => {
      const line = lineByInvoice.get(String(inv.invoice_id)) || {};
      return {
        date: inv.date || null,
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number || "",
        customerName: inv.customer_name || "",
        status: inv.status || "",
        quantity: line.quantity == null ? null : Math.round(line.quantity * 100) / 100,
        // Unit price as Zoho formats it ("AUD 19.00"); the line total is
        // ours to sum.
        price: line.price || null,
        lineTotal: line.total == null ? null : Math.round(line.total * 100) / 100,
        invoiceTotal: inv.total == null ? null : Number(inv.total),
      };
    });

    const page = invoiceList.page_context || {};
    return res.json({
      success: true,
      sales,
      // Say when there is more rather than implying this is the lot.
      truncated: page.has_more_page === true,
      lineDetailAvailable: Array.isArray(rows),
    });
  } catch (error) {
    console.error("Stock monitor sales history error:", error && error.message);
    return res.status(502).json({
      success: false,
      message: "Could not read the sales history from Zoho",
    });
  }
});

// ── POST /stock-monitor/item/:itemId/archived ────────────────────────
// Move an item to the Archive bucket by hand (mode "archived"), or restore
// it with { restore: true } — restoring writes a "keep" pin when the name
// criteria would re-catch it, so the item stays live on future runs.
// The row is flipped immediately so the pages update now.
const EDIT = requirePermission("zoho:stock:edit");
const { isNoiseName, ARCHIVE_COLLECTION } = require("../../utils/stockUniverse");

router.post("/item/:itemId/archived", EDIT, async (req, res, next) => {
  try {
    const itemId = String(req.params.itemId || "").trim();
    if (!/^[0-9]{6,25}$/.test(itemId)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    const restore = req.body && req.body.restore === true;
    const db = await connectToDatabase();
    const row = await db.collection(ITEMS).findOne({ itemId }, { projection: { sku: 1, name: 1 } });

    const now = new Date();
    const by = (req.user && req.user.username) || null;
    if (restore) {
      // Out of the bucket. A name the criteria would re-catch gets a
      // "keep" pin; otherwise the manual mark is simply removed.
      if (row && isNoiseName(row.name)) {
        await db.collection(ARCHIVE_COLLECTION).updateOne(
          { itemId },
          { $set: { itemId, sku: (row && row.sku) || "", name: (row && row.name) || "", mode: "keep", by, at: now } },
          { upsert: true },
        );
      } else {
        await db.collection(ARCHIVE_COLLECTION).deleteOne({ itemId });
      }
    } else {
      await db.collection(ARCHIVE_COLLECTION).updateOne(
        { itemId },
        { $set: { itemId, sku: (row && row.sku) || "", name: (row && row.name) || "", mode: "archive", by, at: now } },
        { upsert: true },
      );
    }
    // Flip the row so the change shows without waiting for the next refresh.
    await db.collection(ITEMS).updateOne(
      { itemId },
      { $set: { archived: !restore, archivedReason: restore ? null : "manual" } },
    );
    return res.json({ success: true, itemId, archived: !restore });
  } catch (error) {
    next(error);
  }
});

// One item's itemdetails record, or null when Zoho says it no longer
// exists (code 2006 — deleted since the last refresh).
async function readItemDetail(itemId) {
  try {
    const [item] = await fetchItemDetails([itemId]);
    return item && String(item.item_id) === itemId ? item : null;
  } catch (e) {
    if (/Resource does not exist|"code":2006/.test(String(e && e.message))) return null;
    throw e;
  }
}
const GONE = { success: false, message: "This item no longer exists in Zoho" };

// ── POST /stock-monitor/item/:itemId/image/recheck ──────────────────
// The Missing Images page's per-row re-check: one Zoho read of the item,
// its main image id mirrored into the register so a fixed item leaves
// the "no image" list now instead of after tonight's run. Same itemdetails
// endpoint as the nightly job — GET /items/{id} has no image_document_id,
// and reading it as "no image" would wrongly put items back on the list.
router.post("/item/:itemId/image/recheck", VIEW, async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  try {
    const item = await readItemDetail(itemId);
    if (!item) return res.status(404).json(GONE);
    const imageId = imageIdOf(item);
    const db = await connectToDatabase();
    await db.collection(ITEMS).updateOne({ itemId }, { $set: { imageId } });
    return res.json({ success: true, itemId, imageId, imageUrl: imageUrlFromId(imageId) });
  } catch (error) {
    console.error("Image re-check error:", error.message);
    return res.status(502).json({ success: false, message: "Could not read the item from Zoho" });
  }
});

// ── POST /stock-monitor/item/:itemId/images ─────────────────────────
// Upload product images to the item in Zoho Inventory (Missing Images
// page). multipart/form-data, one or more files under "images"; the first
// file becomes the main image when the item has none yet. Zoho's limits:
// gif/png/jpeg/bmp/webp, 7 MB each. Three Zoho calls: read the item, the
// upload, read it back — the new main image id is mirrored into today's
// register so the page (and the no-image counts) update at once.
const multer = require("multer");
const FormData = require("form-data");
const IMAGE_MIME = /^image\/(gif|png|jpe?g|bmp|webp)$/i;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_IMAGES = 10;
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
  fileFilter: (req, file, cb) =>
    IMAGE_MIME.test(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error(`${file.originalname}: only gif, png, jpeg, bmp or webp images`), { badType: true })),
}).array("images", MAX_IMAGES);

function uploadErrorMessage(err) {
  if (err.badType) return err.message;
  if (err.code === "LIMIT_FILE_SIZE") return "Each image must be 7 MB or smaller";
  if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
    return `Up to ${MAX_IMAGES} images at a time`;
  }
  return "Could not read the uploaded images";
}

router.post(
  "/item/:itemId/images",
  EDIT,
  (req, res, next) =>
    imageUpload(req, res, (err) =>
      err ? res.status(400).json({ success: false, message: uploadErrorMessage(err) }) : next(),
    ),
  async (req, res) => {
    const itemId = String(req.params.itemId || "").trim();
    if (!/^[0-9]{6,25}$/.test(itemId)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ success: false, message: "No images attached" });
    }
    try {
      // Only claim the main image when the item has none — uploading more
      // pictures to an item that has one must not replace it.
      const before = await readItemDetail(itemId);
      if (!before) return res.status(404).json(GONE);
      const url =
        `https://www.zohoapis.com/inventory/v1/items/${encodeURIComponent(itemId)}/images` +
        `?organization_id=${ZOHO_ORG_ID}` +
        (imageIdOf(before) ? "" : "&update_primary_image=true");
      // A builder, not a form: a retry after a token refresh needs a fresh stream.
      const buildForm = () => {
        const form = new FormData();
        for (const f of files) {
          form.append("image", f.buffer, { filename: f.originalname || "image.jpg", contentType: f.mimetype });
        }
        return form;
      };
      const resp = await handleZohoInventoryMultipartPostRequest(url, buildForm);
      if (!resp || resp.code !== 0) {
        return res.status(502).json({
          success: false,
          message: `Zoho did not accept the images${resp && resp.message ? `: ${resp.message}` : ""}`,
        });
      }

      const after = await readItemDetail(itemId);
      const imageId = imageIdOf(after);
      const db = await connectToDatabase();
      await db.collection(ITEMS).updateOne({ itemId }, { $set: { imageId } });
      return res.json({
        success: true,
        itemId,
        uploaded: files.length,
        imageId,
        imageUrl: imageUrlFromId(imageId),
      });
    } catch (error) {
      console.error("Image upload error:", error.message);
      return res.status(502).json({ success: false, message: "Could not upload the images to Zoho" });
    }
  },
);

// ── GET /stock-monitor/live?ids=a,b,c ───────────────────────────────
// Live stock for the rows on screen, straight from Zoho Inventory — one
// itemdetails call per 100 ids. The pages overlay it on the stored numbers
// so what is read is current, while lists, tiles and sorts still come from
// the register. `available` is the physical for-sale figure (shipments);
// `accountingStock` the invoice-driven one the Accessories page shows
// beside it.
const MAX_LIVE_IDS = 200;
router.get("/live", VIEW, async (req, res) => {
  const ids = [
    ...new Set(
      String(req.query.ids || "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => /^[0-9]{6,25}$/.test(v)),
    ),
  ].slice(0, MAX_LIVE_IDS);
  if (!ids.length) return res.json({ success: true, at: new Date(), stock: {} });
  try {
    const details = await fetchItemDetails(ids);
    const stock = {};
    for (const d of details) {
      stock[String(d.item_id)] = {
        available: Number(d.actual_available_for_sale_stock) || 0,
        accountingStock: Number(d.available_for_sale_stock) || 0,
        stockOnHand: Number(d.stock_on_hand) || 0,
        committed: Number(d.actual_committed_stock) || 0,
      };
    }
    return res.json({ success: true, at: new Date(), stock });
  } catch (error) {
    console.error("Live stock read error:", error.message);
    return res.status(502).json({ success: false, message: "Could not read live stock from Zoho" });
  }
});

// ── GET /stock-monitor/item/:itemId/sales-trend?weeks=12 ────────────
// Units sold per week for one item, live from Zoho Analytics — the drawer's
// trend, in place of the stock-by-day history the daily snapshot used to
// hold (Zoho has no past-date stock, but it has every sale). Online orders
// plus offline-sale adjustments, in whole weeks counted back from now,
// oldest first.
router.get("/item/:itemId/sales-trend", VIEW, async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  const weeks = Math.min(52, Math.max(4, parseInt(req.query.weeks, 10) || 12));
  const WEEK = 7 * 86400000;
  try {
    const { salesRows, adjustmentRows, reasonByAdjustment } = await fetchItemWindowRows(itemId, weeks * 7);
    const now = Date.now();
    const buckets = Array.from({ length: weeks }, (_, i) => ({
      from: new Date(now - (weeks - i) * WEEK),
      to: new Date(now - (weeks - i - 1) * WEEK),
      units: 0,
      online: 0,
      offline: 0,
      scopes: {},
    }));
    // Analytics stamps are "2026-08-28 12:32:14"; read as plain timestamps.
    const add = (when, qty, scope) => {
      const d = new Date(String(when || "").replace(" ", "T"));
      if (Number.isNaN(d.getTime()) || !qty) return;
      const idx = weeks - 1 - Math.floor((now - d.getTime()) / WEEK);
      if (idx < 0 || idx >= weeks) return;
      const b = buckets[idx];
      b.units += qty;
      if (scope === "online") b.online += qty;
      else {
        b.offline += qty;
        b.scopes[scope] = (b.scopes[scope] || 0) + qty;
      }
    };
    for (const r of salesRows) add(r["Created Time"], Number(r["Quantity"]) || 0, "online");
    for (const r of adjustmentRows) {
      const scope = OFFLINE_SALE_SCOPES[reasonByAdjustment.get(r["Inventory Adjustment ID"])];
      if (!scope) continue;
      // Stock leaving is a negative adjustment; flip it so sales read positive.
      add(r["Created Time"], (Number(r["Quantity Adjusted"]) || 0) * -1, scope);
    }
    const round = (n) => Math.round(n * 100) / 100;
    return res.json({
      success: true,
      weeks,
      trend: buckets.map((b) => ({
        from: b.from,
        to: b.to,
        units: round(b.units),
        online: round(b.online),
        offline: round(b.offline),
        // The offline part by scope (inflow / repair / neto / dashboard).
        scopes: Object.fromEntries(Object.entries(b.scopes).map(([k, v]) => [k, round(v)])),
      })),
    });
  } catch (error) {
    console.error("Sales trend error:", error.message);
    return res.status(502).json({ success: false, message: "Could not read the sales trend from Zoho" });
  }
});

// ── GET /stock-monitor/item/:itemId/prices ──────────────────────────
// The four price-list rates for one item, read live from the Analytics
// prices view — the Price Monitoring page's "check live" button. One call;
// fresher than the nightly refresh (Analytics itself syncs from Inventory
// within a few hours of a price push).
const PRICES_VIEW_ID = "1404913000003936194";
const PRICE_LISTS = {
  platinum: "2591985000001439015",
  vip: "2591985000000103001",
  svip: "2591985000078196985",
  wholesale: "2591985000000103011",
};

router.get("/item/:itemId/prices", VIEW, async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  try {
    const rows = await getViewData(
      `https://analyticsapi.zoho.com/restapi/v2/workspaces/${ANALYTICS_WORKSPACE_ID}` +
        `/views/${PRICES_VIEW_ID}/data?CONFIG=` +
        encodeURIComponent(
          JSON.stringify({
            responseFormat: "json",
            selectedColumns: ["PriceList ID", "Product ID", "PriceList Rate"],
            criteria: `"Product ID" = '${itemId}'`,
          }),
        ),
    );
    if (!Array.isArray(rows)) {
      throw new Error("prices view returned " + JSON.stringify(rows).slice(0, 120));
    }
    const money = (raw) => {
      const n = parseFloat(String(raw == null ? "" : raw).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const byList = new Map(rows.map((r) => [String(r["PriceList ID"]), r["PriceList Rate"]]));
    const prices = {};
    for (const [key, listId] of Object.entries(PRICE_LISTS)) {
      prices[key] = byList.has(listId) ? money(byList.get(listId)) : null;
    }
    return res.json({ success: true, prices });
  } catch (error) {
    console.error("Stock monitor live prices error:", error && error.message);
    return res.status(502).json({
      success: false,
      message: "Could not read the price lists from Zoho",
    });
  }
});

// ── PUT /stock-monitor/item/:itemId/price ───────────────────────────
// Push one price-list rate to Zoho Inventory — via the MERGE endpoint
// (PUT /pricebooks/{id}/items with an items array), which updates only the
// named item and never touches the rest of the book. The whole-book PUT
// REPLACES the book and must never be used here.
// On success the rate is mirrored into the register row and the row's
// price-health flags recomputed, so the page reflects the push immediately
// (Zoho Analytics — the refresh's source — lags a price push by hours).
const PRICE_FIELDS = {
  platinum: "pricePlatinum",
  vip: "priceVip",
  svip: "priceSvip",
  wholesale: "priceWholesale",
};
const PRICE_PLACEHOLDERS = new Set([9999.99, 9000, 8888, 7777, 7000, 6000]);
const { evaluatePriceRule } = require("../../utils/priceRules");

// Same rule as the refresh job: SVIP ≤ VIP, WholeSale ≤ VIP, VIP ≤
// Platinum (SVIP vs WholeSale deliberately unordered), placeholders and
// missing rates skipped.
function priceHealthFlags(row) {
  const real = (v) => (v != null && !PRICE_PLACEHOLDERS.has(v) ? v : null);
  const rates = [row.priceWholesale, row.priceSvip, row.priceVip, row.pricePlatinum];
  const realRates = rates.filter((v) => v != null && !PRICE_PLACEHOLDERS.has(v));
  const s = real(row.priceSvip);
  const w = real(row.priceWholesale);
  const v = real(row.priceVip);
  const p = real(row.pricePlatinum);
  const lte = (a, b) => a == null || b == null || a <= b + 1e-9;
  return {
    priceMissing: rates.some((x) => x == null),
    pricePlaceholder: rates.some((x) => x != null && PRICE_PLACEHOLDERS.has(x)),
    priceBelowCost: row.purchasePrice > 0 && realRates.some((x) => x < row.purchasePrice),
    priceOrderBroken: !(lte(s, v) && lte(w, v) && lte(v, p) && lte(s, p) && lte(w, p)),
  };
}

// Per-product lock for the register mirror below. Pushes for the same
// product go to Zoho in parallel (that call is the slow part); only the
// quick read → recompute flags → write runs one at a time, or two pushes
// would each compute flags without the other's new rate. In-process, so it
// assumes a single backend instance.
const mirrorLocks = new Map();
// Increases with every mirror write, so the page can tell which of several
// in-flight responses carries the newest flags (they can arrive out of order).
let mirrorSeq = 0;
function withItemLock(itemId, fn) {
  const prev = mirrorLocks.get(itemId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  mirrorLocks.set(itemId, tail);
  tail.then(() => { if (mirrorLocks.get(itemId) === tail) mirrorLocks.delete(itemId); });
  return run;
}

router.put("/item/:itemId/price", requirePermission("zoho:stock:edit"), async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  const list = String((req.body && req.body.list) || "").toLowerCase();
  const field = PRICE_FIELDS[list];
  if (!field) {
    return res.status(400).json({ success: false, message: "Unknown price list" });
  }
  const rate = Number(req.body && req.body.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000000) {
    return res.status(400).json({ success: false, message: "Rate must be 0 or a positive number" });
  }
  const rounded = Math.round(rate * 100) / 100;

  try {
    // Pre-warm the token: a write should not burn its first attempt on
    // discovering an expired one.
    await refreshToken();
    const resp = await handleZohoInventoryPutRequest(
      `https://www.zohoapis.com/inventory/v1/pricebooks/${PRICE_LISTS[list]}/items` +
        `?organization_id=${ZOHO_ORG_ID}`,
      [{ item_id: itemId, pricebook_rate: rounded }],
    );
    if (!resp || resp.code !== 0) {
      return res
        .status(502)
        .json({ success: false, message: (resp && resp.message) || "Zoho rejected the price update" });
    }

    // Mirror into the register and recompute this row's flags.
    const db = await connectToDatabase();
    const mirrored = await withItemLock(itemId, async () => {
      const row = await db.collection(ITEMS).findOne(
        { itemId },
        {
          projection: {
            pricePlatinum: 1, priceVip: 1, priceSvip: 1, priceWholesale: 1, purchasePrice: 1,
            name: 1, category: 1, classification: 1, quality: 1,
          },
        },
      );
      if (!row) return null;
      row[field] = rounded;
      const next = {
        ...priceHealthFlags(row),
        // The formula verdict moves with the new rate too.
        priceRuleBroken: evaluatePriceRule(row).broken,
      };
      await db.collection(ITEMS).updateOne({ itemId }, { $set: { [field]: rounded, ...next } });
      return { flags: next, seq: ++mirrorSeq };
    });
    return res.json({
      success: true, list, rate: rounded,
      flags: mirrored ? mirrored.flags : null,
      flagsSeq: mirrored ? mirrored.seq : null,
    });
  } catch (error) {
    console.error("Stock monitor price push error:", error && error.message);
    return res.status(502).json({ success: false, message: "Failed to push the price to Zoho" });
  }
});

// ── PUT /stock-monitor/prices/bulk ──────────────────────────────────
// Many price changes in one go. Zoho turns requests away once about five
// pricebook writes are in flight, so the page queues its edits and sends
// them here together; this handler talks to Zoho ONE call at a time: the
// changes are grouped by price list (one pricebook each) and written in
// chunks with the pricebook items endpoint, which takes an array. A chunk
// Zoho refuses is retried item by item so one bad rate does not sink the
// rest. Each accepted rate is mirrored into the register exactly like the
// single-item route above.
//   body  { changes: [{ itemId, list, rate }] }   (max 500; last wins per item+list)
//   reply { results: [{ itemId, list, rate, ok, message, flags, flagsSeq }] }
const BULK_PRICE_CHUNK = 25;
router.put("/prices/bulk", requirePermission("zoho:stock:edit"), async (req, res) => {
  const raw = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
  if (!raw.length) return res.status(400).json({ success: false, message: "No changes" });
  if (raw.length > 500) return res.status(400).json({ success: false, message: "Too many changes (max 500)" });

  // Validate; the last entry for an item + list wins.
  const byKey = new Map();
  for (const c of raw) {
    const itemId = String((c && c.itemId) || "").trim();
    const list = String((c && c.list) || "").toLowerCase();
    const rate = Number(c && c.rate);
    if (!/^[0-9]{6,25}$/.test(itemId) || !PRICE_FIELDS[list] || !Number.isFinite(rate) || rate < 0 || rate > 1000000) {
      return res.status(400).json({ success: false, message: `Bad change for item ${itemId || "?"} / ${list || "?"}` });
    }
    byKey.set(`${itemId}|${list}`, { itemId, list, rate: Math.round(rate * 100) / 100 });
  }
  const changes = [...byKey.values()];

  const db = await connectToDatabase();
  // Mirror one accepted rate into the register (flags recomputed), same as
  // the single-item route.
  const mirror = async ({ itemId, list, rate }) =>
    withItemLock(itemId, async () => {
      const field = PRICE_FIELDS[list];
      const row = await db.collection(ITEMS).findOne(
        { itemId },
        { projection: { pricePlatinum: 1, priceVip: 1, priceSvip: 1, priceWholesale: 1, purchasePrice: 1, name: 1, category: 1, classification: 1, quality: 1 } },
      );
      if (!row) return null;
      row[field] = rate;
      const next = { ...priceHealthFlags(row), priceRuleBroken: evaluatePriceRule(row).broken };
      await db.collection(ITEMS).updateOne({ itemId }, { $set: { [field]: rate, ...next } });
      return { flags: next, seq: ++mirrorSeq };
    });
  const zohoUrl = (list) => `https://www.zohoapis.com/inventory/v1/pricebooks/${PRICE_LISTS[list]}/items?organization_id=${ZOHO_ORG_ID}`;

  const results = [];
  try {
    await refreshToken();
    for (const list of Object.keys(PRICE_LISTS)) {
      const mine = changes.filter((c) => c.list === list);
      for (let i = 0; i < mine.length; i += BULK_PRICE_CHUNK) {
        const chunk = mine.slice(i, i + BULK_PRICE_CHUNK);
        const resp = await handleZohoInventoryPutRequest(zohoUrl(list), chunk.map((c) => ({ item_id: c.itemId, pricebook_rate: c.rate })));
        if (resp && resp.code === 0) {
          for (const c of chunk) {
            const m = await mirror(c);
            results.push({ ...c, ok: true, flags: m ? m.flags : null, flagsSeq: m ? m.seq : null });
          }
          continue;
        }
        // The chunk was refused: find the culprit(s) one by one, still serially.
        for (const c of chunk) {
          const one = await handleZohoInventoryPutRequest(zohoUrl(list), [{ item_id: c.itemId, pricebook_rate: c.rate }]);
          if (one && one.code === 0) {
            const m = await mirror(c);
            results.push({ ...c, ok: true, flags: m ? m.flags : null, flagsSeq: m ? m.seq : null });
          } else {
            results.push({ ...c, ok: false, message: (one && (one.message || (one.error && one.error.message))) || (resp && resp.message) || "Zoho rejected the price" });
          }
        }
      }
    }
  } catch (error) {
    console.error("Stock monitor bulk price push error:", error && error.message);
    // Whatever did not get a verdict is reported as not pushed, so the page keeps it queued.
    const seen = new Set(results.map((r) => `${r.itemId}|${r.list}`));
    for (const c of changes) if (!seen.has(`${c.itemId}|${c.list}`)) results.push({ ...c, ok: false, message: "Push interrupted — try again" });
  }
  const pushed = results.filter((r) => r.ok).length;
  return res.json({ success: true, pushed, failed: results.length - pushed, results });
});

// ── GET /stock-monitor/item/:itemId/purchase-orders ─────────────────
// What we have actually ordered, from Zoho Inventory — the system POs are
// raised in.
//
// Deliberately not imb_purchase_order: that collection is the supplier
// spreadsheet synced out of Tencent Docs, which covers one buying channel.
// Zoho is the ledger of record, and the difference is not academic — SKU
// 3743 shows "never ordered" in the sheet and eight purchase orders in
// Zoho, the most recent 200 units in June.
//
// The list call carries vendor, dates and status but not the per-item
// quantity, so open orders get a second call each to find what is still
// owed. Received ones don't need it — they are history, and there are
// rarely more than a couple open per item.
router.get("/item/:itemId/purchase-orders", VIEW, async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  if (!/^[0-9]{6,25}$/.test(itemId)) {
    return res.status(400).json({ success: false, message: "Bad item id" });
  }
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 12));

  try {
    const list = await handleZohoInventoryRequest(
      `https://www.zohoapis.com/inventory/v1/purchaseorders` +
        `?item_id=${encodeURIComponent(itemId)}&organization_id=${ZOHO_ORG_ID}` +
        `&per_page=${limit}&sort_column=date&sort_order=D`,
    );
    const orders = (list && Array.isArray(list.purchaseorders) ? list.purchaseorders : []).filter(
      (p) => p && p.purchaseorder_id,
    );

    // "Open" is Zoho's own word for issued-but-not-closed.
    const isOpen = (p) => String(p.status || "").toLowerCase() === "open";

    // How many of THIS item each order carried — the list call only gives
    // whole-order totals, which on a multi-line PO says nothing about our
    // part. Wanted on received orders too: "200 ordered in June" is the
    // fact a buyer is looking for. A few in parallel keeps it about a
    // second.
    const lineById = new Map();
    await mapWithLimit(orders, 4, async (p) => {
      try {
        const one = await handleZohoInventoryRequest(
          `https://www.zohoapis.com/inventory/v1/purchaseorders/${encodeURIComponent(p.purchaseorder_id)}` +
            `?organization_id=${ZOHO_ORG_ID}`,
        );
        const po = one && one.purchaseorder;
        const line = ((po && po.line_items) || []).find((l) => String(l.item_id) === itemId);
        if (line) {
          lineById.set(String(p.purchaseorder_id), {
            quantity: Number(line.quantity) || 0,
            received: Number(line.quantity_received) || 0,
            rate: line.rate == null ? null : Number(line.rate),
          });
        }
      } catch (e) {
        // One unreadable order must not cost the whole list.
      }
    });

    const purchaseOrders = orders.map((p) => {
      const line = lineById.get(String(p.purchaseorder_id));
      const outstanding = line ? Math.max(0, line.quantity - line.received) : null;
      return {
        date: p.date || null,
        number: p.purchaseorder_number || "",
        vendor: p.vendor_name || "",
        status: p.status || "",
        receivedStatus: p.received_status || "",
        expectedDate: p.expected_delivery_date || p.delivery_date || null,
        open: isOpen(p),
        // Only known for the open orders we looked up; null means "not
        // fetched", which the page renders as a dash rather than a zero.
        quantity: line ? line.quantity : null,
        received: line ? line.received : null,
        outstanding,
        rate: line ? line.rate : null,
      };
    });

    const onOrder = purchaseOrders
      .filter((p) => p.open && p.outstanding != null)
      .reduce((t, p) => t + p.outstanding, 0);

    return res.json({
      success: true,
      purchaseOrders,
      onOrder,
      truncated: !!(list && list.page_context && list.page_context.has_more_page),
    });
  } catch (error) {
    console.error("Stock monitor purchase orders error:", error && error.message);
    return res.status(502).json({
      success: false,
      message: "Could not read purchase orders from Zoho",
    });
  }
});

module.exports = router;
