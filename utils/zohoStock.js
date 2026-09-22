// Zoho stock + sales reads, shared by the Stock Monitoring page and the
// daily snapshot job.
//
// These three questions were answered inside the /zoho route handlers,
// which meant the only way to ask them was over HTTP. The snapshot job
// needs the same answers from a plain script, so they live here now and
// the routes are thin wrappers:
//
//   fetchStockShapedItems(itemIds)        their SKU, shelf and for-sale stock
//   getSalesTotals(itemIds, duration)     units sold per item over N days
//
// Everything here talks to Zoho only — no database, no request/response —
// so it is callable from a route, a script or a cron container alike.

const { getViewData, handleZohoInventoryRequest } = require("./zohoRequest");

// Zoho Analytics workspace and the views inside it.
const WORKSPACE_ID = "1404913000003936002";
const ITEMS_VIEW_ID = "1404913000003936100";
const SALES_VIEW_ID = "1404913000003936103";
const ADJUSTMENTS_VIEW_ID = "1404913000003936206";
const ADJUSTMENT_REASONS_VIEW_ID = "1404913000003936086";
const ORGANIZATION_ID = "746138234";

// Zoho's itemdetails endpoint takes 100 ids per call.
const BATCH_SIZE = 100;

// How many calls to have in flight at once. The old code fired every batch
// at once, which is harmless for one collection but would mean 119
// simultaneous requests over the full catalogue — past that, Zoho answers
// `code 1070: maximum number of in process requests` and the batch comes
// back empty. Six measured just as fast on Inventory and stays inside it.
const DEFAULT_CONCURRENCY = 6;

// Analytics is stricter than Inventory and its failures are worse: a
// rejected sales batch silently subtracts from every total computed from
// it. Fan out less, and retry rather than accept a hole.
const ANALYTICS_CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// getViewData swallows HTTP errors: it logs them and returns the error body,
// so `data.data` comes back undefined and the caller sees no rows rather
// than a failure. Every Analytics read goes through here so a throttled
// batch is retried, and a batch that never succeeds throws instead of
// quietly reporting zero.
async function analyticsRows(url, label) {
  let lastSeen;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const rows = await getViewData(url);
    if (Array.isArray(rows)) return rows;
    lastSeen = rows;
    if (attempt < MAX_ATTEMPTS) {
      // A per-minute throttle (6045) only clears with the minute — the
      // exponential micro-backoff below is for transient hiccups, not
      // rate limits.
      const throttled =
        lastSeen && lastSeen.data && Number(lastSeen.data.errorCode) === 6045;
      await sleep(throttled ? 65000 : 500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `Zoho Analytics did not return rows for ${label} after ${MAX_ATTEMPTS} attempts` +
      (lastSeen ? ` (last response: ${JSON.stringify(lastSeen).slice(0, 200)})` : ""),
  );
}

// The Inventory API fails the same way through handleZohoInventoryRequest,
// so item batches get the same treatment.
async function inventoryItems(url, label) {
  let lastSeen;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const resp = await handleZohoInventoryRequest(url);
    if (resp && Array.isArray(resp.items)) return resp.items;
    lastSeen = resp;
    if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  throw new Error(
    `Zoho Inventory did not return items for ${label} after ${MAX_ATTEMPTS} attempts` +
      (lastSeen ? ` (last response: ${JSON.stringify(lastSeen).slice(0, 200)})` : ""),
  );
}

function chunkArray(arr, size = BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// Run `fn` over `items`, at most `limit` at a time. Results keep the input
// order, so callers can zip them back against their batches.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function analyticsUrl(viewId, config) {
  return (
    `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}` +
    `/views/${viewId}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`
  );
}

// Values for a SQL IN (...) list, with quotes escaped.
function buildInClause(ids) {
  return ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");
}

// ── item sets ───────────────────────────────────────────────────────

// Resolve a criteria expression to the item ids it matches.
async function getItemIdsFromCriteria(criteria) {
  const viewData = await analyticsRows(
    analyticsUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ["Item ID"],
      criteria,
    }),
    "item ids by criteria",
  );
  if (viewData.length === 0) return [];
  return [...new Set(viewData.map((r) => r["Item ID"]).filter(Boolean))];
}

// (Collection membership used to be resolved here through an Analytics
// criteria string; since 2026-09-22 a collection is a filter over the
// stock register — utils/collectionFilter.)

// ── item attributes ─────────────────────────────────────────────────

// Attributes the Inventory item record doesn't carry, read from the
// Analytics items view in one call. (Classification was read here too
// until 2026-09-22; it and the other catalogue custom fields now come from
// the item record itself — itemCatalogueFields below — which is current the
// moment an item is edited, where Analytics lags by hours.)
const ITEM_ATTRIBUTE_COLUMNS = [
  "Item ID",
  "SKU",
  "Item Name",
  "Prefer Vendor",
  "Brand",
  "Location",
  "Purchase Price",
];

// Everything active and shelved, with its attributes — one Analytics call.
// `criteria` defaults to the universe the snapshot covers.
async function fetchItemAttributes(
  criteria = `"Status" = 'Active' AND "Location" IS NOT NULL`,
) {
  return analyticsRows(
    analyticsUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ITEM_ATTRIBUTE_COLUMNS,
      criteria,
    }),
    "item attributes",
  );
}

// ── stock ───────────────────────────────────────────────────────────

// Raw Zoho item records for a set of ids. The snapshot job wants more
// fields than the page does, so the shaping is left to the caller.
async function fetchItemDetails(
  itemIds,
  { concurrency = DEFAULT_CONCURRENCY } = {},
) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return [];

  const batches = await mapWithLimit(
    chunkArray(itemIds),
    concurrency,
    (batchIds, i) =>
      inventoryItems(
        `https://www.zohoapis.com/inventory/v1/itemdetails` +
          `?item_ids=${encodeURIComponent(batchIds.join(","))}` +
          `&organization_id=${ORGANIZATION_ID}`,
        `item batch ${i + 1}`,
      ),
  );
  return batches.flat();
}

const { imageIdOf, imageUrlFromId } = require("./productImage");

// Read the shelf out of Zoho's custom fields.
function itemLocation(item) {
  const field = (item.custom_fields || []).find((c) => c.label === "Location");
  return (field && field.value) || "";
}

// One custom field by its label ("Sub Classification"), matched with case
// and punctuation ignored so "CF.Sub Classification" reads the same. "" when
// the item has no such field.
const normLabel = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function itemCustomField(item, label) {
  const want = normLabel(label);
  const field = (item.custom_fields || []).find((c) => normLabel(c.label) === want);
  const v = field ? field.value : "";
  return v == null ? "" : String(v).trim();
}

// The catalogue fields kept on the Zoho item as custom fields (imported
// 2026-09-22 from the classification review — Zoho is the catalogue of
// record for these): what the part is, its grade, and the devices it fits.
// Compatible Model is one multi-line text field of "; "-separated model
// names, split into a list here.
function itemCatalogueFields(item) {
  return {
    classification: itemCustomField(item, "Classification"),
    subClassification: itemCustomField(item, "Sub Classification"),
    quality: itemCustomField(item, "Quality"),
    deviceBrand: itemCustomField(item, "Device Brand"),
    deviceSeries: itemCustomField(item, "Device Series"),
    compatibleModels: itemCustomField(item, "Compatible Model")
      .split(/\s*;\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// The fields only the items LIST carries — not the bulk itemdetails record
// the refresh reads: whether the item is shown in the online store
// (`show_in_storefront`; the single-item record only shows it as a "Zoho
// Commerce" entry under sales_channels) and Zoho's own item category. One
// pass over the active list, 200 items a page (~100 calls for the
// catalogue). A page that never comes back throws, so a refresh fails
// loudly rather than storing wrong values. Returns
// Map(itemId → { showInStore, categoryId, category }).
async function fetchItemListFields() {
  const flags = new Map();
  for (let page = 1; page <= 500; page++) {
    const url =
      `https://www.zohoapis.com/inventory/v1/items?organization_id=${ORGANIZATION_ID}` +
      `&filter_by=Status.Active&per_page=200&page=${page}`;
    let resp = null;
    let lastSeen;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await handleZohoInventoryRequest(url);
      if (r && Array.isArray(r.items)) { resp = r; break; }
      lastSeen = r;
      if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
    if (!resp) {
      throw new Error(
        `Zoho Inventory items list page ${page} failed after ${MAX_ATTEMPTS} attempts` +
          (lastSeen ? ` (last response: ${JSON.stringify(lastSeen).slice(0, 200)})` : ""),
      );
    }
    for (const it of resp.items) flags.set(String(it.item_id), listFields(it));
    if (!(resp.page_context && resp.page_context.has_more_page)) break;
  }
  return flags;
}
// The same three fields off one list row (the hourly sync reads the list
// too, for what changed).
function listFields(row) {
  return {
    showInStore: row.show_in_storefront === true,
    categoryId: String(row.category_id || ""),
    category: String(row.category_name || "").trim(),
  };
}

// The `{ id, sku, productName, location, stock }` shape Stock Monitoring
// renders, sorted by name.
async function fetchStockShapedItems(itemIds, options = {}) {
  const items = await fetchItemDetails(itemIds, options);
  return items
    .map((item) => ({
      id: item.item_id,
      sku: item.sku,
      productName: item.name,
      location: itemLocation(item),
      // actual_available_for_sale_stock already nets out committed stock —
      // subtracting actual_committed_stock again double-counted it, so a
      // fully committed item (on-hand 2, committed 2 → for-sale 0) showed
      // -2. Use it as-is, matching the product detail dialog and the
      // location endpoint.
      stock: Number(item.actual_available_for_sale_stock || 0),
      // Zoho splits stock into Accounting (invoice-driven, the un-prefixed
      // fields) and Physical (shipment-driven, the actual_* fields — what
      // `stock` above reads). The Accessories page shows both.
      accountingStock: Number(item.available_for_sale_stock || 0),
      // Zoho's reorder level — maintained for accessories (the Accessories
      // page shows it as "Reorder Point"); parts don't use it.
      reorderLevel: Number(item.reorder_level || 0),
      // The main product image, as a public store URL (null = no image).
      // Comes free with the item details — no per-row image call.
      imageUrl: imageUrlFromId(imageIdOf(item)),
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

// ── sales ───────────────────────────────────────────────────────────

// Adjustments are how counter trade, workshop usage, the Neto store and
// dashboard dispatch leave stock, so they count as sales — but only the
// reasons in OFFLINE_SALE_SCOPES (utils/stockItems), each a sales scope of
// its own. Anything else (a stock take correction, a write-off) is not
// demand.
const { OFFLINE_SALE_SCOPES } = require("./stockItems");
const OFFLINE_SALE_REASONS = new Set(Object.keys(OFFLINE_SALE_SCOPES));

// Past this many ids, filtering the Analytics views by Product ID costs
// more requests than simply reading the whole window. Zoho caps Analytics
// requests per account per interval (`errorCode 6045`), and a 119-batch
// pull trips it — so the whole-window path is not just faster, it is the
// only one that completes.
const WHOLE_WINDOW_THRESHOLD = 3 * BATCH_SIZE;

// Aggregate raw Analytics rows into per-item totals. `keep` optionally
// limits the result to a set of item ids.
function tallySales(salesRows, adjustmentRows, reasonByAdjustment, keep) {
  const byItem = {};
  const wanted = keep instanceof Set ? keep : null;
  const bucket = (id) => {
    if (wanted && !wanted.has(id)) return null;
    if (!byItem[id]) byItem[id] = { id, zohoSales: 0, offlineSales: 0 };
    return byItem[id];
  };

  for (const row of salesRows) {
    const b = bucket(row["Product ID"]);
    if (b) b.zohoSales += Number(row["Quantity"]) || 0;
  }
  for (const row of adjustmentRows) {
    const reason = reasonByAdjustment.get(row["Inventory Adjustment ID"]);
    if (!OFFLINE_SALE_REASONS.has(reason)) continue;
    const b = bucket(row["Product ID"]);
    // Stock leaving is a negative adjustment; flip it so sales read positive.
    if (b) b.offlineSales += (Number(row["Quantity Adjusted"]) || 0) * -1;
  }
  return Object.values(byItem);
}

// Every sale and adjustment in the window, as raw rows, in three Analytics
// calls — regardless of how many items are involved. Callers that want more
// than a single total (per-week buckets, a last-sale date) aggregate these
// themselves rather than paying for another read per window.
async function fetchWindowRows(duration = 30) {
  const since = new Date(Date.now() - duration * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const [salesRows, adjustmentRows] = await Promise.all([
    analyticsRows(
      analyticsUrl(SALES_VIEW_ID, {
        responseFormat: "json",
        selectedColumns: ["Product ID", "Quantity", "Created Time"],
        criteria: `"Created Time" >= '${since}'`,
      }),
      "sales rows for the window",
    ),
    analyticsRows(
      analyticsUrl(ADJUSTMENTS_VIEW_ID, {
        responseFormat: "json",
        selectedColumns: [
          "Product ID",
          "Inventory Adjustment ID",
          "Quantity Adjusted",
          "Created Time",
        ],
        criteria: `"Created Time" >= '${since}'`,
      }),
      "adjustment rows for the window",
    ),
  ]);

  // The reasons view carries no date column, and an IN clause over
  // thousands of adjustment ids exceeds the URI limit — but the whole view
  // is small enough to read in one call.
  const reasonRows = adjustmentRows.length
    ? await analyticsRows(
        analyticsUrl(ADJUSTMENT_REASONS_VIEW_ID, {
          responseFormat: "json",
          selectedColumns: ["Inventory Adjustment ID", "Reason"],
          criteria: `"Inventory Adjustment ID" IS NOT NULL`,
        }),
        "adjustment reasons",
      )
    : [];
  const reasonByAdjustment = new Map(
    reasonRows.map((r) => [r["Inventory Adjustment ID"], r.Reason]),
  );

  return { since, salesRows, adjustmentRows, reasonByAdjustment };
}

// One item's sales and offline-sale adjustments over the last `days`, as
// raw rows — the item drawer's sales-by-week trend. Filtered in the query,
// so it is two small Analytics reads (a third for the adjustments' reasons
// when there are any).
async function fetchItemWindowRows(itemId, days = 84) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const id = String(itemId).replace(/[^0-9]/g, "");
  const [salesRows, adjustmentRows] = await Promise.all([
    analyticsRows(
      analyticsUrl(SALES_VIEW_ID, {
        responseFormat: "json",
        selectedColumns: ["Product ID", "Quantity", "Created Time"],
        criteria: `("Product ID" = '${id}') AND ("Created Time" >= '${since}')`,
      }),
      "item sales rows",
    ),
    analyticsRows(
      analyticsUrl(ADJUSTMENTS_VIEW_ID, {
        responseFormat: "json",
        selectedColumns: ["Product ID", "Inventory Adjustment ID", "Quantity Adjusted", "Created Time"],
        criteria: `("Product ID" = '${id}') AND ("Created Time" >= '${since}')`,
      }),
      "item adjustment rows",
    ),
  ]);
  const reasonByAdjustment = new Map();
  const adjustmentIds = [...new Set(adjustmentRows.map((r) => r["Inventory Adjustment ID"]).filter(Boolean))];
  if (adjustmentIds.length) {
    const reasonRows = await analyticsRows(
      analyticsUrl(ADJUSTMENT_REASONS_VIEW_ID, {
        responseFormat: "json",
        selectedColumns: ["Inventory Adjustment ID", "Reason"],
        criteria: `"Inventory Adjustment ID" IN (${buildInClause(adjustmentIds)})`,
      }),
      "item adjustment reasons",
    );
    for (const r of reasonRows) reasonByAdjustment.set(r["Inventory Adjustment ID"], r.Reason);
  }
  return { since, salesRows, adjustmentRows, reasonByAdjustment };
}

// Per-item totals over the window, from the rows above.
async function getSalesTotalsForWindow(duration = 30, { itemIds = null } = {}) {
  const { salesRows, adjustmentRows, reasonByAdjustment } =
    await fetchWindowRows(duration);
  return tallySales(
    salesRows,
    adjustmentRows,
    reasonByAdjustment,
    Array.isArray(itemIds) ? new Set(itemIds) : null,
  );
}

// Units sold per item over the last `duration` days, split into online
// orders and offline adjustments:
//
//   [{ id, zohoSales, offlineSales }]
//
// Items with no movement in the window are absent rather than zeroed — the
// caller knows which ids it asked about. Small id sets are filtered in the
// query; large ones read the whole window and filter here, because the
// per-batch path cannot complete at that size.
async function getSalesTotals(
  itemIds,
  duration = 30,
  { concurrency = ANALYTICS_CONCURRENCY } = {},
) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return [];
  if (itemIds.length > WHOLE_WINDOW_THRESHOLD) {
    return getSalesTotalsForWindow(duration, { itemIds });
  }

  const since = new Date(Date.now() - duration * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const perBatch = await mapWithLimit(
    chunkArray(itemIds),
    concurrency,
    async (batchIds) => {
      const inClause = buildInClause(batchIds);
      const [sales, offline] = await Promise.all([
        analyticsRows(
          analyticsUrl(SALES_VIEW_ID, {
            responseFormat: "json",
            selectedColumns: ["Product ID", "Quantity", "Created Time"],
            criteria: `("Product ID" IN (${inClause})) AND ("Created Time" >= '${since}')`,
          }),
          "sales rows",
        ),
        analyticsRows(
          analyticsUrl(ADJUSTMENTS_VIEW_ID, {
            responseFormat: "json",
            selectedColumns: [
              "Product ID",
              "Inventory Adjustment ID",
              "Quantity Adjusted",
              "Created Time",
            ],
            criteria: `("Product ID" IN (${inClause})) AND ("Created Time" >= '${since}')`,
          }),
          "adjustment rows",
        ),
      ]);
      return { sales, offline };
    },
  );

  const salesRows = perBatch.flatMap((b) => b.sales);
  const offlineRows = perBatch.flatMap((b) => b.offline);

  // An adjustment row names its adjustment, not its reason — so the
  // reasons come back in a second pass over the ids we actually saw.
  const adjustmentIds = [
    ...new Set(
      offlineRows.map((r) => r["Inventory Adjustment ID"]).filter(Boolean),
    ),
  ];
  const reasonMap = {};
  if (adjustmentIds.length) {
    const reasonBatches = await mapWithLimit(
      chunkArray(adjustmentIds),
      concurrency,
      (batchIds) =>
        analyticsRows(
          analyticsUrl(ADJUSTMENT_REASONS_VIEW_ID, {
            responseFormat: "json",
            selectedColumns: ["Inventory Adjustment ID", "Reason"],
            criteria: `"Inventory Adjustment ID" IN (${buildInClause(batchIds)})`,
          }),
          "adjustment reasons",
        ),
    );
    for (const row of reasonBatches.flat()) {
      reasonMap[row["Inventory Adjustment ID"]] = row.Reason;
    }
  }

  return tallySales(salesRows, offlineRows, new Map(Object.entries(reasonMap)));
}

module.exports = {
  WORKSPACE_ID,
  ITEMS_VIEW_ID,
  ORGANIZATION_ID,
  BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  ANALYTICS_CONCURRENCY,
  chunkArray,
  mapWithLimit,
  getItemIdsFromCriteria,
  fetchItemDetails,
  itemLocation,
  itemCustomField,
  itemCatalogueFields,
  fetchItemListFields,
  listFields,
  fetchStockShapedItems,
  getSalesTotals,
  getSalesTotalsForWindow,
  fetchWindowRows,
  fetchItemWindowRows,
  tallySales,
  WHOLE_WINDOW_THRESHOLD,
  OFFLINE_SALE_REASONS,
  OFFLINE_SALE_SCOPES,
  ITEM_ATTRIBUTE_COLUMNS,
  fetchItemAttributes,
};
