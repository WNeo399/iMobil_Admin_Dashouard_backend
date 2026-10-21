// Australia Post Shipping & Tracking API (Exyon's eParcel contract account,
// 2026-10-21) — Exyon Accessories' shipping labels for Large / Other envelopes.
// Env: EXYON_POST_API_URL (…/shipping/v1, production), EXYON_POST_API_KEY +
// EXYON_POST_API_PASSWORD (HTTP Basic), EXYON_ACC_NO (the `account-number`
// header). Never logged.
//
//   POST /shipments        → shipment_id + the article id (the tracking number)
//   POST /labels           → a label PDF url (A6 thermal, 100 × 150)
//   DELETE /shipments/{id} → only before the shipment is lodged (in an order)
//   POST /prices/shipments → checks a shipment and prices it, creates nothing
// Lodging (POST /orders, the day's manifest) is NOT done from here (user
// 2026-10-21): the warehouse lodges in AusPost as before.

const BASE = () => String(process.env.EXYON_POST_API_URL || "").replace(/\/+$/, "");
const configured = () => !!(process.env.EXYON_POST_API_URL && process.env.EXYON_POST_API_KEY && process.env.EXYON_POST_API_PASSWORD && process.env.EXYON_ACC_NO);

// the sender on every label (user 2026-10-21, as on their eParcel labels)
const SENDER = { name: "Exyon", business_name: "Exyon Pty Ltd", lines: ["P.O. Box 371"], suburb: "ENDEAVOUR HILLS", state: "VIC", postcode: "3802" };
// the parcel unless changed per order (user 2026-10-21): Parcel Post with
// Authority to Leave (3D55 — the account's product), 0.49 kg, 30 × 25 × 5 cm
const DEFAULT_PARCEL = { productId: "3D55", weight: 0.49, length: 30, width: 25, height: 5 };
const PRODUCTS = { "3D55": "Parcel Post", "3J55": "Express Post" };
// the A6 thermal label for both domestic groups
const LABEL_GROUPS = ["Parcel Post", "Express Post"].map((group) => ({ group, layout: "THERMAL-LABEL-A6-1PP", branded: true, left_offset: 0, top_offset: 0 }));

class AusPostError extends Error {}

async function call(method, path, body) {
  if (!configured()) throw new AusPostError("Australia Post isn't set up (EXYON_POST_API_* / EXYON_ACC_NO)");
  const auth = "Basic " + Buffer.from(`${process.env.EXYON_POST_API_KEY}:${process.env.EXYON_POST_API_PASSWORD}`).toString("base64");
  const r = await fetch(BASE() + path, {
    method,
    headers: { Authorization: auth, "account-number": process.env.EXYON_ACC_NO, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const errs = (data && data.errors) || [];
    const msg = errs.length ? errs.map((e) => e.message || e.name).join("; ") : `HTTP ${r.status}`;
    throw new AusPostError(`Australia Post: ${msg}`.split(process.env.EXYON_ACC_NO).join("<account>"));
  }
  return data;
}

// "+61 416 665 397" → "0416665397"; AusPost takes digits
const phoneOf = (p) => String(p || "").replace(/[^\d+]/g, "").replace(/^\+61/, "0").replace(/\D/g, "").slice(0, 20);

// One shipment: the order's delivery address (Neto), its references on the
// label (the order number, then "1 x iSh6004 …"), the parcel.
function shipmentOf({ orderId, to, items, deliveryInstructions, parcel }) {
  const p = { ...DEFAULT_PARCEL, ...(parcel || {}) };
  const what = (items || []).map((it) => `${Number(it.quantity) || 1} x ${it.sku}`).join(", ");
  return {
    shipment_reference: String(orderId).slice(0, 50),
    sender_references: [String(orderId).slice(0, 50), what.slice(0, 50)].filter(Boolean),
    from: SENDER,
    to: {
      name: String(to.name || "").slice(0, 40),
      ...(to.company ? { business_name: String(to.company).slice(0, 40) } : {}),
      lines: [to.street1, to.street2].map((x) => String(x || "").trim()).filter(Boolean).map((x) => x.slice(0, 40)),
      suburb: String(to.city || "").trim(),
      state: String(to.state || "").trim(),
      postcode: String(to.postcode || "").trim(),
      ...(phoneOf(to.phone) ? { phone: phoneOf(to.phone) } : {}),
      ...(deliveryInstructions ? { delivery_instructions: String(deliveryInstructions).replace(/\s+/g, " ").trim().slice(0, 128) } : {}),
    },
    items: [{
      item_reference: String(orderId).slice(0, 50),
      product_id: p.productId,
      weight: Number(p.weight),
      length: Number(p.length),
      width: Number(p.width),
      height: Number(p.height),
      authority_to_leave: true,
      allow_partial_delivery: true,
    }],
  };
}

// → { shipmentId, articleId, consignmentId, cost }
async function createShipment(shipment) {
  const d = await call("POST", "/shipments", { shipments: [shipment] });
  const s = (d.shipments || [])[0] || {};
  const item = (s.items || [])[0] || {};
  const t = item.tracking_details || {};
  if (!s.shipment_id || !t.article_id) throw new AusPostError("Australia Post made no shipment");
  return {
    shipmentId: String(s.shipment_id),
    articleId: String(t.article_id),
    consignmentId: String(t.consignment_id || ""),
    cost: s.shipment_summary ? s.shipment_summary.total_cost : null,
  };
}

// a price check — the same shipment, nothing created → { cost, costExGst }
async function priceShipment(shipment) {
  const d = await call("POST", "/prices/shipments", { shipments: [shipment] });
  const s = (d.shipments || [])[0] || {};
  const sum = s.shipment_summary || {};
  return { cost: sum.total_cost == null ? null : sum.total_cost, costExGst: sum.total_cost_ex_gst == null ? null : sum.total_cost_ex_gst };
}

// One PDF of the labels for these shipments → Buffer. Waits for AusPost to
// render it (asked to wait; a PENDING one is polled a few times).
async function labelsPdf(shipmentIds) {
  const d = await call("POST", "/labels", {
    wait_for_label_url: true,
    preferences: [{ type: "PRINT", format: "PDF", groups: LABEL_GROUPS }],
    shipments: shipmentIds.map((id) => ({ shipment_id: id })),
  });
  let label = (d.labels || [])[0] || {};
  for (let i = 0; i < 8 && label.status !== "AVAILABLE" && label.request_id; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const again = await call("GET", `/labels/${encodeURIComponent(label.request_id)}`);
    label = (again.labels || [])[0] || label;
  }
  if (label.status !== "AVAILABLE" || !label.url) throw new AusPostError(`Australia Post: the label isn't ready (${label.status || "no answer"}) — try Reprint in a moment`);
  const r = await fetch(label.url, { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new AusPostError(`Australia Post: the label file didn't download (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// before it is lodged only (AusPost refuses one already in an order)
async function deleteShipment(shipmentId) {
  await call("DELETE", `/shipments/${encodeURIComponent(shipmentId)}`);
}

module.exports = { configured, SENDER, DEFAULT_PARCEL, PRODUCTS, shipmentOf, createShipment, priceShipment, labelsPdf, deleteShipment, AusPostError };
