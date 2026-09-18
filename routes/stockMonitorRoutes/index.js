// Stock Monitoring — reads the daily snapshot bin/stockSnapshot.js writes.
//
// The list, the tiles and the shelves come entirely from imb_stock_daily,
// so the page loads in milliseconds where the live sweep takes fifty
// seconds. The trade is freshness: those are "as of" the last run, and the
// summary says so plainly rather than letting yesterday pass for today.
//
//   GET /stock-monitor/summary         as-of, tile counts, filter options
//   GET /stock-monitor/items           the working list, filtered and paged
//   GET /stock-monitor/shelves         shelf rollup for a stock take
//   GET /stock-monitor/item/:id        one item, with PO lines and history
//   GET /stock-monitor/item/:id/sales  who bought it, live from Zoho
//
// The last one is the exception that does hit Zoho: invoice numbers and
// customer names are not in the snapshot (it stores totals, not lines), and
// this runs for one item only when someone opens its drawer.
//
// Reading needs zoho:stock:view — the same permission as the per-collection
// Stock Monitoring page.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const {
  getViewData,
  handleZohoInventoryRequest,
  handleZohoInventoryPutRequest,
  handleZohoInventoryMultipartPostRequest,
  refreshToken,
} = require("../../utils/zohoRequest");
const { mapWithLimit, fetchItemDetails } = require("../../utils/zohoStock");
const { imageIdOf, imageUrlFromId } = require("../../utils/productImage");

const DAILY = "imb_stock_daily";
const RUNS = "imb_stock_runs";

const VIEW = requirePermission("zoho:stock:view");

const SCOPES = ["parts", "accessory"];
const MAX_PAGE_SIZE = 200;

// The named lists the tiles link to. Each is a Mongo predicate fragment, so
// a tile and its table are guaranteed to count the same rows — the classic
// way these dashboards drift is a tile and a list disagreeing.
const FILTERS = {
  all: {},
  outOfStock: { outOfStock: true },
  // Out of stock with nothing coming: the buy list.
  uncovered: { outOfStockUncovered: true },
  onOrder: { outOfStockCovered: true },
  belowCover: { belowMonthCover: true },
  // "No sales in a fortnight" on its own is most of a long-tail catalogue.
  // Crossed with stock on hand it becomes money sitting on a shelf.
  sittingStill: { stale: true, available: { $gt: 0 } },
  negative: { available: { $lt: 0 } },
  // Sold recently but at zero now — the shortest actionable list there is.
  sellingAndOut: { outOfStock: true, units90: { $gt: 0 } },
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
  // explicit null only: rows from snapshots written before imageId existed
  // have no field at all and must not read as "no image".
  noImage: { imageId: { $type: "null" } },
  noImageInStock: { imageId: { $type: "null" }, available: { $gt: 0 } },
  noImageOutOfStock: { imageId: { $type: "null" }, available: { $lte: 0 } },
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

// The newest snapshot we hold. Everything else is keyed off it, so a failed
// overnight run shows yesterday's numbers rather than an empty page — with
// the date attached so the UI can say how old they are.
// An indexed sort-and-take-one, NOT a $group over every stored day — and
// cached for a minute: this runs at the top of every request in the module,
// the value changes once a night, and the Mongo server is a ~170ms network
// round trip away.
let snapshotDateCache = { value: null, at: 0 };
async function latestSnapshotDate(db) {
  if (snapshotDateCache.value && Date.now() - snapshotDateCache.at < 60000) {
    return snapshotDateCache.value;
  }
  const row = await db
    .collection(DAILY)
    .find({}, { projection: { _id: 0, snapshotDate: 1 } })
    .sort({ snapshotDate: -1 })
    .limit(1)
    .next();
  if (row) snapshotDateCache = { value: row.snapshotDate, at: Date.now() };
  return row ? row.snapshotDate : null;
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
function buildMatch(req, snapshotDate) {
  const q = req.query || {};
  const match = { snapshotDate, scope: scopeOf(req), ...baseFilterMatch(req) };

  const filter = FILTERS[q.filter] ? q.filter : "all";
  Object.assign(match, FILTERS[filter]);

  // The Archive bucket (criteria matches + manual marks) is hidden from
  // every view except its own filters.
  if (!ARCHIVE_FILTERS.has(filter)) match.archived = { $ne: true };

  return { match, filter };
}

// ── POST /stock-monitor/snapshot/run ────────────────────────────────
// Trigger the daily snapshot on demand (the dashboard's "Update snapshot"
// button when the overnight job hasn't run). Spawns bin/stockSnapshot.js
// --apply as a child process — the script is the cron entrypoint and calls
// process.exit, so it must not run in-process. One run at a time; the
// dashboard polls GET /snapshot/run until it finishes.
const { spawn } = require("child_process");
const path = require("path");
let snapshotChild = null;

router.post("/snapshot/run", VIEW, (req, res) => {
  if (snapshotChild) {
    return res.json({ success: true, running: true, alreadyRunning: true });
  }
  const backendRoot = path.join(__dirname, "..", "..");
  const child = spawn(process.execPath, [path.join(backendRoot, "bin", "stockSnapshot.js"), "--apply"], {
    cwd: backendRoot,
    stdio: "ignore",
  });
  snapshotChild = child;
  child.on("exit", (code) => {
    snapshotChild = null;
    // Drop the cached date so the fresh snapshot shows immediately.
    snapshotDateCache = { value: null, at: 0 };
    console.log(`stock snapshot run finished (exit ${code})`);
  });
  child.on("error", (e) => {
    snapshotChild = null;
    console.error("stock snapshot spawn error:", e.message);
  });
  console.log(`stock snapshot run started by ${(req.user && req.user.username) || "unknown"}`);
  return res.json({ success: true, running: true });
});

router.get("/snapshot/run", VIEW, (req, res) => {
  return res.json({ success: true, running: !!snapshotChild });
});

// ── GET /stock-monitor/summary ──────────────────────────────────────
// One aggregation for every tile, plus the values the filter selects
// offer. Both are derived from the snapshot, so a category with no rows
// today simply isn't offered.
router.get("/summary", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const snapshotDate = await latestSnapshotDate(db);
    if (!snapshotDate) {
      return res.json({ success: true, snapshotDate: null, run: null, counts: null, options: null });
    }
    const scope = scopeOf(req);
    const base = { snapshotDate, scope };
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
      .collection(DAILY)
      .aggregate([
        { $match: filtered },
        {
          $group: {
            _id: null,
            items: { $sum: 1 },
            outOfStock: { $sum: { $cond: ["$outOfStock", 1, 0] } },
            uncovered: { $sum: { $cond: ["$outOfStockUncovered", 1, 0] } },
            onOrder: { $sum: { $cond: ["$outOfStockCovered", 1, 0] } },
            belowCover: { $sum: { $cond: ["$belowMonthCover", 1, 0] } },
            sittingStill: { $sum: { $cond: [{ $and: ["$stale", { $gt: ["$available", 0] }] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $lt: ["$available", 0] }, 1, 0] } },
            sellingAndOut: {
              $sum: { $cond: [{ $and: ["$outOfStock", { $gt: ["$units90", 0] }] }, 1, 0] },
            },
            priceMissing: { $sum: { $cond: ["$priceMissing", 1, 0] } },
            pricePlaceholder: { $sum: { $cond: ["$pricePlaceholder", 1, 0] } },
            priceUnpriced: { $sum: { $cond: [{ $or: ["$priceMissing", "$pricePlaceholder"] }, 1, 0] } },
            priceRuleBroken: { $sum: { $cond: ["$priceRuleBroken", 1, 0] } },
            priceBelowCost: { $sum: { $cond: ["$priceBelowCost", 1, 0] } },
            priceOrderBroken: { $sum: { $cond: ["$priceOrderBroken", 1, 0] } },
            noImage: { $sum: { $cond: [{ $eq: [{ $type: "$imageId" }, "null"] }, 1, 0] } },
            noImageInStock: {
              $sum: { $cond: [{ $and: [{ $eq: [{ $type: "$imageId" }, "null"] }, { $gt: ["$available", 0] }] }, 1, 0] },
            },
            noImageOutOfStock: {
              $sum: { $cond: [{ $and: [{ $eq: [{ $type: "$imageId" }, "null"] }, { $lte: ["$available", 0] }] }, 1, 0] },
            },
            unitsOnHand: { $sum: { $cond: [{ $gt: ["$available", 0] }, "$available", 0] } },
          },
        },
      ])
      .toArray();

    const [totals] = await db
      .collection(DAILY)
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
      const rows = await db.collection(DAILY).aggregate(stages).toArray();
      return rows.map((r) => ({ value: r._id, count: r.n }));
    };

    const [categories, collections, vendors, qualities] = await Promise.all([
      optionsOf("category"),
      optionsOf("collections", true),
      optionsOf("preferVendor"),
      optionsOf("quality"),
    ]);

    const run = await db.collection(RUNS).findOne({}, { sort: { startedAt: -1 } });

    return res.json({
      success: true,
      snapshotDate,
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
    const snapshotDate = await latestSnapshotDate(db);
    if (!snapshotDate) return res.json({ success: true, snapshotDate: null, rows: [], total: 0 });

    const { match, filter } = buildMatch(req, snapshotDate);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const sortField = SORTABLE.has(String(req.query.sort)) ? String(req.query.sort) : "units90";
    const order = String(req.query.order) === "asc" ? 1 : -1;

    const [rows, total] = await Promise.all([
      db
        .collection(DAILY)
        .find(match, {
          projection: {
            _id: 0, itemId: 1, sku: 1, name: 1, location: 1, scope: 1, classification: 1,
            preferVendor: 1, brand: 1, category: 1, quality: 1, collections: 1, inCatalogue: 1,
            available: 1, stockOnHand: 1, committed: 1,
            units7: 1, units14: 1, units30: 1, units90: 1, lastSaleAt: 1, daysSinceSale: 1,
            openPoQty: 1, openPoLines: 1, earliestPoDate: 1,
            outOfStock: 1, outOfStockCovered: 1, outOfStockUncovered: 1,
            belowMonthCover: 1, stale: 1, archived: 1, archivedReason: 1,
            daysOfCover: 1, purchasePrice: 1,
            pricePlatinum: 1, priceVip: 1, priceSvip: 1, priceWholesale: 1,
            priceMissing: 1, pricePlaceholder: 1, priceBelowCost: 1, priceOrderBroken: 1,
            priceRule: 1, priceExpected: 1, priceRuleBroken: 1, imageId: 1,
          },
        })
        // _id breaks ties so paging can't repeat or skip a row when many
        // share a sort value — most of them have units90: 0. The merged
        // Missing Price view groups truly-missing rows above placeholder
        // ones before the user's sort applies.
        .sort(
          filter === "priceUnpriced"
            ? { priceMissing: -1, [sortField]: order, _id: 1 }
            : { [sortField]: order, _id: 1 },
        )
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection(DAILY).countDocuments(match),
    ]);

    // 海运 membership, joined live from the pinned collection doc rather
    // than the snapshot's collections array — an item added today badges
    // (and can be toggled) immediately, not after the next snapshot.
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

    // The snapshot stores only the image id; the page gets a usable URL.
    for (const r of rows) r.imageUrl = imageUrlFromId(r.imageId);

    return res.json({ success: true, snapshotDate, filter, page, pageSize, total, rows });
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
      .collection(DAILY)
      .aggregate([
        { $match: { snapshotDate, scope: scopeOf(req), location: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$location",
            items: { $sum: 1 },
            units: { $sum: { $cond: [{ $gt: ["$available", 0] }, "$available", 0] } },
            outOfStock: { $sum: { $cond: ["$outOfStock", 1, 0] } },
            negative: { $sum: { $cond: [{ $lt: ["$available", 0] }, 1, 0] } },
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
// The drawer: today's row, the open POs behind its SKU, and the last few
// snapshots so stock and demand can be seen moving.
router.get("/item/:itemId", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const snapshotDate = await latestSnapshotDate(db);
    if (!snapshotDate) return res.status(404).json({ success: false, message: "No snapshot yet" });

    const item = await db
      .collection(DAILY)
      .findOne({ snapshotDate, itemId: String(req.params.itemId) }, { projection: { _id: 0 } });
    if (!item) {
      return res.status(404).json({ success: false, message: "Item not in the latest snapshot" });
    }

    const history = await db
      .collection(DAILY)
      .find(
        { itemId: item.itemId },
        { projection: { _id: 0, snapshotDate: 1, available: 1, units30: 1, openPoQty: 1 } },
      )
      .sort({ snapshotDate: -1 })
      .limit(60)
      .toArray();

    // Purchase orders are NOT returned here: they come from Zoho Inventory
    // via /item/:id/purchase-orders, which is a live read. Keeping them out
    // of this endpoint is what lets the drawer paint immediately.
    return res.json({
      success: true,
      snapshotDate,
      item,
      history: history.reverse(),
    });
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
// invent buyers. The item's offlineUnits total covers it.
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
// Today's snapshot rows are flipped immediately so the pages update now.
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
    const snapshotDate = await latestSnapshotDate(db);
    const row = snapshotDate
      ? await db.collection(DAILY).findOne(
          { snapshotDate, itemId },
          { projection: { sku: 1, name: 1 } },
        )
      : null;

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
    // Flip today's rows so the change shows without waiting for tonight.
    if (snapshotDate) {
      await db.collection(DAILY).updateMany(
        { snapshotDate, itemId },
        { $set: { archived: !restore, archivedReason: restore ? null : "manual" } },
      );
    }
    return res.json({ success: true, itemId, archived: !restore });
  } catch (error) {
    next(error);
  }
});

// One item's itemdetails record, or null when Zoho says it no longer
// exists (code 2006 — deleted since the snapshot was taken).
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
// its main image id mirrored into today's snapshot so a fixed item leaves
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
    const snapshotDate = await latestSnapshotDate(db);
    if (snapshotDate) {
      await db.collection(DAILY).updateMany({ snapshotDate, itemId }, { $set: { imageId } });
    }
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
// snapshot so the page (and the no-image counts) update at once.
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
      const snapshotDate = await latestSnapshotDate(db);
      if (snapshotDate) {
        await db.collection(DAILY).updateMany({ snapshotDate, itemId }, { $set: { imageId } });
      }
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

// ── GET /stock-monitor/item/:itemId/prices ──────────────────────────
// The four price-list rates for one item, read live from the Analytics
// prices view — the Price Monitoring page's "check live" button. One call;
// fresher than the nightly snapshot (Analytics itself syncs from Inventory
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
// On success the rate is mirrored into today's snapshot row and the row's
// price-health flags recomputed, so the page reflects the push immediately
// (Zoho Analytics — the snapshot's source — lags a price push by hours).
const PRICE_FIELDS = {
  platinum: "pricePlatinum",
  vip: "priceVip",
  svip: "priceSvip",
  wholesale: "priceWholesale",
};
const PRICE_PLACEHOLDERS = new Set([9999.99, 9000, 8888, 7777, 7000, 6000]);
const { evaluatePriceRule } = require("../../utils/priceRules");

// Same rule as the snapshot job: SVIP ≤ VIP, WholeSale ≤ VIP, VIP ≤
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

// Per-product lock for the snapshot mirror below. Pushes for the same
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

    // Mirror into today's snapshot and recompute this row's flags.
    const db = await connectToDatabase();
    const snapshotDate = await latestSnapshotDate(db);
    const mirrored = await withItemLock(itemId, async () => {
      if (!snapshotDate) return null;
      const row = await db.collection(DAILY).findOne(
        { snapshotDate, itemId },
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
      await db.collection(DAILY).updateMany(
        { snapshotDate, itemId },
        { $set: { [field]: rounded, ...next } },
      );
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
