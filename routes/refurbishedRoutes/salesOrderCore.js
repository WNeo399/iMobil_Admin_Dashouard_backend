// Shared pieces of a refurbished sales order.
//
// Two routes create orders: salesOrders.js (selling devices already in the
// register) and incoming.js (selling straight off a supplier shipment, where
// the device record and the order are created together). The numbering,
// the line snapshot and the currency vocabulary must match exactly between
// them, so they live here rather than in either route.

const ORDERS = "refurb_sales_orders";
const CURRENCIES = ["AUD", "CNY", "HKD"];
const DEFAULT_CURRENCY = "AUD";

function normalizeCurrency(v) {
  const c = String(v == null ? "" : v).trim().toUpperCase();
  return CURRENCIES.includes(c) ? c : DEFAULT_CURRENCY;
}

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Next number = highest ever issued + 1 (NOT count+1, which would reuse a
// number after a delete). Numbering starts at RSO-10001.
async function nextOrderNumber(db) {
  const last = await db.collection(ORDERS).find({}).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max((last[0] && last[0].seq) || 0, 10000) + 1;
  return { seq, orderNo: `RSO-${seq}` };
}

// Orders carry a snapshot of each device so the paperwork survives later
// edits (or deletion) of the device record.
function deviceLine(device, price) {
  return {
    deviceId: device._id,
    imei: device.imei,
    serialNumber: device.serialNumber || "",
    // Brand feeds the invoice description ("APPLE IPHONE SE G2 64GB …").
    brand: device.brand || "",
    model: device.model || "",
    color: device.color || "",
    storage: device.storage || "",
    grade: device.grade || "",
    batteryHealth: device.batteryHealth == null ? null : device.batteryHealth,
    price: num(price),
  };
}

function sumLines(lines) {
  return Math.round(lines.reduce((s, l) => s + (l.price || 0), 0) * 100) / 100;
}

// Line prices are entered EX-GST; GST is added on top. The rate is stored on
// the order (not assumed at read time) so historic paperwork keeps the rate
// it was raised under, and so GST-free sales — exports, non-AUD invoices —
// simply carry 0.
const GST_RATE = 0.1;

function normalizeGstRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1);
}

function computeTotals(lines, gstRate) {
  const subTotal = sumLines(lines);
  const rate = normalizeGstRate(gstRate);
  const gstAmount = Math.round(subTotal * rate * 100) / 100;
  return {
    subTotal,
    gstRate: rate,
    gstAmount,
    total: Math.round((subTotal + gstAmount) * 100) / 100,
  };
}

module.exports = {
  ORDERS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  normalizeCurrency,
  nextOrderNumber,
  deviceLine,
  sumLines,
  GST_RATE,
  normalizeGstRate,
  computeTotals,
  num,
};
