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
const { getViewData, handleZohoInventoryRequest } = require("../../utils/zohoRequest");
const { mapWithLimit } = require("../../utils/zohoStock");

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
};

const SORTABLE = new Set([
  "sku", "name", "location", "available", "units7", "units14", "units30",
  "units90", "openPoQty", "daysOfCover", "daysSinceSale",
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
async function latestSnapshotDate(db) {
  const rows = await db
    .collection(DAILY)
    .aggregate([{ $group: { _id: "$snapshotDate" } }, { $sort: { _id: -1 } }, { $limit: 1 }])
    .toArray();
  return rows.length ? rows[0]._id : null;
}

// Turn the query string into a match document. Dormant rows (no sales, no
// stock in the whole window) are excluded unless asked for — they are 40%
// of the accessories and would drown every list.
function buildMatch(req, snapshotDate) {
  const q = req.query || {};
  const match = { snapshotDate, scope: scopeOf(req) };

  const filter = FILTERS[q.filter] ? q.filter : "all";
  Object.assign(match, FILTERS[filter]);

  if (String(q.includeDormant) !== "true") match.dormant = { $ne: true };

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
  return { match, filter };
}

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
    const live = { ...base, dormant: { $ne: true } };

    // Every tile counts over the SAME row set the lists show — dormant
    // excluded. Counting a tile over a wider set than its table is how a
    // dashboard ends up quietly lying: click 92 and get 155.
    const [tiles] = await db
      .collection(DAILY)
      .aggregate([
        { $match: live },
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
            unitsOnHand: { $sum: { $cond: [{ $gt: ["$available", 0] }, "$available", 0] } },
          },
        },
      ])
      .toArray();

    // Dormant is the one count that is deliberately about what is hidden.
    const [totals] = await db
      .collection(DAILY)
      .aggregate([
        { $match: base },
        { $group: { _id: null, all: { $sum: 1 }, dormant: { $sum: { $cond: ["$dormant", 1, 0] } } } },
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
      counts: { ...stripId(tiles), dormant: (totals && totals.dormant) || 0, all: (totals && totals.all) || 0 },
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
            belowMonthCover: 1, stale: 1, dormant: 1, daysOfCover: 1, purchasePrice: 1,
          },
        })
        // _id breaks ties so paging can't repeat or skip a row when many
        // share a sort value — most of them have units90: 0.
        .sort({ [sortField]: order, _id: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection(DAILY).countDocuments(match),
    ]);

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
