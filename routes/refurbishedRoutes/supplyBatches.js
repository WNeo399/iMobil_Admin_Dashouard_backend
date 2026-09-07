// Refurbished Device — Supply Batches (Mongo: refurb_supply_batches).
//
// A phone supplier boxes up devices from their own shelf and sends them to
// iMobile. The batch has a two-step life:
//
//   Pending    saved as a draft list — devices are untouched and the batch
//              can still be edited (devices, tracking, notes);
//   Confirmed  the box actually ships: each device flips to status
//              "Not Yet Received" at location "Sending to iMobile" (stock
//              source deliberately untouched — the unit is still theirs),
//              and an Incoming Stocks record is written so the warehouse
//              receives through the normal stock-take flow.
//
// Suppliers only ever see their own batches and only their own devices can
// board; staff watch (and receive through Incoming Stocks). Cancelling a
// Pending batch just retires the draft; cancelling a confirmed one — only
// while nothing has been received — puts the devices back where they were
// and removes the incoming record.
//
//   GET    /refurbished/supply             list (received counts joined)
//   GET    /refurbished/supply/:id         one, with per-line received flags
//   POST   /refurbished/supply             create draft (SPL-10001+)
//   PUT    /refurbished/supply/:id         edit a Pending batch
//   POST   /refurbished/supply/:id/confirm ship it
//   POST   /refurbished/supply/:id/cancel
//
// Reading needs refurb:supply:view, writing refurb:supply:manage — held by
// Phone Supplier, and by the admin wildcards.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const {
  STATUS_IN_STOCK,
  STATUS_NOT_RECEIVED,
  STATUS_WITH_SUPPLIER,
  LOCATION_SENDING_IMOBILE,
  stockSourceForUser,
} = require("./stockSource");

const VIEW = requirePermission("refurb:supply:view");
const MANAGE = requirePermission("refurb:supply:manage");
const SUPPLY = "refurb_supply_batches";
const INCOMING = "refurb_incoming_batches";
const DEVICES = "refurb_devices";
const MAX_LINES = 500;

const STATUS_PENDING = "Pending";
const STATUS_SENT = "Sent";
const STATUS_CANCELLED = "Cancelled";

function actor(req) {
  return (req.user && req.user.username) || null;
}

// Same shelf-scoping rule as the Stock page: a supplier works their own
// stock source; staff are unscoped (null).
function supplierSource(user) {
  if (!user || user.role !== "phone-supplier") return null;
  return stockSourceForUser(user) || " unassigned";
}

async function nextBatchNumber(db) {
  const last = await db.collection(SUPPLY).find({}).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max((last[0] && last[0].seq) || 0, 10000) + 1;
  return { seq, batchNo: `SPL-${seq}` };
}

// A batch may carry the supplier's With Supplier units or our own In Stock
// ones — anything else (sold, away, already moving) can't board.
function sendable(d) {
  return !d.status || d.status === STATUS_IN_STOCK || d.status === STATUS_WITH_SUPPLIER;
}

// Shared by create / edit / confirm: resolve the device ids and check they
// are this supplier's, sendable, and all one stock source. Returns either
// { devices, stockSource } or { error, code }.
async function resolveDevices(db, req, rawIds) {
  const deviceIds = [...new Set((Array.isArray(rawIds) ? rawIds : []).map(String))]
    .filter((v) => ObjectId.isValid(v))
    .map((v) => new ObjectId(v));
  if (!deviceIds.length) return { error: "Add at least one device", code: 400 };
  if (deviceIds.length > MAX_LINES) {
    return { error: `A batch holds at most ${MAX_LINES} devices`, code: 400 };
  }

  const devices = await db.collection(DEVICES).find({ _id: { $in: deviceIds } }).toArray();
  if (devices.length !== deviceIds.length) {
    return { error: "A selected device no longer exists", code: 400 };
  }
  const scope = supplierSource(req.user);
  if (scope !== null && devices.some((d) => d.stockSource !== scope)) {
    return { error: "A selected device isn't on your shelf", code: 400 };
  }
  const notSendable = devices.filter((d) => !sendable(d));
  if (notSendable.length) {
    return {
      error: `Not sendable: ${notSendable.map((d) => `${d.imei} (${d.status})`).join(", ")}`,
      code: 400,
    };
  }
  const sources = [...new Set(devices.map((d) => d.stockSource || ""))];
  if (sources.length !== 1) {
    return { error: `All devices must share one stock source (got ${sources.join(", ")})`, code: 400 };
  }
  return { devices, stockSource: sources[0] };
}

function snapshotLines(devices) {
  return devices.map((d) => ({
    deviceId: d._id,
    imei: d.imei,
    model: d.model || "",
    color: d.color || "",
    storage: d.storage || "",
    grade: d.grade || "",
    costPrice: d.costPrice == null ? null : d.costPrice,
    currency: d.currency || "AUD",
  }));
}

// ── GET /refurbished/supply ─────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const query = {};
    const scope = supplierSource(req.user);
    if (scope !== null) query.stockSource = scope;
    // The Stock page's bulk-add picker: only Pending drafts the caller's
    // freshly recorded devices could actually board — batches on their own
    // stock source (a supplier's shelf, or iMobile for staff).
    if (req.query.pendingFor === "me") {
      query.status = STATUS_PENDING;
      query.stockSource = stockSourceForUser(req.user);
    }

    const batches = await db
      .collection(SUPPLY)
      .find(query)
      .sort({ seq: -1 })
      .limit(500)
      .toArray();

    // Received progress lives on the linked incoming batch — derived, so
    // it can't drift from what the warehouse actually scanned.
    const incIds = batches.map((b) => b.incomingBatchId).filter(Boolean);
    const incoming = incIds.length
      ? await db
          .collection(INCOMING)
          .find({ _id: { $in: incIds } }, { projection: { lines: 1 } })
          .toArray()
      : [];
    const receivedById = new Map(
      incoming.map((b) => [String(b._id), (b.lines || []).filter((l) => l.received).length]),
    );

    return res.json({
      success: true,
      batches: batches.map((b) => ({
        ...b,
        received: receivedById.get(String(b.incomingBatchId)) || 0,
        total: (b.lines || []).length,
      })),
    });
  } catch (e) {
    console.error("List supply batches error:", e);
    return res.status(500).json({ success: false, message: "Failed to load supply batches" });
  }
});

// ── GET /refurbished/supply/:id ─────────────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const batch = await db.collection(SUPPLY).findOne({ _id: new ObjectId(req.params.id) });
    if (!batch) return res.status(404).json({ success: false, message: "Supply batch not found" });
    const scope = supplierSource(req.user);
    if (scope !== null && batch.stockSource !== scope) {
      return res.status(404).json({ success: false, message: "Supply batch not found" });
    }

    // Per-line received flags off the incoming record.
    const inc = batch.incomingBatchId
      ? await db
          .collection(INCOMING)
          .findOne({ _id: batch.incomingBatchId }, { projection: { lines: 1 } })
      : null;
    const receivedByCode = new Map(
      ((inc && inc.lines) || []).map((l) => [l.code, { received: !!l.received, receivedAt: l.receivedAt || null }]),
    );
    const lines = (batch.lines || []).map((l) => ({
      ...l,
      ...(receivedByCode.get(l.imei) || { received: false, receivedAt: null }),
    }));
    return res.json({
      success: true,
      batch: { ...batch, lines, received: lines.filter((l) => l.received).length, total: lines.length },
    });
  } catch (e) {
    console.error("Get supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the supply batch" });
  }
});

// ── POST /refurbished/supply ────────────────────────────────────────
// Body: { notes, tracking, deviceIds: [...] } — saves a Pending draft.
// Devices are untouched until the batch is confirmed.
router.post("/", MANAGE, async (req, res) => {
  try {
    // Creation is usually the supplier boxing up their own shelf, but staff
    // may also open a batch on a supplier's behalf (the Stock page's bulk
    // add). resolveDevices still scopes a supplier to their own devices.
    const body = req.body || {};
    const db = await connectToDatabase();
    const resolved = await resolveDevices(db, req, body.deviceIds);
    if (resolved.error) {
      return res.status(resolved.code).json({ success: false, message: resolved.error });
    }

    const now = new Date();
    const { seq, batchNo } = await nextBatchNumber(db);
    const batch = {
      batchNo,
      seq,
      stockSource: resolved.stockSource,
      notes: String(body.notes || "").trim().slice(0, 1000),
      tracking: String(body.tracking || "").trim().slice(0, 100),
      status: STATUS_PENDING,
      lines: snapshotLines(resolved.devices),
      incomingBatchId: null,
      createdAt: now,
      updatedAt: now,
      createdBy: actor(req),
      confirmedAt: null,
      confirmedBy: null,
      cancelledAt: null,
      cancelledBy: null,
    };
    const r = await db.collection(SUPPLY).insertOne(batch);
    return res.json({
      success: true,
      message: `${batchNo} saved — confirm it when the box ships`,
      id: r.insertedId,
      batch: { ...batch, _id: r.insertedId, received: 0, total: batch.lines.length },
    });
  } catch (e) {
    console.error("Create supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the supply batch" });
  }
});

// ── PUT /refurbished/supply/:id ─────────────────────────────────────
// Edit a Pending batch: devices, tracking, notes. Confirmed batches are
// the shipped record and stay as they are.
router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (supplierSource(req.user) === null) {
      return res.status(403).json({ success: false, message: "Supply batches are edited by suppliers" });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const batch = await db.collection(SUPPLY).findOne({ _id: new ObjectId(req.params.id) });
    if (!batch) return res.status(404).json({ success: false, message: "Supply batch not found" });
    const scope = supplierSource(req.user);
    if (scope !== null && batch.stockSource !== scope) {
      return res.status(404).json({ success: false, message: "Supply batch not found" });
    }
    if (batch.status !== STATUS_PENDING) {
      return res.status(400).json({ success: false, message: "Only a pending batch can be edited" });
    }

    const body = req.body || {};
    const resolved = await resolveDevices(db, req, body.deviceIds);
    if (resolved.error) {
      return res.status(resolved.code).json({ success: false, message: resolved.error });
    }

    const r = await db.collection(SUPPLY).findOneAndUpdate(
      { _id: batch._id },
      {
        $set: {
          stockSource: resolved.stockSource,
          notes: String(body.notes || "").trim().slice(0, 1000),
          tracking: String(body.tracking || "").trim().slice(0, 100),
          lines: snapshotLines(resolved.devices),
          updatedAt: new Date(),
          updatedBy: actor(req),
        },
      },
      { returnDocument: "after" },
    );
    const updated = r ? r.value || r : null;
    return res.json({
      success: true,
      message: `${batch.batchNo} updated`,
      batch: updated ? { ...updated, received: 0, total: (updated.lines || []).length } : null,
    });
  } catch (e) {
    console.error("Update supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the supply batch" });
  }
});

// ── POST /refurbished/supply/:id/add ────────────────────────────────
// Append devices to a Pending batch — the Stock page's bulk add drops
// freshly scanned devices straight onto an open draft. Devices already
// aboard are skipped; the rest pass the same checks as a create and
// must match the batch's stock source.
router.post("/:id/add", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const batch = await db.collection(SUPPLY).findOne({ _id: new ObjectId(req.params.id) });
    if (!batch) return res.status(404).json({ success: false, message: "Supply batch not found" });
    const scope = supplierSource(req.user);
    if (scope !== null && batch.stockSource !== scope) {
      return res.status(404).json({ success: false, message: "Supply batch not found" });
    }
    if (batch.status !== STATUS_PENDING) {
      return res.status(400).json({ success: false, message: "Devices can only be added to a pending batch" });
    }

    const resolved = await resolveDevices(db, req, (req.body || {}).deviceIds);
    if (resolved.error) {
      return res.status(resolved.code).json({ success: false, message: resolved.error });
    }
    if (resolved.stockSource !== batch.stockSource) {
      return res.status(400).json({
        success: false,
        message: `These devices are ${resolved.stockSource} stock — ${batch.batchNo} carries ${batch.stockSource}`,
      });
    }

    const aboard = new Set((batch.lines || []).map((l) => String(l.deviceId)));
    const fresh = resolved.devices.filter((d) => !aboard.has(String(d._id)));
    if (!fresh.length) {
      return res.json({
        success: true,
        message: `Already on ${batch.batchNo}`,
        added: 0,
        total: aboard.size,
        batchNo: batch.batchNo,
      });
    }
    if (aboard.size + fresh.length > MAX_LINES) {
      return res.status(400).json({ success: false, message: `A batch holds at most ${MAX_LINES} devices` });
    }

    await db.collection(SUPPLY).updateOne(
      // Status re-checked in the write so a concurrent confirm can't race in.
      { _id: batch._id, status: STATUS_PENDING },
      {
        $push: { lines: { $each: snapshotLines(fresh) } },
        $set: { updatedAt: new Date(), updatedBy: actor(req) },
      },
    );
    return res.json({
      success: true,
      message: `${fresh.length} device(s) added to ${batch.batchNo}`,
      added: fresh.length,
      total: aboard.size + fresh.length,
      batchNo: batch.batchNo,
    });
  } catch (e) {
    console.error("Add to supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to add to the supply batch" });
  }
});

// ── POST /refurbished/supply/:id/confirm ────────────────────────────
// The box ships: devices flip onto the road and the incoming record is
// written for the warehouse. Anything no longer sendable (sold or moved
// since the draft was saved) is dropped from the batch and reported.
router.post("/:id/confirm", MANAGE, async (req, res) => {
  try {
    if (supplierSource(req.user) === null) {
      return res.status(403).json({ success: false, message: "Supply batches are confirmed by suppliers" });
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const batch = await db.collection(SUPPLY).findOne({ _id: new ObjectId(req.params.id) });
    if (!batch) return res.status(404).json({ success: false, message: "Supply batch not found" });
    const scope = supplierSource(req.user);
    if (scope !== null && batch.stockSource !== scope) {
      return res.status(404).json({ success: false, message: "Supply batch not found" });
    }
    if (batch.status !== STATUS_PENDING) {
      return res.status(400).json({
        success: false,
        message:
          batch.status === STATUS_SENT
            ? "This batch is already confirmed"
            : "A cancelled batch can't be confirmed",
      });
    }

    // The draft's device set, re-validated against today's reality.
    const resolved = await resolveDevices(db, req, (batch.lines || []).map((l) => l.deviceId));
    if (resolved.error) {
      return res.status(resolved.code).json({ success: false, message: resolved.error });
    }
    const devices = resolved.devices;
    const now = new Date();
    const who = actor(req);
    const tracking = batch.tracking || "";

    // The incoming record first, so the batch can point at it. Its lines
    // carry the devices' own details — including their Blackbelt answer,
    // so the receiving dialog starts green where it can.
    const incomingDoc = {
      title: `${batch.batchNo} — ${batch.stockSource} supply`,
      currency: devices[0].currency || "AUD",
      stockSource: batch.stockSource,
      // The tracking number rides on the note so the warehouse sees it
      // wherever the incoming record's note surfaces.
      note: `Created by supply batch ${batch.batchNo}` + (tracking ? ` · Tracking: ${tracking}` : ""),
      tracking,
      supplyBatchNo: batch.batchNo,
      lines: devices.map((d, i) => ({
        no: i + 1,
        code: d.imei,
        model: d.model || "",
        color: d.color || "",
        capacity: d.storage || "",
        battery: d.batteryHealth == null ? null : d.batteryHealth,
        price: d.costPrice == null ? null : d.costPrice,
        grade: d.grade || "",
        bbStatus: d.blackbeltChecked ? "found" : "pending",
        bbMessage: "",
        bbReportId: d.blackbeltReportId || "",
        bbDevice: d.blackbeltChecked
          ? {
              brand: d.brand || "",
              model: d.model || "",
              color: d.color || "",
              storage: d.storage || "",
              serialNumber: d.serialNumber || "",
              batteryHealth: d.batteryHealth == null ? null : d.batteryHealth,
              batteryCycleCount: d.batteryCycleCount == null ? null : d.batteryCycleCount,
              batteryCapacity: d.batteryCapacity || "",
              aNumber: d.aNumber || "",
              reportStatus: d.blackbeltStatus || "",
            }
          : null,
        received: false,
        receivedAt: null,
        receivedBy: null,
        unlisted: false,
        alreadyInStock: false,
        deviceId: null,
        committedAt: null,
      })),
      blackbelt: {
        total: devices.length,
        done: devices.filter((d) => d.blackbeltChecked).length,
        running: false,
      },
      createdAt: now,
      updatedAt: now,
      createdBy: who,
    };
    const inc = await db.collection(INCOMING).insertOne(incomingDoc);

    // Flip the devices onto the road. The status guard keeps a concurrent
    // sale or repair send honest — anything that raced is reported, and
    // its line is dropped from both records.
    const flipped = [];
    const skipped = [];
    for (const d of devices) {
      const r = await db.collection(DEVICES).updateOne(
        {
          _id: d._id,
          $or: [
            { status: STATUS_IN_STOCK },
            { status: STATUS_WITH_SUPPLIER },
            { status: null },
            { status: { $exists: false } },
          ],
        },
        {
          $set: {
            status: STATUS_NOT_RECEIVED,
            location: LOCATION_SENDING_IMOBILE,
            updatedAt: now,
          },
          $push: {
            history: {
              $each: [{ at: now, by: who, action: `Sent to iMobile on ${batch.batchNo}` }],
              $slice: -100,
            },
          },
        },
      );
      if (r.modifiedCount) flipped.push(d);
      else skipped.push({ imei: d.imei, reason: "No longer sendable" });
    }
    if (!flipped.length) {
      await db.collection(INCOMING).deleteOne({ _id: inc.insertedId });
      return res.status(409).json({ success: false, message: "None of the devices are still sendable" });
    }
    if (skipped.length) {
      const gone = new Set(skipped.map((s) => s.imei));
      await db.collection(INCOMING).updateOne(
        { _id: inc.insertedId },
        {
          $pull: { lines: { code: { $in: [...gone] } } },
          $inc: { "blackbelt.total": -skipped.length },
        },
      );
    }

    await db.collection(SUPPLY).updateOne(
      { _id: batch._id },
      {
        $set: {
          status: STATUS_SENT,
          lines: flipped.map((d) => ({
            ...snapshotLines([d])[0],
            // Where and how it sat before the road, for a cancel.
            previousLocation: d.location || "",
            previousStatus: d.status || STATUS_IN_STOCK,
          })),
          incomingBatchId: inc.insertedId,
          confirmedAt: now,
          confirmedBy: who,
          updatedAt: now,
        },
      },
    );
    return res.json({
      success: true,
      message: `${batch.batchNo} confirmed — ${flipped.length} device(s) on the way`,
      skipped,
    });
  } catch (e) {
    console.error("Confirm supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to confirm the supply batch" });
  }
});

// ── POST /refurbished/supply/:id/cancel ─────────────────────────────
// A Pending draft just retires. A confirmed batch can only be cancelled
// while the warehouse hasn't received anything: devices go back where
// they were and the incoming record leaves with the batch.
router.post("/:id/cancel", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const batch = await db.collection(SUPPLY).findOne({ _id: new ObjectId(req.params.id) });
    if (!batch) return res.status(404).json({ success: false, message: "Supply batch not found" });
    const scope = supplierSource(req.user);
    if (scope !== null && batch.stockSource !== scope) {
      return res.status(404).json({ success: false, message: "Supply batch not found" });
    }
    if (batch.status === STATUS_CANCELLED) {
      return res.status(400).json({ success: false, message: "This batch is already cancelled" });
    }

    const now = new Date();
    const who = actor(req);

    // A draft never touched the devices — nothing to restore.
    if (batch.status === STATUS_PENDING) {
      await db.collection(SUPPLY).updateOne(
        { _id: batch._id },
        { $set: { status: STATUS_CANCELLED, cancelledAt: now, cancelledBy: who, updatedAt: now } },
      );
      return res.json({ success: true, message: `${batch.batchNo} cancelled`, restored: 0 });
    }

    const inc = batch.incomingBatchId
      ? await db.collection(INCOMING).findOne({ _id: batch.incomingBatchId }, { projection: { lines: 1 } })
      : null;
    const receivedCount = ((inc && inc.lines) || []).filter((l) => l.received).length;
    if (receivedCount) {
      return res.status(400).json({
        success: false,
        message: `${receivedCount} device(s) have already been received — this batch can't be cancelled`,
      });
    }

    let restored = 0;
    for (const l of batch.lines || []) {
      const r = await db.collection(DEVICES).updateOne(
        // Only units still in transit under this batch's flip.
        { _id: l.deviceId, status: STATUS_NOT_RECEIVED, location: LOCATION_SENDING_IMOBILE },
        {
          $set: {
            // Back to whatever it was — a supplier unit returns to their
            // shelf, ours to In Stock.
            status: l.previousStatus || STATUS_IN_STOCK,
            location: l.previousLocation || "",
            updatedAt: now,
          },
          $push: {
            history: {
              $each: [
                {
                  at: now,
                  by: who,
                  action: `${batch.batchNo} cancelled — back to ${l.previousStatus || STATUS_IN_STOCK}`,
                },
              ],
              $slice: -100,
            },
          },
        },
      );
      restored += r.modifiedCount;
    }
    if (batch.incomingBatchId) {
      await db.collection(INCOMING).deleteOne({ _id: batch.incomingBatchId });
    }
    await db.collection(SUPPLY).updateOne(
      { _id: batch._id },
      { $set: { status: STATUS_CANCELLED, cancelledAt: now, cancelledBy: who, updatedAt: now } },
    );
    return res.json({
      success: true,
      message: `${batch.batchNo} cancelled — ${restored} device(s) back where they were`,
      restored,
    });
  } catch (e) {
    console.error("Cancel supply batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to cancel the supply batch" });
  }
});

module.exports = router;
