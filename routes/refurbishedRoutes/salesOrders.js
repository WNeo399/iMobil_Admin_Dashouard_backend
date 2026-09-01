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
// Selling an unreceived unit closes off its shipment line.
const { receiveLinesForDevices } = require("./incoming");
const {
  LOCATION_IMOBILE,
  STATUS_NOT_RECEIVED,
  STATUS_REPAIRING,
  STATUS_WITH_SUPPLIER,
  STATUS_ON_CONSIGNMENT,
} = require("./stockSource");

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

// Marks devices Sold against an order and files them at iMobile: a unit
// sold out of the dashboard is picked, packed and shipped from here, so
// wherever it sat before, that is where it is now.
//
// Split in two so the history explains the move on the devices that
// actually moved, instead of a location silently changing under them.
// `guard` narrows which devices may transition (create refuses anything
// already Sold); returns how many actually did.
async function markSold(db, req, { deviceIds, devices, orderNo, customerName, stamp, now, guard }) {
  const byId = new Map((devices || []).map((d) => [String(d._id), d]));
  const stayed = [];
  const moved = [];
  for (const id of deviceIds) {
    const d = byId.get(String(id));
    (d && d.location === LOCATION_IMOBILE ? stayed : moved).push(id);
  }

  let modified = 0;
  for (const [ids, note] of [
    [stayed, `Sold on ${orderNo} to ${customerName}`],
    [moved, `Sold on ${orderNo} to ${customerName} — moved to ${LOCATION_IMOBILE}`],
  ]) {
    if (!ids.length) continue;
    const r = await db.collection(DEVICES).updateMany(
      { _id: { $in: ids }, ...(guard || {}) },
      {
        $set: {
          status: "Sold",
          location: LOCATION_IMOBILE,
          salesOrder: stamp,
          updatedAt: now,
        },
        $push: {
          history: { $each: [historyEntry(req, note)], $slice: -100 },
        },
      },
    );
    modified += r.modifiedCount;
  }
  return modified;
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
    // A unit still away at a repairer or sitting on the supplier's shelf is
    // not ours to sell. An unreceived one IS — it is a shipment we have
    // already bought, and selling it is how a lot of stock leaves: straight
    // back out before it is ever shelved. Its batch line is closed off
    // after the sale.
    const notHere = devices.filter(
      (d) =>
        d.status === STATUS_REPAIRING ||
        d.status === STATUS_WITH_SUPPLIER ||
        d.status === STATUS_ON_CONSIGNMENT,
    );
    if (notHere.length) {
      return res.status(400).json({
        success: false,
        message: `Not sellable (being repaired, with the supplier, or on consignment): ${notHere.map((d) => d.imei).join(", ")}`,
      });
    }
    const unreceived = devices.filter((d) => d.status === STATUS_NOT_RECEIVED);

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
    const modified = await markSold(db, req, {
      deviceIds,
      devices,
      orderNo: order.orderNo,
      customerName: customer.name,
      stamp: {
        id: r.insertedId,
        orderNo: order.orderNo,
        customerName: customer.name,
        soldAt: now,
      },
      now,
      guard: { status: { $ne: "Sold" } },
    });
    if (modified !== deviceIds.length) {
      console.warn(
        `Sales order ${order.orderNo}: expected ${deviceIds.length} devices marked Sold, got ${modified}`,
      );
    }

    // Selling an unreceived unit proves the shipment arrived, so its
    // incoming line is marked received rather than left open for the
    // warehouse to chase. Best-effort: the order is already written, and
    // failing to tidy the paperwork must not fail the sale.
    let received = 0;
    if (unreceived.length) {
      try {
        received = await receiveLinesForDevices(
          db,
          unreceived,
          actor(req),
          `Received by selling on ${order.orderNo}`,
        );
      } catch (e) {
        console.error(`Sales order ${order.orderNo}: incoming lines not marked received:`, e && e.message);
      }
    }

    return res.json({
      success: true,
      message:
        `${order.orderNo} created` +
        (received ? ` — ${received} device(s) marked received on their incoming batch` : ""),
      receivedFromIncoming: received,
      order: { ...order, _id: r.insertedId },
    });
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
    if (order.status === STATUS_CANCELLED) {
      return res.status(400).json({ success: false, message: "A cancelled order can't be edited" });
    }
    // Editing a confirmed order reopens it: the confirmation attested to a
    // document that no longer exists, so the order drops back to Pending
    // and has to be confirmed again.
    const reopening = order.status === STATUS_CONFIRMED;

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

    const returnedLines = (order.lines || []).filter((l) => l.returned);
    const activeLines = (order.lines || []).filter((l) => !l.returned);
    const wasOnOrder = new Set(
      activeLines.map((l) => String(l.deviceId)).filter(Boolean),
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
    // Same rule as create: unreceived stock is sellable, away-at-a-repairer
    // and with-the-supplier stock is not.
    const notHere = devices.filter(
      (d) =>
        !wasOnOrder.has(String(d._id)) &&
        (d.status === STATUS_REPAIRING ||
          d.status === STATUS_WITH_SUPPLIER ||
          d.status === STATUS_ON_CONSIGNMENT),
    );
    if (notHere.length) {
      return res.status(400).json({
        success: false,
        message: `Not sellable (being repaired, with the supplier, or on consignment): ${notHere.map((d) => d.imei).join(", ")}`,
      });
    }
    const unreceived = devices.filter(
      (d) => !wasOnOrder.has(String(d._id)) && d.status === STATUS_NOT_RECEIVED,
    );

    const now = new Date();
    const removedIds = activeLines
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
      await markSold(db, req, {
        deviceIds: addedIds,
        devices,
        orderNo: order.orderNo,
        customerName: customer.name,
        stamp,
        now,
      });
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
    const lines = [
      // Returned lines are the historical record of units that went back
      // to stock — they ride through an edit untouched, outside the
      // editable set.
      ...returnedLines,
      ...deviceIds.map((oid) => deviceLine(byId.get(String(oid)), priceById.get(String(oid)))),
    ];
    const totals = computeTotals(lines, body.gstRate);

    // What changed, in words, for the order's own audit trail.
    const bits = [];
    if (customerChanged) bits.push(`customer → ${customer.name}`);
    if (addedIds.length) bits.push(`+${addedIds.length} device(s)`);
    if (removedIds.length) bits.push(`−${removedIds.length} device(s)`);
    if (Math.round((order.total || 0) * 100) !== Math.round(totals.total * 100)) {
      bits.push(`total ${(order.total || 0).toFixed(2)} → ${totals.total.toFixed(2)}`);
    }
    if (reopening) bits.push("reopened — needs confirming again");

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
          // Editing a confirmed order reopens it — back to Pending, to be
          // confirmed again against the new document.
          ...(reopening ? { status: STATUS_PENDING, confirmedAt: null, confirmedBy: null } : {}),
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

    // Devices added to the order straight off a shipment close their
    // incoming line, same as on create.
    let received = 0;
    if (unreceived.length) {
      try {
        received = await receiveLinesForDevices(
          db,
          unreceived,
          actor(req),
          `Received by selling on ${order.orderNo}`,
        );
      } catch (e) {
        console.error(`Sales order ${order.orderNo}: incoming lines not marked received:`, e && e.message);
      }
    }

    return res.json({
      success: true,
      message:
        (reopening
          ? `${order.orderNo} updated — it needs confirming again`
          : `${order.orderNo} updated`) +
        (received ? ` · ${received} device(s) marked received` : ""),
      receivedFromIncoming: received,
      order: updated,
    });
  } catch (e) {
    console.error("Update refurb sales order error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the sales order" });
  }
});

// ── POST /refurbished/sales-orders/:id/refresh-lines ────────────────
// Re-read each line's device description from the register.
//
// Order lines are snapshots so the paperwork survives a device being edited
// or deleted — but that also means correcting a device's model / colour /
// storage in Stock afterwards doesn't reach an order already raised. This
// pulls those corrections through. Descriptive fields only: prices, the
// device set and the totals are untouched, so it's safe on a confirmed
// order (a cancelled one is left alone).
router.post("/:id/refresh-lines", MANAGE, async (req, res) => {
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
      return res.status(400).json({ success: false, message: "A cancelled order can't be updated" });
    }

    const ids = (order.lines || []).map((l) => l.deviceId).filter(Boolean);
    const devices = await db
      .collection(DEVICES)
      .find({ _id: { $in: ids } })
      .toArray();
    const byId = new Map(devices.map((d) => [String(d._id), d]));

    const changed = [];
    const lines = (order.lines || []).map((l) => {
      const d = byId.get(String(l.deviceId));
      if (!d) return l; // device gone — the snapshot is all we have
      // Rebuild from the device, then put the line's own price back.
      const fresh = { ...deviceLine(d, l.price) };
      const differs = ["brand", "model", "color", "storage", "grade", "serialNumber", "batteryHealth"].some(
        (k) => (fresh[k] || "") !== (l[k] || ""),
      );
      if (differs) changed.push(l.imei);
      return fresh;
    });

    if (!changed.length) {
      return res.json({ success: true, message: "Already up to date", updated: 0, order });
    }

    const now = new Date();
    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: { lines, updatedAt: now, updatedBy: actor(req) },
        $push: {
          history: {
            $each: [
              {
                at: now,
                by: actor(req),
                action: `Device details refreshed — ${changed.length} line(s) updated`,
              },
            ],
            $slice: -100,
          },
        },
      },
      { returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    return res.json({
      success: true,
      message: `${changed.length} line(s) updated`,
      updated: changed.length,
      order: updated,
    });
  } catch (e) {
    console.error("Refresh refurb sales order lines error:", e);
    return res.status(500).json({ success: false, message: "Failed to refresh the device details" });
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

// ── POST /refurbished/sales-orders/:id/return-device ────────────────
// A sold device came back. Record-only for now (no credit note): the
// device returns to stock and the order keeps its line — the invoice was
// issued and the paperwork must keep saying so — with the line flagged
// returned, carrying when, who and why. The freed device is then ordinary
// stock; reselling it needs nothing special.
//
// Confirmed orders only: a Pending order is editable, so removing the
// line there already does the right thing.
router.post("/:id/return-device", MANAGE, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const body = req.body || {};
    if (!ObjectId.isValid(body.deviceId)) {
      return res.status(400).json({ success: false, message: "A device is required" });
    }
    const reason = String(body.reason || "").trim().slice(0, 200);
    if (!reason) {
      return res.status(400).json({ success: false, message: "A reason is required" });
    }
    const note = String(body.note || "").trim().slice(0, 500);

    const db = await connectToDatabase();
    const order = await db.collection(ORDERS).findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).json({ success: false, message: "Sales order not found" });
    }
    if (order.status !== STATUS_CONFIRMED) {
      return res.status(400).json({
        success: false,
        message:
          order.status === STATUS_PENDING
            ? "This order is still pending — edit it and remove the device instead"
            : "A cancelled order has nothing to return",
      });
    }
    const deviceId = new ObjectId(body.deviceId);
    const line = (order.lines || []).find((l) => String(l.deviceId) === String(deviceId));
    if (!line) {
      return res.status(404).json({ success: false, message: "That device isn't on this order" });
    }
    if (line.returned) {
      return res.status(400).json({ success: false, message: `${line.imei} has already been returned` });
    }

    const now = new Date();
    const who = actor(req);

    // Free the device — but only if it is still sold under THIS order, so
    // a unit that has since been legitimately resold isn't yanked back.
    const upd = await db.collection(DEVICES).updateOne(
      { _id: deviceId, status: "Sold", "salesOrder.id": order._id },
      {
        $set: { status: "In Stock", salesOrder: null, updatedAt: now },
        $push: {
          history: {
            $each: [
              {
                at: now,
                by: who,
                action:
                  `Returned from ${order.orderNo} (${order.customerName}) — ${reason}` +
                  (note ? ` · ${note}` : ""),
              },
            ],
            $slice: -100,
          },
        },
      },
    );
    if (!upd.matchedCount) {
      return res.status(409).json({
        success: false,
        message: "This device is no longer sold under this order — it may have been resold since",
      });
    }

    const result = await db.collection(ORDERS).findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          "lines.$[l].returned": true,
          "lines.$[l].returnedAt": now,
          "lines.$[l].returnedBy": who,
          "lines.$[l].returnReason": reason,
          "lines.$[l].returnNote": note,
        },
        $push: {
          history: {
            $each: [{ at: now, by: who, action: `${line.imei} returned — ${reason}` }],
            $slice: -100,
          },
        },
      },
      { arrayFilters: [{ "l.deviceId": deviceId }], returnDocument: "after" },
    );
    const updated = result ? result.value || result : null;
    return res.json({
      success: true,
      message: `${line.imei} returned to stock`,
      order: updated,
    });
  } catch (e) {
    console.error("Return refurb sales order device error:", e);
    return res.status(500).json({ success: false, message: "Failed to return the device" });
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
