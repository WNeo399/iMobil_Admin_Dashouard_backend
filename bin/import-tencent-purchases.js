#!/usr/bin/env node
// One-time migration of the OPEN Tencent-sheet purchase orders (mirrored in
// imb_purchase_order by utils/purchaseOrderSync.js) into the Spare Parts
// Purchase module (imb_spp_orders + imb_spp_batches), so the sheet can be
// retired.
//
//   node bin/import-tencent-purchases.js                    dry run: report only
//   node bin/import-tencent-purchases.js --apply            import, then report
//   --since 2026-07-01      first 订货日期 taken (default 2026-07-01)
//   --include-unmatched     also import rows whose SKU is not in the register
//                           (they get no item link — Stock Monitoring cannot
//                           count them); by default they are left in the sheet
//   --report <file.xlsx>    where the report goes (default: next to the repos)
//
// Rows whose SKU cell is 特别 are special orders, "New" new products: they
// import under the Special Order / New Product channel without a catalogue
// item. Mirror copies the sheet no longer has (a row edited or removed since)
// are left out.
//
// Scope: rows not yet received whose 订货日期 is on/after --since. A row with
// no 订货日期 comes across too (the user's call), dated from its own 下单时间,
// else its 发货日期, else the nearest dated row above it in the same tab (a
// date in DATE_OVERRIDES wins); such rows are reported for review. Cancelled
// rows, rows whose 供应商 cell says 取消 / 太贵不要, and duplicate rows (same
// item, tab, date and qty — the most advanced one is kept) are skipped. A 供应商
// cell that says 没货 / 缺货 becomes a Shortage line. Shipped rows are grouped
// by DHL tracking into one shipment batch each (no Zoho PO is raised for them:
// those shipments had their Zoho PO made by hand in the sheet era).
//
// Idempotent: a sheet record that is already in the module (tencent.recId) is
// skipped, so the script can be re-run after the sheet is fixed.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
const { ObjectId } = require("mongodb");
const XLSX = require("xlsx-js-style");
const { connectToDatabase } = require("../utils/mongodb");
const { buildPurchaseOrderRecords } = require("../utils/purchaseOrderSync");

const SHEET = "imb_purchase_order";
const ORDERS = "imb_spp_orders";
const BATCHES = "imb_spp_batches";
const COUNTERS = "imb_spp_counters";
const ITEMS = "imb_stock_items";
const BY = "tencent-import";

const CLASSIFICATIONS = ["Screen", "Housing", "Middle Frame", "BackCover", "Battery", "Small Parts", "Tools", "Other"];
// Sheet tab → module category when the item is not in the register.
const TAB_CATEGORY = {
  屏幕: "Screen",
  中框: "Middle Frame",
  后盖: "BackCover",
  电池: "Battery",
  摄像头: "Small Parts",
  小配: "Small Parts",
  海运平板: "海运",
  "Macbook Ref 翻新的": "Other",
  "Macbook Aftermarket": "Other",
};
// A tab that is a purchase channel: its lines file there whatever the item is.
const CHANNEL_TABS = { 海运平板: "海运" };
const SHORTAGE_WORDS = ["没货", "缺货", "暂时没货", "暂时缺"];
const CANCEL_WORDS = ["取消", "太贵不要"];
// SKU cells that are placeholders, not SKUs.
const SKU_PLACEHOLDERS = new Set(["new", "特别", "特殊", "n/a", "na", "-", "—", "tbc", "tbd"]);

// Sheet rows with no usable SKU, linked to their catalogue item by hand
// (tab, 订货日期, 品名 as in the sheet → the item's SKU). Kept here rather than
// on the mirror: a full Refresh of the old Purchase Order page rebuilds the
// mirror and would drop a link stored there.
const MANUAL_LINKS = [
  // (the six Samsung A36 / A57 middle frames linked here on 2026-09-23 got
  // their SKUs in the sheet the same day, so their links were removed)
];
// Sheet rows with no 订货日期 that should still come across, with the date to
// use (tab + SKU identify the row). Only applies while the sheet cell is
// empty: once the row is dated in the sheet, the sheet's date is used.
// (Rows not listed here are dated from the sheet — see "dated from" below.)
const DATE_OVERRIDES = [
  { tab: "后盖", sku: "15311", date: "2026-09-23" }, // S24 Plus back cover ×5 — the user: "set to today"
];

// A 特别 SKU cell marks a special order: it files under the Special Order
// channel and needs no catalogue item (the user's rule).
const SPECIAL_SKUS = new Set(["特别", "特殊"]);
const isSpecial = (r) => SPECIAL_SKUS.has(String(r.sku == null ? "" : r.sku).trim());
// A "New" SKU cell marks a product not in Zoho yet: it files under the New
// Product channel (新品) and needs no catalogue item either (the user's rule).
const isNewProduct = (r) => /^new$/i.test(String(r.sku == null ? "" : r.sku).trim());
const channelOf = (r) => (isSpecial(r) ? "Special Order" : isNewProduct(r) ? "New Product" : null);

// The sheet mirror keeps the old copy of a row edited in the sheet (its
// creation fields — date, SKU, name, qty — identify it), so a record whose
// key is no longer in the sheet is stale. Same key as utils/purchaseOrderSync.
const sheetKey = (r) => [r.category || "", clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty == null ? "" : r.orderQty].join("||");
// A special order's name with the price and Chinese notes taken out — how
// two copies of the same row are told apart when there is no item to compare.
const specialName = (n) => String(n || "").replace(/[￥¥]\s*\d+(\.\d+)?/g, " ").replace(/[\u3400-\u9fff]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const linkKey = (tab, date, name) => [String(tab).trim(), date, String(name).replace(/\s+/g, " ").trim().toLowerCase()].join("|");

// ── args ──
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const APPLY = flag("--apply");
const INCLUDE_UNMATCHED = flag("--include-unmatched");
const SINCE = opt("--since", "2026-07-01");
const REPORT = opt("--report", path.join(__dirname, "..", "..", "tencent-import-report.xlsx"));
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error("--since must be YYYY-MM-DD"); process.exit(1); }

// ── helpers ──
const clean = (v) => String(v == null ? "" : v).trim();
const num = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;
// The sheet writes dates as YYYY-M-D strings.
const ymd = (s) => { const m = clean(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const dayDate = (y) => { if (!y) return null; const [Y, M, D] = y.split("-").map(Number); return new Date(Y, M - 1, D, 12); };
const mostCommon = (arr) => { const m = new Map(); for (const v of arr) if (v) m.set(v, (m.get(v) || 0) + 1); let best = null; for (const [k, n] of m) if (!best || n > best[1]) best = [k, n]; return best ? best[0] : null; };
const hist = (action, by, detail) => ({ at: new Date(), by, action, ...(detail ? { detail } : {}) });
// A real tracking number: digits / capitals, no spaces ("Follow kimi" is a note).
const looksLikeTracking = (t) => /^[A-Z0-9-]{6,}$/.test(t);

async function nextNo(db, key, prefix, start, coll) {
  const last = await db.collection(coll).find({}, { projection: { _id: 0, seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  const floor = Math.max(start - 1, (last[0] && last[0].seq) || 0);
  const r = await db.collection(COUNTERS).findOneAndUpdate(
    { _id: key },
    [{ $set: { seq: { $add: [{ $max: [{ $ifNull: ["$seq", 0] }, floor] }, 1] } } }],
    { upsert: true, returnDocument: "after" },
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return { seq: doc.seq, no: `${prefix}-${doc.seq}` };
}

(async () => {
  const db = await connectToDatabase();
  const now = new Date();

  // ── 1. the sheet rows still open ──
  // Read the sheet itself too, to leave out mirror copies it no longer has
  // (a dashboard PO not yet written to the sheet is not one of them).
  let sheetKeys = null;
  let sheetSiblings = null;
  let sheetRows = null;
  try {
    sheetRows = (await buildPurchaseOrderRecords()).records;
    sheetKeys = new Set(sheetRows.map(sheetKey));
    // tab + date + name, and tab + date + SKU: an edited row keeps one of them
    sheetSiblings = new Set(sheetRows.flatMap((t) => [
      ["n", t.category, clean(t.orderDate), clean(t.productName)].join("|"),
      ...(clean(t.sku) ? [["s", t.category, clean(t.orderDate), clean(t.sku)].join("|")] : []),
    ]));
  } catch (e) {
    console.warn("Could not read the Tencent sheet — stale copies are not filtered:", e.message || e);
  }
  // Without the sheet, the mirror's stale copies would import as orders —
  // a dry run may go on (it says so), an import may not.
  if (APPLY && !sheetKeys) {
    console.error("Import stopped: the Tencent sheet could not be read, so edited / removed rows cannot be told apart. Try again in a minute.");
    process.exit(1);
  }
  const mirror = await db.collection(SHEET).find({ status: { $ne: "received" } }).toArray();
  const isStale = (r) => !!sheetKeys && !sheetKeys.has(sheetKey(r)) && !(r.source === "dashboard" && r.tencentWritten === false);
  const stale = mirror.filter(isStale);
  // An old copy of a row since edited in the sheet (its newer version is in
  // the sheet and imports), or a row the sheet no longer has at all.
  const wasEdited = (r) => sheetSiblings.has(["n", r.category, clean(r.orderDate), clean(r.productName)].join("|")) ||
    (!!clean(r.sku) && sheetSiblings.has(["s", r.category, clean(r.orderDate), clean(r.sku)].join("|")));
  const staleEdited = stale.filter(wasEdited);
  const staleRemoved = stale.filter((r) => !wasEdited(r));
  const open = mirror.filter((r) => !isStale(r));
  // Undated rows (after the stale check, which compares the sheet's own
  // values): a date set by hand, else the best evidence in the sheet — the
  // row's own 下单时间, its 发货日期, or the nearest dated row above it in the
  // same tab (the sheet is filled top-down). The date is kept apart from the
  // sheet's, and the row comes in whatever --since says (the user wants every
  // open undated row across).
  const liveByKey = new Map();
  const tabRows = new Map();
  for (const t of sheetRows || []) {
    if (!liveByKey.has(sheetKey(t))) liveByKey.set(sheetKey(t), t);
    if (!tabRows.has(t.category)) tabRows.set(t.category, []);
    tabRows.get(t.category).push(t);
  }
  for (const list of tabRows.values()) list.sort((a, b) => Number(a.sourceRow) - Number(b.sourceRow));
  // The row's number in the live sheet: the mirror has none for a row added
  // from the dashboard, and a stale one once rows are inserted above it.
  for (const r of open) { const live = liveByKey.get(sheetKey(r)); if (live && live.sourceRow != null) r.__sheetRow = live.sourceRow; }
  const rowNo = (r) => (r.__sheetRow != null ? r.__sheetRow : r.sourceRow == null ? "" : r.sourceRow);
  const inferDate = (r) => {
    const live = liveByKey.get(sheetKey(r)) || r;
    if (ymd(live.orderedAt)) return { date: ymd(live.orderedAt), from: "下单时间" };
    if (ymd(live.shippedDate)) return { date: ymd(live.shippedDate), from: "发货日期" };
    let above = null;
    for (const t of tabRows.get(r.category) || []) {
      if (Number(t.sourceRow) >= Number(live.sourceRow)) break;
      if (ymd(t.orderDate)) above = t;
    }
    return above ? { date: ymd(above.orderDate), from: "row above", fromRow: above.sourceRow } : null;
  };
  const setDate = (r, y) => { const [Y, M, D] = y.split("-").map(Number); r.orderDate = `${Y}-${M}-${D}`; };
  for (const r of open) {
    if (ymd(r.orderDate)) continue;
    const o = DATE_OVERRIDES.find((d) => d.tab === clean(r.category) && d.sku === clean(r.sku));
    if (o) { setDate(r, o.date); r.__dateByHand = o.date; continue; }
    const inf = inferDate(r);
    if (inf) { setDate(r, inf.date); r.__dateInferred = inf; }
  }
  const dateSource = (r) => (r.__dateByHand ? "by hand" : r.__dateInferred ? (r.__dateInferred.from === "row above" ? `row above (${r.__dateInferred.fromRow})` : r.__dateInferred.from) : "sheet");
  const givenDate = (r) => !!(r.__dateByHand || r.__dateInferred);
  const undated = open.filter((r) => !ymd(r.orderDate));
  const dated = open.filter((r) => ymd(r.orderDate));
  const tooOld = dated.filter((r) => ymd(r.orderDate) < SINCE && !givenDate(r));
  const rows = dated.filter((r) => ymd(r.orderDate) >= SINCE || givenDate(r));

  // ── 2. what they refer to ──
  // By the sheet's Zoho item id; failing that, by a hand-made link.
  const linkSkus = [...new Set(MANUAL_LINKS.map((l) => l.sku))];
  const ids = [...new Set(rows.map((r) => clean(r.zoho_id)).filter(Boolean))];
  const items = await db.collection(ITEMS).find({ $or: [{ itemId: { $in: ids } }, { sku: { $in: linkSkus } }] }, { projection: { _id: 0, itemId: 1, sku: 1, name: 1, imageId: 1, classification: 1 } }).toArray();
  const itemById = new Map(items.map((i) => [String(i.itemId), i]));
  const itemBySku = new Map(items.map((i) => [String(i.sku), i]));
  const links = new Map(MANUAL_LINKS.map((l) => [linkKey(l.tab, l.date, l.name), l.sku]));
  const linkedItem = (r) => itemBySku.get(links.get(linkKey(clean(r.category), ymd(r.orderDate), clean(r.productName)))) || null;
  const itemFor = (r) => itemById.get(clean(r.zoho_id)) || linkedItem(r);
  const already = new Set((await db.collection(ORDERS).find({ "tencent.recId": { $in: rows.map((r) => String(r._id)) } }, { projection: { "tencent.recId": 1 } }).toArray()).map((o) => o.tencent.recId));

  // ── 3. duplicates (the user's rule: delete them) ──
  // The same item, tab, order date and quantity more than once — a sheet row
  // the mirror kept a stale copy of after an edit, or a dashboard PO that
  // also came back from the sheet. One row per group is imported: the one
  // furthest along (shipped > ordered > shortage > pending; a sheet row over
  // a dashboard-only copy). A second SHIPPED row in a different shipment is a
  // real second shipment and is imported too. The rest are skipped.
  const STAGE = { shipped: 4, ordered: 3, shortage: 2, pending: 1 };
  const eligible = (r) =>
    !already.has(String(r._id)) && !r.cancelled && r.status !== "cancelled" &&
    !CANCEL_WORDS.includes(clean(r.supplier)) && Math.round(num(r.orderQty) || 0) > 0 && (!!itemFor(r) || !!channelOf(r));
  const dupKey = (r) => {
    const it = itemFor(r);
    return [clean(r.category), it ? String(it.itemId) : channelOf(r) + ":" + specialName(r.productName), ymd(r.orderDate), Math.round(num(r.orderQty) || 0)].join("|");
  };
  const groups = new Map();
  for (const r of rows) {
    if (!eligible(r)) continue;
    const k = dupKey(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const dupOf = new Map(); // sheet record id → the row kept instead
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ranked = g.slice().sort((a, b) =>
      (STAGE[b.status] || 0) - (STAGE[a.status] || 0) ||
      Number(b.sourceRow != null) - Number(a.sourceRow != null) ||
      String(a._id).localeCompare(String(b._id)));
    const kept = [ranked[0]];
    for (const r of ranked.slice(1)) {
      const own = clean(r.dhlTracking);
      const separateShipment = r.status === "shipped" && own && kept.every((k) => k.status !== "shipped" || clean(k.dhlTracking) !== own);
      if (separateShipment) kept.push(r);
      else dupOf.set(String(r._id), ranked[0]);
    }
  }

  // ── 4. the plan: one entry per row ──

  const plan = [];
  for (const r of rows) {
    const p = { row: r, action: "import", skip: "", issues: [], t: null };
    const issue = (sev, type, msg) => p.issues.push({ sev, type, msg });
    const tab = clean(r.category);
    const supplierRaw = clean(r.supplier);
    const item = itemFor(r);
    if (item && !itemById.has(clean(r.zoho_id))) issue("info", "linked-by-hand", `no SKU in the sheet — linked by hand to ${item.sku} ${item.name}`);
    const skuRaw = clean(r.sku);
    const orderQty = Math.round(num(r.orderQty) || 0);

    if (already.has(String(r._id))) { p.action = "skip"; p.skip = "already imported"; plan.push(p); continue; }
    if (r.cancelled || r.status === "cancelled") { p.action = "skip"; p.skip = "cancelled"; plan.push(p); continue; }
    if (CANCEL_WORDS.includes(supplierRaw)) { p.action = "skip"; p.skip = `供应商 says "${supplierRaw}"`; issue("info", "cancelled-by-supplier-word", `供应商 cell "${supplierRaw}" → treated as cancelled, not imported`); plan.push(p); continue; }
    if (!(orderQty > 0)) { p.action = "skip"; p.skip = "no quantity"; issue("block", "no-quantity", "订货数量 is empty or 0"); plan.push(p); continue; }

    if (r.__dateByHand) issue("info", "date-set-by-hand", `no 订货日期 in the sheet — dated ${r.__dateByHand} by hand`);
    else if (r.__dateInferred) {
      const d = r.__dateInferred;
      issue("info", "date-inferred", d.from === "row above"
        ? `no 订货日期, 下单时间 or 发货日期 — dated ${d.date} from the nearest dated row above (row ${d.fromRow})`
        : `no 订货日期 — dated ${d.date} from its ${d.from}`);
    }
    const channel = channelOf(r);
    if (!item && !channel) {
      const why = !skuRaw ? "SKU cell is empty" : SKU_PLACEHOLDERS.has(skuRaw.toLowerCase()) ? `SKU cell is "${skuRaw}" (a placeholder)` : clean(r.zoho_id) ? "Zoho item id not in the register" : `SKU ${skuRaw} not found in Zoho`;
      if (INCLUDE_UNMATCHED) issue("check", "no-catalogue-item", `${why} — imported with NO item link (Stock Monitoring will not see it)`);
      else { p.action = "skip"; p.skip = "no catalogue item"; issue("block", "no-catalogue-item", `${why} — add the item to Zoho / put its SKU in the sheet, then re-run (or --include-unmatched)`); plan.push(p); continue; }
    }
    if (dupOf.has(String(r._id))) {
      const k = dupOf.get(String(r._id));
      p.action = "skip";
      p.skip = "duplicate";
      p.skipDetail = `same item, date and qty as ${k.sourceRow != null ? "sheet row " + k.sourceRow : "a dashboard PO"} (${k.status}), which is imported`;
      plan.push(p);
      continue;
    }

    // target line
    let status = r.status;
    let supplier = supplierRaw;
    let shortageNote = "";
    if (SHORTAGE_WORDS.includes(supplierRaw)) {
      supplier = "";
      // imported as a Shortage line — acceptable (the user's call), not reported
      if (status !== "shipped") { status = "shortage"; shortageNote = supplierRaw; }
    }
    // A source word in the 供应商 cell (库存 / 市场 / 淘宝) is acceptable (the
    // user's call): imported as the supplier text, not reported.
    if (r.shortage) { status = "shortage"; shortageNote = shortageNote || "shortage"; }

    let unitPrice = num(r.unitPrice);
    if (unitPrice != null && unitPrice <= 0) { issue("check", "zero-price", `采购单价 is ${unitPrice} — imported without a price`); unitPrice = null; }
    if (unitPrice != null) unitPrice = round2(unitPrice);

    const orderDate = ymd(r.orderDate);
    const orderedAt = status === "pending" ? null : dayDate(ymd(r.orderedAt) || orderDate);
    let shippedQty = null;
    let trackingKey = null;
    if (status === "shipped") {
      shippedQty = num(r.shippedQty);
      if (shippedQty == null || shippedQty <= 0) {
        issue("check", "shipped-no-qty", `marked shipped but 发货数量 is ${shippedQty == null ? "empty" : shippedQty} — imported as Ordered`);
        status = "ordered"; shippedQty = null;
      } else {
        shippedQty = Math.round(shippedQty);
        trackingKey = clean(r.dhlTracking) || "(none)";
        // No tracking is acceptable (the user's call): such lines share one
        // batch without a tracking number. A note in the DHL cell ("Follow
        // kimi") groups its lines into one batch and becomes the batch note —
        // acceptable too, not reported.
        // No 发货日期 is acceptable (the user's call): the batch takes its
        // lines' most common ship date, else the latest order date.
        // A short shipment is acceptable as it stands (the user's call): the
        // remainder is not re-created.
        // More shipped than ordered is acceptable (the user's call).
        // A shipped line without a unit price is fine for these sheet-era
        // shipments (the user's call) — not reported.
      }
    }
    // An ordered line without a supplier is acceptable (the user's call).

    // The item's own classification, unless it only says "Other" (or nothing
    // we know) — then the sheet tab says more: the 中框 tab's special-order
    // frames are Middle Frame, the 屏幕 tab's special-order screens Screen.
    const fromItem = item && CLASSIFICATIONS.includes(item.classification) && item.classification !== "Other" ? item.classification : null;
    const category = channel || CHANNEL_TABS[tab] || fromItem || TAB_CATEGORY[tab] || "Other";
    p.t = {
      itemId: item ? String(item.itemId) : null,
      sku: item ? clean(item.sku) : SKU_PLACEHOLDERS.has(skuRaw.toLowerCase()) ? "" : skuRaw,
      productName: item && item.name ? item.name : clean(r.productName),
      imageId: item ? item.imageId || null : null,
      category,
      orderQty,
      status,
      supplier,
      unitPrice,
      shortageNote,
      orderedAt,
      shippedQty,
      shippedDate: ymd(r.shippedDate),
      trackingKey,
      orderDate,
      note: clean(r.note),
    };
    plan.push(p);
  }

  const imports = plan.filter((p) => p.action === "import");
  // ── 5. shipment batches: one per tracking number ──
  const batchMap = new Map();
  for (const p of imports.filter((p) => p.t.status === "shipped")) {
    const k = p.t.trackingKey;
    if (!batchMap.has(k)) batchMap.set(k, { trackingKey: k, lines: [] });
    batchMap.get(k).lines.push(p);
  }
  const batches = [...batchMap.values()].map((b) => {
    const shippedDate = mostCommon(b.lines.map((p) => p.t.shippedDate)) || b.lines.map((p) => p.t.orderDate).sort().pop();
    const isNo = b.trackingKey !== "(none)" && looksLikeTracking(b.trackingKey);
    return {
      ...b,
      shippedDate,
      tracking: isNo ? b.trackingKey.replace(/\s+/g, "") : "",
      note: ["Imported from the Tencent sheet", !isNo && b.trackingKey !== "(none)" ? `DHL cell: ${b.trackingKey}` : ""].filter(Boolean).join(" · "),
      totalQty: b.lines.reduce((t, p) => t + p.t.shippedQty, 0),
      suppliers: [...new Set(b.lines.map((p) => p.t.supplier).filter(Boolean))],
    };
  }).sort((a, b) => a.shippedDate.localeCompare(b.shippedDate));

  // ── 6. apply ──
  let created = 0;
  let createdBatches = 0;
  if (APPLY) {
    const col = db.collection(ORDERS);
    // oldest first, so the SP numbers follow the order dates
    const ordered = imports.slice().sort((a, b) => a.t.orderDate.localeCompare(b.t.orderDate) || String(a.row.category).localeCompare(String(b.row.category)));
    for (const p of ordered) {
      const t = p.t;
      const { seq, no } = await nextNo(db, "order", "SP", 10001, ORDERS);
      const r = p.row;
      const doc = {
        orderNo: no,
        seq,
        itemId: t.itemId,
        sku: t.sku,
        productName: t.productName,
        imageId: t.imageId,
        category: t.category,
        orderQty: t.orderQty,
        note: t.note,
        status: t.status,
        quotedPrice: null,
        supplier: t.supplier,
        unitPrice: t.unitPrice,
        lineTotal: t.unitPrice != null ? round2(t.orderQty * t.unitPrice) : null,
        orderedAt: t.orderedAt,
        orderedBy: t.orderedAt ? BY : null,
        shippedQty: null,
        shippedAt: null,
        batchId: null,
        batchNo: "",
        tracking: "",
        receivedQty: null,
        receivedAt: null,
        receivedBy: null,
        shortageNote: t.shortageNote,
        cancelNote: "",
        source: "tencent",
        tencent: {
          recId: String(r._id),
          tab: clean(r.category),
          sourceRow: rowNo(r) === "" ? null : rowNo(r),
          orderDate: givenDate(r) ? "" : clean(r.orderDate),
          ...(r.__dateByHand ? { orderDateByHand: r.__dateByHand } : {}),
          ...(r.__dateInferred ? { orderDateInferred: r.__dateInferred } : {}),
          sku: clean(r.sku),
          productName: clean(r.productName),
          supplier: clean(r.supplier),
          status: r.status,
          dhlTracking: clean(r.dhlTracking),
          shippedDate: clean(r.shippedDate),
          importedAt: now,
        },
        createdAt: dayDate(t.orderDate),
        createdBy: BY,
        updatedAt: now,
        history: [hist("imported", BY, { from: "tencent", tab: clean(r.category), orderDate: t.orderDate, status: t.status })],
      };
      const ins = await col.insertOne(doc);
      p.orderId = ins.insertedId;
      p.orderNo = no;
      created++;
      await db.collection(SHEET).updateOne({ _id: r._id }, { $set: { migratedTo: no, migratedAt: now } });
    }
    for (const b of batches) {
      const { seq, no: batchNo } = await nextNo(db, "batch", "PB", 10001, BATCHES);
      const batchId = new ObjectId();
      const shippedAt = dayDate(b.shippedDate);
      const lines = [];
      for (const p of b.lines) {
        const t = p.t;
        await col.updateOne(
          { _id: p.orderId },
          {
            $set: { status: "shipped", shippedQty: t.shippedQty, shippedAt, batchId, batchNo, tracking: b.tracking, updatedAt: now },
            $push: { history: hist("shipped", BY, { batchNo, shippedQty: t.shippedQty, ...(t.shippedQty < t.orderQty ? { short: t.orderQty - t.shippedQty, remainderTo: null } : {}) }) },
          },
        );
        lines.push({
          orderId: p.orderId,
          orderNo: p.orderNo,
          itemId: t.itemId,
          sku: t.sku,
          productName: t.productName,
          category: t.category,
          supplier: t.supplier,
          orderQty: t.orderQty,
          shippedQty: t.shippedQty,
          unitPrice: t.unitPrice,
          receivedQty: null,
          prevStatus: "ordered",
        });
        p.batchNo = batchNo;
      }
      await db.collection(BATCHES).insertOne({
        _id: batchId,
        batchNo,
        seq,
        status: "shipped",
        tracking: b.tracking,
        shippedAt,
        note: b.note,
        zohoVendorId: "",
        zohoVendorName: "",
        // the sheet-era shipments had their Zoho PO raised by hand
        zoho: { status: "skipped", pos: [], skipped: [], errors: [], note: "Tencent-era shipment: Zoho PO made outside the module" },
        lines,
        lineCount: lines.length,
        totalQty: b.totalQty,
        source: "tencent",
        createdAt: shippedAt,
        createdBy: BY,
        receivedAt: null,
        receivedBy: null,
        receiveNote: "",
        discrepancy: false,
      });
      createdBatches++;
    }
  }

  // ── 7. the report ──
  const count = (arr, f) => { const m = {}; for (const x of arr) { const k = String(f(x)); m[k] = (m[k] || 0) + 1; } return m; };
  const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
  const skipped = plan.filter((p) => p.action === "skip");
  const blocks = plan.filter((p) => p.issues.some((i) => i.sev === "block"));
  const checks = plan.filter((p) => p.action === "import" && p.issues.some((i) => i.sev === "check"));
  const summary = [
    ["Tencent → Spare Parts Purchase import", APPLY ? "APPLIED " + now.toISOString() : "DRY RUN " + now.toISOString()],
    [],
    ["Scope", `not yet received, 订货日期 on/after ${SINCE}`],
    ["Open rows in the sheet mirror", mirror.length],
    ["  excluded: older copy of a row edited in the sheet", sheetKeys ? staleEdited.length + " (the edited version is read instead)" : "not checked — the sheet could not be read"],
    ["  excluded: removed from the sheet", sheetKeys ? staleRemoved.length + " (see sheet Excluded)" : "not checked — the sheet could not be read"],
    ["  no 订货日期, dated from the sheet", kv(count(open.filter((r) => r.__dateInferred), (r) => r.__dateInferred.from)) || "0"],
    ["  no 订货日期, dated by hand", open.filter((r) => r.__dateByHand).length],
    ["  excluded: no 订货日期", undated.length + (undated.length ? " (nothing in the sheet to date them by — see sheet Excluded)" : "")],
    ["  excluded: before " + SINCE, tooOld.length],
    ["  in scope", rows.length],
    [],
    ["Will import", imports.length + (APPLY ? ` (created ${created})` : "")],
    ["  by status", kv(count(imports, (p) => p.t.status))],
    ["  by category", kv(count(imports, (p) => p.t.category))],
    ["  by month", kv(count(imports, (p) => p.t.orderDate.slice(0, 7)))],
    ["  pieces", imports.reduce((t, p) => t + p.t.orderQty, 0)],
    ["Shipment batches", batches.length + (APPLY ? ` (created ${createdBatches})` : "") + " — one per tracking number, no Zoho PO"],
    [],
    ["Skipped (not imported)", skipped.length],
    ["  reasons", kv(count(skipped, (p) => p.skip))],
    ["Rows needing a fix before they import (block)", blocks.length],
    ["Rows imported but worth a look (check)", checks.length],
    ["  issue types", kv(count(plan.flatMap((p) => p.issues.filter((i) => i.sev !== "info")), (i) => i.type))],
    [],
    ["How to use", "Fix in the Tencent sheet (SKU, 供应商, 发货数量…), let the daily sync refresh the mirror (or Refresh on the old Purchase Order page), re-run this dry run; when happy run with --apply. Re-running --apply never imports the same sheet row twice."],
  ];
  const issuesRows = [["Severity", "Issue", "Tab", "Sheet row", "订货日期", "SKU", "Product", "Qty", "Sheet status", "供应商", "Will become", "Detail"]];
  const sevRank = { block: 0, check: 1, info: 2 };
  for (const p of plan.slice().sort((a, b) => Math.min(...a.issues.map((i) => sevRank[i.sev]), 9) - Math.min(...b.issues.map((i) => sevRank[i.sev]), 9))) {
    for (const i of p.issues) {
      const r = p.row;
      issuesRows.push([i.sev, i.type, clean(r.category), rowNo(r), clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty, r.status, clean(r.supplier), p.action === "skip" ? `skipped: ${p.skip}` : p.t.status + (p.t.trackingKey ? ` (batch ${p.t.trackingKey})` : ""), i.msg]);
    }
  }
  const linesRows = [["Tab", "Sheet row", "订货日期", "Date from", "SKU", "Product (module)", "Sheet 品名", "Category", "Qty", "Status", "供应商", "Unit price", "Shipped qty", "Batch (tracking)", "Ship date", "Item id", "Note", "Issues", ...(APPLY ? ["Order no", "Batch no"] : [])]];
  for (const p of imports.slice().sort((a, b) => a.t.orderDate.localeCompare(b.t.orderDate))) {
    const r = p.row, t = p.t;
    linesRows.push([clean(r.category), rowNo(r), t.orderDate, dateSource(r), t.sku, t.productName, clean(r.productName), t.category, t.orderQty, t.status, t.supplier, t.unitPrice == null ? "" : t.unitPrice, t.shippedQty == null ? "" : t.shippedQty, t.trackingKey || "", t.shippedDate || "", t.itemId || "", t.note || "", p.issues.map((i) => i.type).join(", "), ...(APPLY ? [p.orderNo || "", p.batchNo || ""] : [])]);
  }
  const batchRows = [["Tracking", "Ship date", "Lines", "Pieces", "Suppliers", "Note", ...(APPLY ? ["Batch no"] : [])]];
  for (const b of batches) batchRows.push([b.trackingKey, b.shippedDate, b.lines.length, b.totalQty, b.suppliers.join(", "), b.note, ...(APPLY ? [b.lines[0].batchNo || ""] : [])]);
  const exclRows = [["Why", "Tab", "Sheet row", "订货日期", "SKU", "Product", "Qty", "Sheet status", "供应商", "DHL", "发货数量"]];
  for (const r of stale) exclRows.push([wasEdited(r) ? "older copy of a row edited in the sheet" : "removed from the sheet", clean(r.category), rowNo(r), clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty, r.status, clean(r.supplier), clean(r.dhlTracking), r.shippedQty == null ? "" : r.shippedQty]);
  for (const r of tooOld) exclRows.push(["订货日期 before " + SINCE, clean(r.category), rowNo(r), clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty, r.status, clean(r.supplier), clean(r.dhlTracking), r.shippedQty == null ? "" : r.shippedQty]);
  for (const r of undated) exclRows.push(["no 订货日期", clean(r.category), rowNo(r), clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty, r.status, clean(r.supplier), clean(r.dhlTracking), r.shippedQty == null ? "" : r.shippedQty]);
  for (const p of skipped) { const r = p.row; exclRows.push([`skipped: ${p.skip}${p.skipDetail ? " — " + p.skipDetail : ""}`, clean(r.category), rowNo(r), clean(r.orderDate), clean(r.sku), clean(r.productName), r.orderQty, r.status, clean(r.supplier), clean(r.dhlTracking), r.shippedQty == null ? "" : r.shippedQty]); }

  const wb = XLSX.utils.book_new();
  const addSheet = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = widths.map((w) => ({ wch: w }));
    const head = XLSX.utils.decode_range(ws["!ref"]);
    for (let c = head.s.c; c <= head.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: "F2F2F2" } } };
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  addSheet("Summary", summary, [44, 110]);
  addSheet("Issues", issuesRows, [8, 22, 14, 9, 11, 12, 60, 6, 10, 12, 26, 90]);
  addSheet("Lines", linesRows, [14, 9, 11, 16, 12, 60, 50, 12, 6, 9, 12, 10, 11, 16, 11, 20, 30, 30, ...(APPLY ? [10, 10] : [])]);
  addSheet("Batches", batchRows, [16, 11, 6, 8, 40, 50, ...(APPLY ? [10] : [])]);
  addSheet("Excluded", exclRows, [30, 14, 9, 11, 12, 60, 6, 10, 12, 16, 8]);
  XLSX.writeFile(wb, REPORT);

  // ── 8. console summary ──
  for (const [k, v] of summary) if (k) console.log(String(k).padEnd(46), v == null ? "" : v);
  console.log("\nreport:", REPORT);
  process.exit(0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
