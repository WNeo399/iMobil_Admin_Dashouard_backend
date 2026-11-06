// Embed Ordering — widget orders (Mongo: embed_ordering_orders), shared by the public
// widget routes (widget.js: customers place orders, see their own) and the
// dashboard's Orders page (orders.js: iMobile staff work them).
//
// Demo scope (user, 2026-11-06): no prices, nothing goes to Zoho or InFlow —
// an order is a list of parts and quantities that stays in the dashboard.
// Each order keeps snapshots of the parts, the customer and the distributor
// so it reads the same after any of them change.

const ORDERS = "embed_ordering_orders";
const PREFIX = "EO-";
const FIRST_SEQ = 10001;

const STATUSES = ["new", "processing", "completed", "cancelled"];
const STATUS_LABELS = { new: "New", processing: "Processing", completed: "Completed", cancelled: "Cancelled" };
// Where an order may go next. Cancelled can be reopened (back to New).
const TRANSITIONS = {
  new: ["processing", "cancelled"],
  processing: ["completed", "cancelled"],
  completed: [],
  cancelled: ["new"],
};

let _indexed = false;
async function ensureOrderIndexes(db) {
  if (_indexed) return;
  try {
    const col = db.collection(ORDERS);
    await col.createIndex({ orderNo: 1 }, { unique: true, name: "order_no_unique" });
    // A double click / retry of the same checkout can't make two orders.
    await col.createIndex({ customerId: 1, clientOrderId: 1 }, { unique: true, name: "customer_client_order_unique" });
    await col.createIndex({ distributorId: 1, createdAt: -1 }, { name: "distributor_created" });
    await col.createIndex({ status: 1, createdAt: -1 }, { name: "status_created" });
    _indexed = true;
  } catch (e) {
    console.warn("Embed Ordering order indexes not created:", (e && e.message) || e);
  }
}

// Highest number + 1; the unique index on orderNo catches two orders racing
// for the same number (the caller retries).
async function nextOrderNo(db) {
  const last = await db.collection(ORDERS).find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max(((last[0] && last[0].seq) || FIRST_SEQ - 1) + 1, FIRST_SEQ);
  return { seq, orderNo: PREFIX + seq };
}

// What the customer sees of an order in the widget — no stock figures, no
// staff notes, no history.
function customerView(o) {
  return {
    orderNo: o.orderNo,
    createdAt: o.createdAt,
    status: o.status,
    statusLabel: STATUS_LABELS[o.status] || o.status,
    reference: o.reference || "",
    note: o.note || "",
    deliveryAddress: o.deliveryAddress || null,
    units: o.units || 0,
    lines: (o.lines || []).map((l) => ({
      itemId: l.itemId,
      sku: l.sku,
      name: l.name,
      quality: l.quality,
      imageId: l.imageId,
      qty: l.qty,
    })),
  };
}

module.exports = { ORDERS, STATUSES, STATUS_LABELS, TRANSITIONS, ensureOrderIndexes, nextOrderNo, customerView };
