// Refurbished Device — Sales Returns (Mongo: refurb_sales_returns).
//
// A customer sends devices back. A return is raised against the customer,
// so the device picker only ever offers units currently sold to them, and
// creating it:
//
//   · puts each device back In Stock on the chosen shelf (iMobile or
//     Assigned To Exyon), its sales stamp cleared and the return in its
//     history — ordinary stock again, and resellable;
//   · flags the line on the original order as returned, carrying the
//     return number, reason and date. The order keeps its lines and totals:
//     the invoice was issued and the paperwork must keep saying so.
//
// Record-only for now — no credit notes. The date/who/order on every line
// is what a credit flow would be built from later.
//
//   GET  /refurbished/sales-returns              list (SR-10001+)
//   GET  /refurbished/sales-returns/sold         devices sold to a customer
//   GET  /refurbished/sales-returns/lookup       who holds this IMEI / serial
//   GET  /refurbished/sales-returns/:id          one
//   POST /refurbished/sales-returns              create
//
// Reading needs refurb:sale:view, writing refurb:sale:manage.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { ORDERS } = require("./salesOrderCore");
const { STATUS_IN_STOCK, RECEIVE_LOCATIONS, normalizeReceiveLocation } = require("./stockSource");

const VIEW = requirePermission("refurb:sale:view");
const MANAGE = requirePermission("refurb:sale:manage");
const RETURNS = "refurb_sales_returns";
const DEVICES = "refurb_devices";
const CUSTOMERS = "refurb_customers";
const STATUS_CONFIRMED = "Confirmed";
const MAX_LINES = 200;

function actor(req) {
  return (req.user && req.user.username) || null;
}

function escapeRegex(v) {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function nextReturnNumber(db) {
  const last = await db.collection(RETURNS).find({}).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max((last[0] && last[0].seq) || 0, 10000) + 1;
  return { seq, returnNo: `SR-${seq}` };
}

// Every device currently sold to one customer, with the order it went out
// on. Only confirmed orders: a device on a pending order is still being
// edited, so it comes off by editing that order, not by a return.
async function soldToCustomer(db, customerId) {
  const orders = await db
    .collection(ORDERS)
    .find({ customerId, status: STATUS_CONFIRMED }, { projection: { orderNo: 1, currency: 1, lines: 1 } })
    .toArray();
  if (!orders.length) return [];

  const orderById = new Map(orders.map((o) => [String(o._id), o]));
  const devices = await db
    .collection(DEVICES)
    .find({
      status: "Sold",
      "salesOrder.id": { $in: orders.map((o) => o._id) },
    })
    .toArray();

  return devices.map((d) => {
    const order = orderById.get(String(d.salesOrder && d.salesOrder.id)) || {};
    const line = ((order.lines || []).find((l) => String(l.deviceId) === String(d._id))) || {};
    return {
      _id: d._id,
      imei: d.imei,
      serialNumber: d.serialNumber || "",
      model: d.model || "",
      color: d.color || "",
      storage: d.storage || "",
      grade: d.grade || "",
      orderId: order._id || null,
      orderNo: order.orderNo || "",
      currency: order.currency || "AUD",
      price: line.price == null ? null : line.price,
      // What the unit cost us, in its own purchase currency — a device
      // bought in CNY doesn't change cost by being sold in AUD.
      costPrice: d.costPrice == null ? null : d.costPrice,
      costCurrency: d.currency || "AUD",
      soldAt: (d.salesOrder && d.salesOrder.soldAt) || null,
      // A line already flagged returned shouldn't be offered twice, even
      // if the device somehow came back Sold under the same order.
      alreadyReturned: line.returned === true,
    };
  });
}

// ── GET /refurbished/sales-returns ──────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const match = {};
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [{ returnNo: rx }, { customerName: rx }, { "lines.imei": rx }, { "lines.orderNo": rx }];
    }
    if (req.query.customerId && ObjectId.isValid(req.query.customerId)) {
      match.customerId = new ObjectId(req.query.customerId);
    }

    const [total, returns] = await Promise.all([
      db.collection(RETURNS).countDocuments(match),
      db
        .collection(RETURNS)
        .find(match)
        .sort({ seq: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);
    return res.json({ success: true, page, pageSize, total, returns });
  } catch (e) {
    console.error("List sales returns error:", e);
    return res.status(500).json({ success: false, message: "Failed to load sales returns" });
  }
});

// ── GET /refurbished/sales-returns/locations ────────────────────────
// The shelves a return may land on — the same whitelist the receive
// dialog offers. Declared before /:id.
router.get("/locations", VIEW, async (req, res) => {
  return res.json({ success: true, locations: RECEIVE_LOCATIONS });
});

// ── GET /refurbished/sales-returns/sold?customerId= ─────────────────
// Declared before /:id so "sold" isn't swallowed as an id.
router.get("/sold", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.query.customerId)) {
      return res.status(400).json({ success: false, message: "A customer is required" });
    }
    const db = await connectToDatabase();
    const devices = await soldToCustomer(db, new ObjectId(req.query.customerId));
    return res.json({ success: true, devices: devices.filter((d) => !d.alreadyReturned) });
  } catch (e) {
    console.error("Sold-to-customer lookup error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the customer's devices" });
  }
});

// ── GET /refurbished/sales-returns/lookup?code= ─────────────────────
// The reverse of picking a customer: scan a device and it says who has
// it, so the return can start from the box rather than the paperwork.
// Declared before /:id so "lookup" isn't swallowed as an id.
router.get("/lookup", VIEW, async (req, res) => {
  try {
    const code = String(req.query.code || "").replace(/[\s-]/g, "").trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, message: "Enter an IMEI or serial" });

    const db = await connectToDatabase();
    // Serial numbers are as scannable as IMEIs, so match either.
    const device = await db.collection(DEVICES).findOne({ $or: [{ imei: code }, { serialNumber: code }] });
    if (!device) {
      return res.json({ success: true, found: false, message: `${code} isn't in the stock register` });
    }
    if (device.status !== "Sold" || !device.salesOrder || !device.salesOrder.id) {
      return res.json({
        success: true,
        found: false,
        message: `${code} isn't sold to anyone — it's ${device.status || "In Stock"}`,
      });
    }

    const order = await db.collection(ORDERS).findOne({ _id: device.salesOrder.id });
    if (!order) {
      return res.json({ success: true, found: false, message: `${code} points at an order that no longer exists` });
    }
    if (order.status !== STATUS_CONFIRMED) {
      return res.json({
        success: true,
        found: false,
        message: `${code} is on ${order.orderNo}, which is still pending — edit that order instead`,
      });
    }
    const line = (order.lines || []).find((l) => String(l.deviceId) === String(device._id)) || {};
    if (line.returned) {
      return res.json({ success: true, found: false, message: `${code} has already been returned` });
    }

    return res.json({
      success: true,
      found: true,
      customerId: order.customerId,
      customerName: order.customerName,
      device: {
        _id: device._id,
        imei: device.imei,
        serialNumber: device.serialNumber || "",
        model: device.model || "",
        color: device.color || "",
        storage: device.storage || "",
        grade: device.grade || "",
        orderId: order._id,
        orderNo: order.orderNo,
        currency: order.currency || "AUD",
        price: line.price == null ? null : line.price,
        soldAt: device.salesOrder.soldAt || null,
      },
    });
  } catch (e) {
    console.error("Sales return lookup error:", e);
    return res.status(500).json({ success: false, message: "Lookup failed" });
  }
});

// ── GET /refurbished/sales-returns/:id ──────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const doc = await db.collection(RETURNS).findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ success: false, message: "Sales return not found" });

    // Older returns predate the stored cost — fill it from the register so
    // the exports aren't blank for them.
    const missing = (doc.lines || []).filter((l) => l.costPrice === undefined && l.deviceId);
    if (missing.length) {
      const devices = await db
        .collection(DEVICES)
        .find(
          { _id: { $in: missing.map((l) => l.deviceId) } },
          { projection: { costPrice: 1, currency: 1 } },
        )
        .toArray();
      const byId = new Map(devices.map((d) => [String(d._id), d]));
      doc.lines = doc.lines.map((l) => {
        if (l.costPrice !== undefined) return l;
        const d = byId.get(String(l.deviceId));
        return d
          ? { ...l, costPrice: d.costPrice == null ? null : d.costPrice, costCurrency: d.currency || "AUD" }
          : l;
      });
    }
    return res.json({ success: true, salesReturn: doc });
  } catch (e) {
    console.error("Get sales return error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the sales return" });
  }
});

// ── POST /refurbished/sales-returns ─────────────────────────────────
// Body: { customerId, notes, location, deviceIds: [...] }
router.post("/", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    if (!ObjectId.isValid(body.customerId)) {
      return res.status(400).json({ success: false, message: "A customer is required" });
    }
    const notes = String(body.notes || "").trim().slice(0, 1000);
    // Where the returned units physically land. Whitelisted, never free
    // text — an unknown value falls back to iMobile.
    const location = normalizeReceiveLocation(body.location);
    const deviceIds = [...new Set((Array.isArray(body.deviceIds) ? body.deviceIds : []).map(String))]
      .filter((v) => ObjectId.isValid(v))
      .map((v) => new ObjectId(v));
    if (!deviceIds.length) {
      return res.status(400).json({ success: false, message: "Add at least one device" });
    }
    if (deviceIds.length > MAX_LINES) {
      return res.status(400).json({ success: false, message: `A return holds at most ${MAX_LINES} devices` });
    }

    const db = await connectToDatabase();
    const customerId = new ObjectId(body.customerId);
    const customer = await db.collection(CUSTOMERS).findOne({ _id: customerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    // Everything this customer currently holds — the only devices that can
    // be returned to them, checked here rather than trusting the client.
    const sellable = await soldToCustomer(db, customerId);
    const byId = new Map(sellable.map((d) => [String(d._id), d]));
    const chosen = [];
    for (const id of deviceIds) {
      const d = byId.get(String(id));
      if (!d) {
        return res.status(400).json({
          success: false,
          message: "A selected device isn't currently sold to this customer",
        });
      }
      if (d.alreadyReturned) {
        return res.status(400).json({ success: false, message: `${d.imei} has already been returned` });
      }
      chosen.push(d);
    }

    const now = new Date();
    const who = actor(req);
    const { seq, returnNo } = await nextReturnNumber(db);

    // Free each device, then flag its order line. The device update is
    // guarded on it still being sold under that order, so a unit that was
    // returned or re-sold in the meantime is reported rather than yanked.
    const lines = [];
    const skipped = [];
    for (const d of chosen) {
      const upd = await db.collection(DEVICES).updateOne(
        { _id: d._id, status: "Sold", "salesOrder.id": d.orderId },
        {
          $set: { status: STATUS_IN_STOCK, location, salesOrder: null, updatedAt: now },
          $push: {
            history: {
              $each: [
                {
                  at: now,
                  by: who,
                  action:
                    `Returned on ${returnNo} from ${customer.name} (${d.orderNo}) to ${location}` +
                    (notes ? ` — ${notes}` : ""),
                },
              ],
              $slice: -100,
            },
          },
        },
      );
      if (!upd.modifiedCount) {
        skipped.push({ imei: d.imei, reason: "No longer sold under that order" });
        continue;
      }
      await db.collection(ORDERS).updateOne(
        { _id: d.orderId },
        {
          $set: {
            "lines.$[l].returned": true,
            "lines.$[l].returnedAt": now,
            "lines.$[l].returnedBy": who,
            "lines.$[l].returnNote": notes,
            "lines.$[l].returnNo": returnNo,
          },
          $push: {
            history: {
              $each: [{ at: now, by: who, action: `${d.imei} returned on ${returnNo}` }],
              $slice: -100,
            },
          },
        },
        { arrayFilters: [{ "l.deviceId": d._id }] },
      );
      lines.push({
        deviceId: d._id,
        imei: d.imei,
        serialNumber: d.serialNumber,
        model: d.model,
        color: d.color,
        storage: d.storage,
        grade: d.grade,
        orderId: d.orderId,
        orderNo: d.orderNo,
        currency: d.currency,
        price: d.price,
        costPrice: d.costPrice,
        costCurrency: d.costCurrency,
      });
    }

    if (!lines.length) {
      return res.status(409).json({
        success: false,
        message: "None of the devices are still sold to this customer",
        skipped,
      });
    }

    const doc = {
      returnNo,
      seq,
      customerId,
      customerName: customer.name,
      notes,
      location,
      lines,
      // Sale value of what came back — reference only, no credit note.
      currency: lines[0].currency || "AUD",
      total: Math.round(lines.reduce((s, l) => s + (Number(l.price) || 0), 0) * 100) / 100,
      createdAt: now,
      createdBy: who,
    };
    const r = await db.collection(RETURNS).insertOne(doc);
    return res.json({
      success: true,
      message: `${returnNo} created — ${lines.length} device(s) back In Stock at ${location}`,
      id: r.insertedId,
      salesReturn: { ...doc, _id: r.insertedId },
      skipped,
    });
  } catch (e) {
    console.error("Create sales return error:", e);
    return res.status(500).json({ success: false, message: "Failed to create the sales return" });
  }
});

module.exports = router;
