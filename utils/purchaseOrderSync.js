// Purchase Order sync — pull every tab of the supplier's Tencent Docs sheet into
// the `imb_purchase_order` collection, one record per data row, tagged with the
// sheet title as `category`.
//
// The workflow the sheet captures (and the fields filled at each stage):
//   1. Warehouse flags a low-stock item →  订货日期 / SKU / 品名 / 订货数量
//   2. Purchase team orders from a supplier →  采购单价 / 供应商 / 下单时间
//   3. Stock received + dispatched to WH →  发货数量 / 发货日期 / DHL单号
//   4. Warehouse receives it →  收到日期
// `status` is derived from which of those stages have been filled.
//
// This is a one-directional MIRROR: each sync REPLACES the collection with the
// current sheet contents (the sheet is the source of truth; rows have no stable
// id to upsert on). Build succeeds first, then the swap — a failed export never
// wipes good data.

const XLSX = require("xlsx-js-style");
const { poApiId, exportWorkbook, getSheetRawRows, getSheetId, putValues } = require("./tencentDocs");
const { getViewData, refreshToken } = require("./zohoRequest");

const COLLECTION = "imb_purchase_order";
const META = "imb_purchase_order_meta";

// Zoho Analytics "Items" view — the SKU → Item ID source (same view the
// /skuLookupBulk endpoint uses).
const ZOHO_WORKSPACE_ID = "1404913000003936002";
const ZOHO_ITEMS_VIEW_ID = "1404913000003936100";

// The sheets aren't consistent — headers carry newlines, an "（人民币）" (RMB)
// suffix, appended instructions, and per-tab wording (品名 vs 名称, 采购单价 vs
// 采购人民币价格, DHL单号 vs 单号, 订货数量 vs 数量, 收到日期 vs 收货日期). So each
// field matches on the WHITESPACE-STRIPPED header with a small predicate rather
// than an exact string. `num` parses the value to a Number.
const FIELDS = [
  { key: "orderDate", test: (h) => h === "订货日期" },
  { key: "sku", test: (h) => h.toUpperCase() === "SKU" },
  { key: "productName", test: (h) => h.includes("品名") || h === "名称" },
  { key: "orderQty", test: (h) => h.includes("订货数量") || h === "数量", num: true },
  { key: "unitPrice", test: (h) => h.includes("采购") && h.includes("价"), num: true },
  { key: "supplier", test: (h) => h === "供应商" },
  { key: "orderedAt", test: (h) => h === "下单时间" },
  { key: "shippedQty", test: (h) => h === "发货数量", num: true },
  { key: "shippedDate", test: (h) => h === "发货日期" },
  { key: "dhlTracking", test: (h) => h.toUpperCase().includes("DHL") || h === "单号" },
  { key: "receivedDate", test: (h) => h === "收到日期" || h === "收货日期" },
  { key: "note", test: (h) => h.includes("备注") },
];

function cleanStr(v) {
  return String(v == null ? "" : v).trim();
}

// Strip ALL whitespace (incl. the newlines the export embeds in headers).
function normHeader(v) {
  return String(v == null ? "" : v).replace(/\s+/g, "");
}

function toNum(v) {
  const s = cleanStr(v).replace(/,/g, "");
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Compare two stored values for equality, normalising null / "" and numbers.
function sameVal(a, b) {
  const na = a == null ? "" : a;
  const nb = b == null ? "" : b;
  if (typeof na === "number" || typeof nb === "number") return Number(na || 0) === Number(nb || 0);
  return String(na) === String(nb);
}

// A row's identity = its stable creation fields (订货日期 / SKU / 品名 / 订货数量).
// The purchase team only edits the OTHER columns, so this key stays constant and
// lets the update sync find the matching DB record.
function matchKey(r) {
  return [
    r.category || "",
    cleanStr(r.orderDate),
    cleanStr(r.sku),
    cleanStr(r.productName),
    r.orderQty == null ? "" : r.orderQty,
  ].join("||");
}

// Columns the purchase team / warehouse update on an existing row. note + zoho_id
// are OUR fields (never in the sheet as ours) — the update never overwrites them.
const UPDATE_KEYS = [
  "unitPrice",
  "supplier",
  "orderedAt",
  "shippedQty",
  "shippedDate",
  "dhlTracking",
  "receivedDate",
];

function findCol(header, field) {
  for (let c = 0; c < header.length; c++) {
    if (field.test(normHeader(header[c]))) return c;
  }
  return -1;
}

function deriveStatus(rec) {
  if (rec.receivedDate) return "received";
  if (rec.shippedDate || rec.dhlTracking || rec.shippedQty != null) return "shipped";
  if (rec.orderedAt || rec.supplier || rec.unitPrice != null) return "ordered";
  return "pending";
}

// Read the workbook and shape every data row into a record. Returns diagnostics
// alongside the records so a dry run can show what matched. Does NOT touch the DB.
async function buildPurchaseOrderRecords() {
  const byTitle = await exportWorkbook(poApiId());
  const now = new Date();
  const records = [];
  const sheets = []; // per-sheet diagnostics

  for (const [title, rows] of Object.entries(byTitle)) {
    if (!rows || !rows.length) {
      sheets.push({ title, included: false, reason: "empty", count: 0 });
      continue;
    }
    const header = rows[0];
    const cols = {};
    const matched = {};
    for (const f of FIELDS) {
      cols[f.key] = findCol(header, f);
      matched[f.key] = cols[f.key] >= 0 ? cleanStr(header[cols[f.key]]) : null;
    }
    // A tab is a purchase-order sheet only if it has an 订货日期 column. The
    // after-sales / repair tabs (售后, 摄像头修) use 寄货日期 + return columns and
    // are a different process — skip them here.
    if (cols.orderDate < 0) {
      sheets.push({ title, included: false, reason: "not a PO sheet (no 订货日期)", count: 0 });
      continue;
    }

    let count = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const rec = { category: title };
      for (const f of FIELDS) {
        const raw = cols[f.key] >= 0 ? row[cols[f.key]] : "";
        rec[f.key] = f.num ? toNum(raw) : cleanStr(raw);
      }
      if (!rec.sku && !rec.productName && rec.orderQty == null && !rec.orderDate) continue;
      rec.status = deriveStatus(rec);
      rec.lineTotal =
        rec.orderQty != null && rec.unitPrice != null
          ? Math.round(rec.orderQty * rec.unitPrice * 100) / 100
          : null;
      rec.zoho_id = null; // Zoho Inventory item_id — filled by resolveZohoIds (by SKU)
      rec.source = "tencent"; // vs "dashboard" for PO created in-app (preserved on sync)
      rec.sourceRow = r; // row position within the sheet (header is row 0)
      rec.syncedAt = now;
      records.push(rec);
      count++;
    }
    sheets.push({ title, included: true, count, matched });
  }

  return { records, sheets, syncedAt: now };
}

// Resolve zoho_id (Zoho Inventory item_id) by SKU for the NOT-yet-received rows
// (received orders are finished, so they don't need the link). Exact SKU match
// via the Zoho Analytics Items view, chunked 100 SKUs per query.
async function resolveZohoIds(db) {
  const col = db.collection(COLLECTION);
  // Distinct SKUs among not-yet-received rows (aggregation — strict mode blocks distinct()).
  const grouped = await col
    .aggregate([
      { $match: { status: { $ne: "received" }, sku: { $nin: ["", null] } } },
      { $group: { _id: "$sku" } },
    ])
    .toArray();
  const skus = grouped
    .map((g) => String(g._id || "").trim())
    .filter((s) => s && !/^new$/i.test(s));
  if (!skus.length) return { candidates: 0, resolved: 0, updated: 0 };

  try {
    await refreshToken();
  } catch (e) {
    console.warn("PO zoho resolve token pre-warm failed:", e.message || e);
  }

  const esc = (v) => String(v).replace(/'/g, "''");
  const buildUrl = (config) =>
    `https://analyticsapi.zoho.com/restapi/v2/workspaces/${ZOHO_WORKSPACE_ID}/views/${ZOHO_ITEMS_VIEW_ID}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;

  const chunks = [];
  for (let i = 0; i < skus.length; i += 100) chunks.push(skus.slice(i, i + 100));

  const responses = await Promise.all(
    chunks.map((chunk) =>
      getViewData(
        buildUrl({
          responseFormat: "json",
          selectedColumns: ["Item ID", "SKU"],
          criteria: `"SKU" IN (${chunk.map((s) => `'${esc(s)}'`).join(",")})`,
        }),
      ).catch(() => []),
    ),
  );

  const skuToId = {};
  for (const rows of responses) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const sku = r && r.SKU != null ? String(r.SKU) : "";
      const itemId = r && r["Item ID"] != null ? String(r["Item ID"]) : "";
      if (sku && itemId && !skuToId[sku]) skuToId[sku] = itemId;
    }
  }

  let updated = 0;
  for (const [sku, itemId] of Object.entries(skuToId)) {
    const r = await col.updateMany(
      { sku, status: { $ne: "received" } },
      { $set: { zoho_id: itemId } },
    );
    updated += (r && r.modifiedCount) || 0;
  }
  return { candidates: skus.length, resolved: Object.keys(skuToId).length, updated };
}

// Replace the collection with the current sheet contents, resolve zoho_id for the
// not-yet-received rows, and write a meta doc.
async function syncPurchaseOrders(db) {
  const { records, sheets, syncedAt } = await buildPurchaseOrderRecords();
  const col = db.collection(COLLECTION);

  // Replace only the Tencent-sourced rows — PO created in-app (source:"dashboard")
  // isn't in the sheet, so it must survive the mirror refresh.
  await col.deleteMany({ source: { $ne: "dashboard" } });
  if (records.length) await col.insertMany(records, { ordered: false });

  // Helpful indexes for the eventual dashboard views.
  await Promise.all([
    col.createIndex({ category: 1 }),
    col.createIndex({ status: 1 }),
    col.createIndex({ sku: 1 }),
    col.createIndex({ zoho_id: 1 }),
  ]).catch(() => {});

  // Enrich with Zoho item_ids — non-fatal (the PO data still lands if Zoho errors).
  let zoho = { candidates: 0, resolved: 0, updated: 0 };
  try {
    zoho = await resolveZohoIds(db);
  } catch (e) {
    console.error("PO zoho resolve failed:", e.message || e);
  }

  const byCategory = {};
  for (const s of sheets) if (s.included) byCategory[s.title] = s.count;

  await db.collection(META).updateOne(
    { _id: "meta" },
    { $set: { lastSyncedAt: syncedAt, total: records.length, byCategory, sheets, zoho } },
    { upsert: true },
  );

  return { total: records.length, byCategory, sheets, syncedAt, zoho };
}

// Incremental UPDATE sync (for the daily cron). Pull the sheet, then for each row
// find the existing DB record by its stable creation key and refresh only the
// changed purchase/ship/receive columns (+ derived status / lineTotal). Rows with
// no match are inserted (a genuinely new order). Nothing is deleted — dashboard
// POs not yet in the sheet, and our-only fields (note, zoho_id), are preserved.
async function updatePurchaseOrders(db) {
  const { records: incoming, sheets, syncedAt } = await buildPurchaseOrderRecords();
  const col = db.collection(COLLECTION);
  const existing = await col.find({}).toArray();

  const byKey = new Map();
  for (const e of existing) {
    const k = matchKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }

  const used = new Set();
  const inserts = [];
  let updated = 0;
  let unchanged = 0;

  for (const t of incoming) {
    const pool = byKey.get(matchKey(t));
    const e = pool && pool.find((x) => !used.has(String(x._id)));
    if (!e) {
      inserts.push(t); // new order (added in the sheet) — insert it
      continue;
    }
    used.add(String(e._id));

    const set = {};
    for (const key of UPDATE_KEYS) {
      if (!sameVal(e[key], t[key])) set[key] = t[key];
    }
    // status + lineTotal follow the (possibly updated) fields.
    const merged = { ...e, ...set };
    const status = deriveStatus(merged);
    const lineTotal =
      merged.orderQty != null && merged.unitPrice != null
        ? round2(merged.orderQty * merged.unitPrice)
        : null;
    if (e.status !== status) set.status = status;
    if (!sameVal(e.lineTotal, lineTotal)) set.lineTotal = lineTotal;

    if (Object.keys(set).length) {
      set.syncedAt = syncedAt;
      await col.updateOne({ _id: e._id }, { $set: set });
      updated++;
    } else {
      unchanged++;
    }
  }

  if (inserts.length) await col.insertMany(inserts, { ordered: false });

  await Promise.all([
    col.createIndex({ category: 1 }),
    col.createIndex({ status: 1 }),
    col.createIndex({ sku: 1 }),
    col.createIndex({ zoho_id: 1 }),
  ]).catch(() => {});

  // Resolve zoho_id for new / still-open rows (existing ones keep theirs).
  let zoho = { candidates: 0, resolved: 0, updated: 0 };
  try {
    zoho = await resolveZohoIds(db);
  } catch (e) {
    console.error("PO update zoho resolve failed:", e.message || e);
  }

  const byCategory = {};
  for (const s of sheets) if (s.included) byCategory[s.title] = s.count;
  await db.collection(META).updateOne(
    { _id: "meta" },
    {
      $set: {
        lastSyncedAt: syncedAt,
        lastUpdateSyncAt: syncedAt,
        byCategory,
        lastUpdate: { updated, inserted: inserts.length, unchanged },
      },
    },
    { upsert: true },
  );

  return { updated, inserted: inserts.length, unchanged, incoming: incoming.length, zoho, syncedAt };
}

// Append a newly-created PO as a row in the Tencent sheet for its category.
// Writes only the warehouse-stage columns (订货日期 / SKU / 品名 / 订货数量) —
// note + zoho_id stay in our DB. The purchase/ship/receive columns are left blank
// for the purchase team to fill in later, matching the manual workflow.
const WRITE_KEYS = ["orderDate", "sku", "productName", "orderQty"];

async function appendPurchaseOrderRow(rec) {
  const apiId = poApiId();
  const rawRows = await getSheetRawRows(apiId, rec.category);
  if (!rawRows || !rawRows.length) throw new Error(`Sheet "${rec.category}" has no rows`);
  const header = rawRows[0];

  // Append on the row AFTER the last one that has any content (1-based for A1).
  let lastUsed = 0;
  for (let i = 0; i < rawRows.length; i++) {
    if ((rawRows[i] || []).some((c) => String(c == null ? "" : c).trim() !== "")) lastUsed = i;
  }
  const appendRow1 = lastUsed + 2;

  // Map each write field to its real column via the same header predicates.
  const colOf = {};
  for (const key of WRITE_KEYS) {
    const f = FIELDS.find((x) => x.key === key);
    colOf[key] = f ? findCol(header, f) : -1;
  }
  const present = Object.values(colOf).filter((c) => c >= 0);
  if (!present.length) throw new Error(`No writable columns in "${rec.category}"`);
  const maxCol = Math.max(...present);

  const values = { orderDate: rec.orderDate, sku: rec.sku, productName: rec.productName, orderQty: rec.orderQty };
  const row = new Array(maxCol + 1).fill("");
  for (const key of WRITE_KEYS) {
    if (colOf[key] >= 0) row[colOf[key]] = values[key] == null ? "" : String(values[key]);
  }

  const sheetId = await getSheetId(apiId, rec.category);
  if (!sheetId) throw new Error(`Sheet id not found for "${rec.category}"`);
  const rangeA1 = `A${appendRow1}:${XLSX.utils.encode_col(maxCol)}${appendRow1}`;
  await putValues(apiId, sheetId, rangeA1, [row]);
  return { row: appendRow1, range: rangeA1 };
}

module.exports = {
  buildPurchaseOrderRecords,
  syncPurchaseOrders,
  updatePurchaseOrders,
  resolveZohoIds,
  appendPurchaseOrderRow,
  COLLECTION,
  META,
};
