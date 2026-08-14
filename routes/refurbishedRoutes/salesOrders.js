// Refurbished Device — Sales Orders (Mongo: refurb_sales_orders).
//
// Sells devices out of the stock register to a customer. An order carries a
// snapshot of each device line (so history survives later edits) and a per-
// line sale price. Creating an order marks the devices Sold; cancelling it
// puts them back In Stock. Numbering is RSO-10001+ (highest seq + 1, never
// count+1, so a number is never reused after a delete).
//
//   GET  /refurbished/sales-orders          paginated list
//   GET  /refurbished/sales-orders/:id      one order
//   POST /refurbished/sales-orders          create (marks devices Sold)
//   POST /refurbished/sales-orders/:id/cancel  cancel (restores devices)
//
// Reading needs refurb:sale:view, writing refurb:sale:manage — both covered
// by refurb:*:* (iMobile Admin) and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const {
  ORDERS,
  normalizeCurrency,
  nextOrderNumber,
  deviceLine,
  computeTotals,
  num,
} = require("./salesOrderCore");

const VIEW = requirePermission("refurb:sale:view");
const MANAGE = requirePermission("refurb:sale:manage");
const DEVICES = "refurb_devices";
const CUSTOMERS = "refurb_customers";

const MAX_LINES = 200;

// An order starts Pending and is locked once Confirmed — only a Pending
// order can be edited. Cancelled is the void state either can fall into;
// it returns the devices to stock and is final.
const STATUS_PENDING = "Pending";
const STATUS_CONFIRMED = "Confirmed";
const STATUS_CANCELLED = "Cancelled";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function actor(req) {
  return (req.user && req.user.username) || null;
}

// Matches the device-history entries the Stock page timeline renders.
function historyEntry(req, action) {
  return { at: new Date(), by: actor(req), action };
}

// ── GET /refurbished/sales-orders ───────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);
    const db = await connectToDatabase();

    const query = {};
    if (req.query.status) query.status = String(req.query.status);
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ orderNo: re }, { customerName: re }, { "lines.imei": re }];
    }

    const col = db.collection(ORDERS);
    const [orders, total] = await Promise.all([
      col
        .find(query)
        .sort({ seq: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      col.countDocuments(query),
    ]);
    return res.json({ success: true, orders, total });
  } catch (e) {
    console.error("List refurb sales orders error:", e);
    return res.status(500).json({ success: false, message: "Failed to load sales orders" });
  }
});

// ── GET /refurbished/sales-orders/:id ───────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    return res.json({ success: true, order });
  } catch (e) {
    console.error("Get refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the sales order" });
  }
});

// Validate + normalise the { lines: [{deviceId, price}] } part of a body.
// Returns { error } or { deviceIds, priceById }.
function parseLines(rawLines) {
  if (!Array.isArray(rawLines) || !rawLines.length) {
    return { error: "Add at least one device" };
  }
  if (rawLines.length > MAX_LINES) {
    return { error: `Too many devices (max ${MAX_LINES})` };
  }
  const deviceIds = [];
  const priceById = new Map();
  for (const l of rawLines) {
    if (!l || !ObjectId.isValid(l.deviceId)) return { error: "Bad device id in lines" };
    const idStr = String(l.deviceId);
    if (priceById.has(idStr)) return { error: "A device appears twice in the order" };
    priceById.set(idStr, num(l.price));
    deviceIds.push(new ObjectId(idStr));
  }
  return { deviceIds, priceById };
}

// ── POST /refurbished/sales-orders ──────────────────────────────────
// Body: { customerId, currency, notes, lines: [{ deviceId, price }] }
router.post("/", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    const customerId = ObjectId.isValid(body.customerId) ? new ObjectId(body.customerId) : null;
    if (!customerId) {
      return res.status(400).json({ success: false, message: "A customer is required" });
    }
    const currency = normalizeCurrency(body.currency);
    const parsed = parseLines(body.lines);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { deviceIds, priceById } = parsed;

    const db = await connectToDatabase();
    const customer = await db.collection(CUSTOMERS).findOne({ _id: customerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const devices = await db
      .collection(DEVICES)
      .find({ _id: { $in: deviceIds } })
      .toArray();
    if (devices.length !== deviceIds.length) {
      return res.status(400).json({ success: false, message: "A selected device no longer exists" });
    }
    const alreadySold = devices.filter((d) => d.status === "Sold");
    if (alreadySold.length) {
      return res.status(400).json({
        success: false,
        message: `Already sold: ${alreadySold.map((d) => d.imei).join(", ")}`,
      });
    }

    const { seq, orderNo } = await nextOrderNumber(db);

    const byId = new Map(devices.map((d) => [String(d._id), d]));
    const lines = deviceIds.map((oid) =>
      deviceLine(byId.get(String(oid)), priceById.get(String(oid))),
    );
    const totals = computeTotals(lines, body.gstRate);

    const now = new Date();
    const order = {
      orderNo,
      seq,
      customerId,
      customerName: customer.name,
      currency,
      notes: String(body.notes || "").trim().slice(0, 1000),
      lines,
      ...totals,
      status: STATUS_PENDING,
      confirmedAt: null,
      confirmedBy: null,
      createdAt: now,
      createdBy: actor(req),
      cancelledAt: null,
      cancelledBy: null,
    };
    const r = await db.collection(ORDERS).insertOne(order);

    // Mark the devices Sold. The status guard means a concurrent order can't
    // double-sell — and the history entry only lands on devices that actually
    // transitioned.
    const upd = await db.collection(DEVICES).updateMany(
      { _id: { $in: deviceIds }, status: { $ne: "Sold" } },
      {
        $set: {
          status: "Sold",
          salesOrder: {
            id: r.insertedId,
            orderNo: order.orderNo,
            customerName: customer.name,
            soldAt: now,
          },
          updatedAt: now,
        },
        $push: {
          history: {
            $each: [historyEntry(req, `Sold on ${order.orderNo} to ${customer.name}`)],
            $slice: -100,
          },
        },
      },
    );
    if (upd.modifiedCount !== deviceIds.length) {
      console.warn(
        `Sales order ${order.orderNo}: expected ${deviceIds.length} devices marked Sold, got ${upd.modifiedCount}`,
      );
    }

    return res.json({ success: true, message: `${order.orderNo} created`, order: { ...order, _id: r.insertedId } });
  } catch (e) {
    console.error("Create refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to create the sales order" });
  }
});

// ── PUT /refurbished/sales-orders/:id ───────────────────────────────
// Edit an active order: swap the customer, add or drop devices, re-price
// lines, change the currency / GST / notes.
//
// The device set is reconciled rather than rewritten: devices dropped from
// the order go back to In Stock, newly added ones are marked Sold, and the
// ones that stay keep their stamp (refreshed if the customer changed). Line
// snapshots are rebuilt from the live device docs so an order always shows
// what those devices are now.
//
// Body: same shape as create — { customerId, currency, notes, gstRate, lines }
router.put("/:id", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const body = req.body || {};
    const customerId = ObjectId.isValid(body.customerId) ? new ObjectId(body.customerId) : null;
    if (!customerId) {
      return res.status(400).json({ success: false, message: "A customer is required" });
    }
    const parsed = parseLines(body.lines);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const { deviceIds, priceById } = parsed;

    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    if (order.status !== STATUS_PENDING) {
      return res.status(400).json({
        success: false,
        message:
          order.status === STATUS_CONFIRMED
            ? "This order is confirmed — only pending orders can be edited"
            : "A cancelled order can't be edited",
      });
    }

    const customer = await db.collection(CUSTOMERS).findOne({ _id: customerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const devices = await db
      .collection(DEVICES)
      .find({ _id: { $in: deviceIds } })
      .toArray();
    if (devices.length !== deviceIds.length) {
      return res.status(400).json({ success: false, message: "A selected device no longer exists" });
    }

    const wasOnOrder = new Set(
      (order.lines || []).map((l) => String(l.deviceId)).filter(Boolean),
    );
    const nowOnOrder = new Set(deviceIds.map(String));

    // A device joining this order must be free — sold on someone else's
    // order it stays there until that one is cancelled or edited.
    const taken = devices.filter(
      (d) =>
        !wasOnOrder.has(String(d._id)) &&
        d.status === "Sold" &&
        String((d.salesOrder && d.salesOrder.id) || "") !== String(order._id),
    );
    if (taken.length) {
      return res.status(400).json({
        success: false,
        message: `Already sold on another order: ${taken.map((d) => d.imei).join(", ")}`,
      });
    }

    const now = new Date();
    const removedIds = (order.lines || [])
      .map((l) => l.deviceId)
      .filter((did) => did && !nowOnOrder.has(String(did)));
    const addedIds = deviceIds.filter((did) => !wasOnOrder.has(String(did)));
    const keptIds = deviceIds.filter((did) => wasOnOrder.has(String(did)));
    const customerChanged = String(order.customerId) !== String(customerId);

    // Devices dropped from the order go back into stock — but only those
    // still sold under THIS order, so a device already re-sold elsewhere
    // isn't yanked out from under that order.
    if (removedIds.length) {
      await db.collection(DEVICES).updateMany(
        { _id: { $in: removedIds }, "salesOrder.id": order._id },
        {
          $set: { status: "In Stock", salesOrder: null, updatedAt: now },
          $push: {
            history: {
              $each: [historyEntry(req, `Removed from ${order.orderNo} — returned to stock`)],
              $slice: -100,
            },
          },
        },
      );
    }

    const stamp = {
      id: order._id,
      orderNo: order.orderNo,
      customerName: customer.name,
      soldAt: now,
    };
    if (addedIds.length) {
      await db.collection(DEVICES).updateMany(
        { _id: { $in: addedIds } },
        {
          $set: { status: "Sold", salesOrder: stamp, updatedAt: now },
          $push: {
            history: {
              $each: [historyEntry(req, `Sold on ${order.orderNo} to ${customer.name}`)],
              $slice: -100,
            },
          },
        },
      );
    }
    // Devices staying on the order only need their stamp refreshed, and
    // only when the buyer changed.
    if (customerChanged && keptIds.length) {
      await db.collection(DEVICES).updateMany(
        { _id: { $in: keptIds }, "salesOrder.id": order._id },
        {
          $set: { "salesOrder.customerName": customer.name, updatedAt: now },
          $push: {
            history: {
              $each: [
                historyEntry(
                  req,
                  `${order.orderNo} reassigned to ${customer.name}`,
                ),
              ],
              $slice: -100,
            },
          },
        },
      );
    }

    const byId = new Map(devices.map((d) => [String(d._id), d]));
    const lines = deviceIds.map((oid) =>
      deviceLine(byId.get(String(oid)), priceById.get(String(oid))),
    );
    const totals = computeTotals(lines, body.gstRate);

    // What changed, in words, for the order's own audit trail.
    const bits = [];
    if (customerChanged) bits.push(`customer → ${customer.name}`);
    if (addedIds.length) bits.push(`+${addedIds.length} device(s)`);
    if (removedIds.length) bits.push(`−${removedIds.length} device(s)`);
    if (Math.round((order.total || 0) * 100) !== Math.round(totals.total * 100)) {
      bits.push(`total ${(order.total || 0).toFixed(2)} → ${totals.total.toFixed(2)}`);
    }

    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          customerId,
          customerName: customer.name,
          currency: normalizeCurrency(body.currency),
          notes: String(body.notes || "").trim().slice(0, 1000),
          lines,
          ...totals,
          updatedAt: now,
          updatedBy: actor(req),
        },
        $push: {
          history: {
            $each: [
              {
                at: now,
                by: actor(req),
                action: bits.length ? `Updated — ${bits.join(", ")}` : "Updated",
              },
            ],
            $slice: -100,
          },
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    return res.json({ success: true, message: `${order.orderNo} updated`, order: updated });
  } catch (e) {
    console.error("Update refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the sales order" });
  }
});

// ── PUT /refurbished/sales-orders/:id/notes ─────────────────────────
// The remark stays editable after an order is confirmed — it's commentary,
// not part of the sale. Everything else on a confirmed order is locked.
router.put("/:id/notes", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    if (order.status === STATUS_CANCELLED) {
      return res.status(400).json({ success: false, message: "A cancelled order can't be edited" });
    }

    const notes = String((req.body && req.body.notes) || "").trim().slice(0, 1000);
    if (notes === (order.notes || "")) {
      return res.json({ success: true, message: "No change", order });
    }

    const now = new Date();
    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: { notes, updatedAt: now, updatedBy: actor(req) },
        $push: {
          history: {
            $each: [{ at: now, by: actor(req), action: notes ? "Remark updated" : "Remark cleared" }],
            $slice: -100,
          },
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    return res.json({ success: true, message: "Remark saved", order: updated });
  } catch (e) {
    console.error("Update refurb sales order notes error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the remark" });
  }
});

// ── POST /refurbished/sales-orders/:id/confirm ──────────────────────
// Locks the order: a confirmed order can no longer be edited. Cancelling
// stays available as the escape hatch.
router.post("/:id/confirm", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    if (order.status === STATUS_CANCELLED) {
      return res.status(400).json({ success: false, message: "A cancelled order can't be confirmed" });
    }
    if (order.status === STATUS_CONFIRMED) {
      return res.status(400).json({ success: false, message: "This order is already confirmed" });
    }

    const now = new Date();
    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: { status: STATUS_CONFIRMED, confirmedAt: now, confirmedBy: actor(req) },
        $push: {
          history: {
            $each: [{ at: now, by: actor(req), action: "Confirmed" }],
            $slice: -100,
          },
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    return res.json({ success: true, message: `${order.orderNo} confirmed`, order: updated });
  } catch (e) {
    console.error("Confirm refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to confirm the sales order" });
  }
});

// ── POST /refurbished/sales-orders/:id/cancel ───────────────────────
router.post("/:id/cancel", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    if (order.status === STATUS_CANCELLED) {
      return res.status(400).json({ success: false, message: "This order is already cancelled" });
    }

    const now = new Date();
    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: { status: STATUS_CANCELLED, cancelledAt: now, cancelledBy: actor(req) },
        $push: {
          history: {
            $each: [{ at: now, by: actor(req), action: "Cancelled — devices returned to stock" }],
            $slice: -100,
          },
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;

    // Put the devices back In Stock — only those still Sold under THIS order
    // (a device deleted meanwhile, or resold after a manual fix, is skipped).
    const deviceIds = (order.lines || []).map((l) => l.deviceId).filter(Boolean);
    await db.collection(DEVICES).updateMany(
      { _id: { $in: deviceIds }, status: "Sold", "salesOrder.id": order._id },
      {
        $set: { status: "In Stock", salesOrder: null, updatedAt: now },
        $push: {
          history: {
            $each: [historyEntry(req, `${order.orderNo} cancelled — returned to stock`)],
            $slice: -100,
          },
        },
      },
    );

    return res.json({ success: true, message: `${order.orderNo} cancelled`, order: updated });
  } catch (e) {
    console.error("Cancel refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to cancel the sales order" });
  }
});

module.exports = router;
