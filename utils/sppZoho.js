// Zoho Inventory purchase orders for Spare Parts Purchase batches.
//
// A batch shipping to iMobile is what a Zoho PO records (stage 2 of the
// purchase pipeline — our SP- lines are stage 1). The user picks the Zoho
// vendor when the batch is made, from the three purchase accounts below
// (2026-09-22), and the whole batch becomes ONE Zoho PO under it. Rates are
// our CNY unit prices, sent when the vendor's currency is CNY (all three
// are). Lines without a Zoho item id cannot go on a Zoho PO and are
// reported as skipped.
//
// Everything here is non-fatal for the batch: the outcome is stored on the
// batch (`zoho`) and can be retried from the Batches page.

const { handleZohoInventoryRequest, handleZohoInventoryPostRequest, refreshToken } = require("./zohoRequest");

const ORG = "746138234";
const BASE = "https://www.zohoapis.com/inventory/v1";
const VENDOR_TTL_MS = 60 * 60 * 1000;

// The Zoho vendors a batch may be booked to (the user's list). A test
// vendor can be added for a local run with SPP_ZOHO_TEST_VENDOR_ID.
const ZOHO_VENDORS = [
  { id: "2591985000020923350", name: "V-Pro CNY" },
  { id: "2591985000024788728", name: "IMB-P01 CNY" },
  { id: "2591985000042771011", name: "IMB-P02 CNY" },
  ...(process.env.SPP_ZOHO_TEST_VENDOR_ID ? [{ id: String(process.env.SPP_ZOHO_TEST_VENDOR_ID), name: "TEST VENDOR" }] : []),
];
const vendorById = (id) => ZOHO_VENDORS.find((v) => v.id === String(id || "")) || null;

let vendorCache = { at: 0, list: [] };

// Every Zoho vendor (79 at the time of writing — one page), cached an hour.
async function loadVendors(force) {
  if (!force && vendorCache.list.length && Date.now() - vendorCache.at < VENDOR_TTL_MS) return vendorCache.list;
  const list = [];
  for (let page = 1; page <= 5; page++) {
    const r = await handleZohoInventoryRequest(`${BASE}/contacts?organization_id=${ORG}&contact_type=vendor&per_page=200&page=${page}`);
    const rows = (r && r.contacts) || [];
    for (const c of rows) list.push({ id: String(c.contact_id), name: String(c.contact_name || ""), currency: String(c.currency_code || "") });
    if (!(r && r.page_context && r.page_context.has_more_page)) break;
  }
  if (list.length) vendorCache = { at: Date.now(), list };
  return list;
}

const norm = (s) => String(s || "").trim().toLowerCase();

// Every line needs a tax: the team's purchase orders all carry the org's
// GST (10%), so ours do too. Looked up by name, cached like the vendors.
let gstCache = { at: 0, id: "" };
async function gstTaxId() {
  if (gstCache.id && Date.now() - gstCache.at < VENDOR_TTL_MS) return gstCache.id;
  const r = await handleZohoInventoryRequest(`${BASE}/settings/taxes?organization_id=${ORG}`);
  const gst = ((r && r.taxes) || []).find((t) => norm(t.tax_name) === "gst" && t.tax_type === "tax") || ((r && r.taxes) || []).find((t) => Number(t.tax_percentage) === 10);
  if (!gst) throw new Error("GST tax not found in Zoho settings");
  gstCache = { at: Date.now(), id: String(gst.tax_id) };
  return gstCache.id;
}

const ymd = (d) => {
  const x = d instanceof Date ? d : new Date(d || Date.now());
  return isNaN(x.getTime()) ? new Date().toISOString().slice(0, 10) : x.toISOString().slice(0, 10);
};

// Create the Zoho PO for a batch under the vendor picked on it. `existing`
// (batch.zoho) lets a retry skip when the PO is already there. Returns the
// new `zoho` summary to store on the batch.
async function createBatchPurchaseOrders(db, batch, existing) {
  const done = new Map(((existing && existing.pos) || []).filter((p) => p.purchaseorderId).map((p) => [p.vendorId, p]));
  const result = { at: new Date(), status: "ok", pos: [...done.values()], skipped: [], errors: [] };
  try {
    const picked = vendorById(batch.zohoVendorId);
    if (!picked) throw new Error("No Zoho vendor picked for this batch");
    await refreshToken();
    const taxId = await gstTaxId();
    // currency from Zoho's own record when we can read it; the three
    // accounts are CNY, so that is the assumption otherwise
    const live = (await loadVendors(false).catch(() => [])).find((v) => v.id === picked.id);
    const vendor = { id: picked.id, name: (live && live.name) || picked.name, currency: (live && live.currency) || "CNY" };

    const lines = [];
    for (const l of batch.lines || []) {
      if (!l.itemId) { result.skipped.push({ sku: l.sku, productName: l.productName, reason: "no Zoho item" }); continue; }
      lines.push(l);
    }
    const groups = new Map(lines.length ? [[vendor.id, { vendor, lines }]] : []);

    for (const [vendorId, g] of groups) {
      if (done.has(vendorId)) continue;
      const cny = g.vendor.currency === "CNY";
      const body = {
        vendor_id: vendorId,
        date: ymd(batch.shippedAt),
        reference_number: batch.batchNo,
        notes: [
          `Spare Parts Purchase ${batch.batchNo}`,
          batch.tracking ? `Tracking ${batch.tracking}` : "",
          [...new Set(g.lines.map((l) => l.supplier).filter(Boolean))].length ? `Suppliers: ${[...new Set(g.lines.map((l) => l.supplier).filter(Boolean))].join(", ")}` : "",
          batch.note || "",
        ].filter(Boolean).join("\n"),
        line_items: g.lines.map((l) => {
          const li = { item_id: String(l.itemId), quantity: Number(l.shippedQty) || 0, tax_id: taxId };
          if (cny && l.unitPrice != null && Number.isFinite(Number(l.unitPrice))) li.rate = Number(l.unitPrice);
          return li;
        }),
      };
      const r = await handleZohoInventoryPostRequest(`${BASE}/purchaseorders?organization_id=${ORG}`, body);
      if (!r || r.code !== 0 || !r.purchaseorder) {
        result.errors.push({ vendorId, vendorName: g.vendor.name, message: (r && r.message) || "Zoho did not create the purchase order" });
        continue;
      }
      const po = r.purchaseorder;
      // Issued, not draft: the goods are already on their way.
      let issued = false;
      try {
        const s = await handleZohoInventoryPostRequest(`${BASE}/purchaseorders/${po.purchaseorder_id}/status/issued?organization_id=${ORG}`, {});
        issued = !!(s && s.code === 0);
      } catch (e) { /* stays draft — still a PO */ }
      result.pos.push({
        vendorId,
        vendorName: g.vendor.name,
        currency: g.vendor.currency,
        purchaseorderId: String(po.purchaseorder_id),
        number: po.purchaseorder_number,
        lines: g.lines.length,
        qty: g.lines.reduce((t, l) => t + (Number(l.shippedQty) || 0), 0),
        total: po.total != null ? po.total : null,
        issued,
      });
    }
  } catch (e) {
    result.errors.push({ message: (e && e.message) || String(e) });
  }
  result.status = result.errors.length ? (result.pos.length ? "partial" : "error") : result.pos.length ? "ok" : "skipped";
  return result;
}

// A cancelled batch cancels its Zoho PO(s) too (marked cancelled, not
// deleted — our token may not delete, and a cancelled PO keeps the trail).
// Returns what Zoho refused.
async function cancelBatchPurchaseOrders(batch) {
  const pos = (batch.zoho && batch.zoho.pos) || [];
  const failed = [];
  if (!pos.length) return failed;
  try { await refreshToken(); } catch (e) { /* the call refreshes reactively too */ }
  for (const p of pos) {
    if (!p.purchaseorderId) continue;
    try {
      const r = await handleZohoInventoryPostRequest(`${BASE}/purchaseorders/${p.purchaseorderId}/status/cancelled?organization_id=${ORG}`, {});
      if (!r || r.code !== 0) failed.push({ number: p.number, message: (r && r.message) || "Zoho refused the cancel" });
    } catch (e) {
      failed.push({ number: p.number, message: (e && e.message) || String(e) });
    }
  }
  return failed;
}

module.exports = { createBatchPurchaseOrders, cancelBatchPurchaseOrders, loadVendors, ZOHO_VENDORS, vendorById };
