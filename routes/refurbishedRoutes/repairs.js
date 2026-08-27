// Refurbished Device — For Repair (Mongo: refurb_repair_batches).
//
// A batch of faulty devices sent to a repairer and reconciled back in.
// Structured like Incoming Stocks because the problem is the same shape:
// a list arrives, the warehouse ticks off what physically moved, and one
// commit turns that into stock records.
//
// The devices on a repair list may or may not be in our register — in the
// supplied sample none of them were, because the list is exported from
// Exyon's system. So a line carries the sheet's own details and links to a
// register device only when one matches.
//
//   GET    /refurbished/repairs             batch list
//   POST   /refurbished/repairs             create from parsed rows
//   GET    /refurbished/repairs/:id         one batch with all its lines
//   POST   /refurbished/repairs/:id/send    mark lines sent (devices → Out for Repair)
//   POST   /refurbished/repairs/:id/return  returned lines → stock, or straight to a sale
//   POST   /refurbished/repairs/:id/recheck re-run Blackbelt on unresolved lines
//   DELETE /refurbished/repairs/:id         remove a batch
//
// Gated by refurb:repair:view / refurb:repair:manage.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const blackbelt = require("../../utils/blackbelt");
const {
  DEFAULT_STOCK_SOURCE,
  normalizeStockSource,
  normalizeReceiveLocation,
  STATUS_IN_STOCK,
  STATUS_SOLD,
  STATUS_OUT_FOR_REPAIR,
  STATUS_REPAIRING,
} = require("./stockSource");
const {
  ORDERS,
  normalizeCurrency,
  nextOrderNumber,
  deviceLine,
  computeTotals,
} = require("./salesOrderCore");

const VIEW = requirePermission("refurb:repair:view");
const MANAGE = requirePermission("refurb:repair:manage");
const SELL = requirePermission("refurb:sale:manage");
const BATCHES = "refurb_repair_batches";
const REPAIRERS = "refurb_repairers";
const DEVICES = "refurb_devices";
const CUSTOMERS = "refurb_customers";

const GRADES = ["A++", "A+", "A", "B+", "B", "C+", "C"];
const BLACKBELT_CONCURRENCY = 3;
const COMMIT_CONCURRENCY = 8;

// Outcomes a device can come back with. "written-off" and "not-repaired"
// still return physically, they just don't become sellable stock.
const OUTCOMES = ["repaired", "not-repaired", "written-off"];

function normalizeCode(v) {
  return String(v == null ? "" : v).replace(/[\s-]/g, "").trim().toUpperCase();
}
const CODE_RE = /^[A-Z0-9]{10,20}$/;

function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The sample sheet has grades with stray spaces (" C") and a mix of our
// scale plus letters we don't use; anything off-scale is left blank for the
// return step to set.
function grade(v) {
  const g = str(v, 8).toUpperCase().replace(/\s+/g, "");
  return GRADES.includes(g) ? g : "";
}

function outcome(v) {
  const s = str(v, 20).toLowerCase();
  return OUTCOMES.includes(s) ? s : "repaired";
}

function actor(req) {
  return (req.user && req.user.username) || null;
}

// lookupDevice answers { found, device, reportID } — note the capital ID,
// and the device carries brandName / modelName rather than brand / model.
// Same mapping as Incoming Stocks so both pages read a report identically.
async function askBlackbelt(code) {
  try {
    const r = await blackbelt.lookupDevice(code);
    if (r && r.notConfigured) {
      return { bbStatus: "skipped", bbMessage: "Blackbelt is not configured", bbReportId: "", bbDevice: null };
    }
    if (r && r.error) {
      return { bbStatus: "error", bbMessage: r.error, bbReportId: "", bbDevice: null };
    }
    if (r && r.found) {
      const d = r.device || {};
      return {
        bbStatus: "found",
        bbMessage: "",
        bbReportId: r.reportID || "",
        bbDevice: {
          brand: d.brandName || "",
          model: d.modelName || "",
          color: d.color || "",
          storage: d.storage || "",
          serialNumber: d.serialNumber || "",
          imei: d.imei || "",
          batteryHealth: d.batteryHealth == null ? null : d.batteryHealth,
          batteryCycleCount: d.batteryCycleCount == null ? null : d.batteryCycleCount,
          batteryCapacity: d.batteryCapacity || "",
          aNumber: d.aNumber || "",
          reportStatus: d.reportStatus || "",
        },
      };
    }
    return { bbStatus: "none", bbMessage: "", bbReportId: "", bbDevice: null };
  } catch (e) {
    return { bbStatus: "error", bbMessage: (e && e.message) || "Lookup failed", bbReportId: "", bbDevice: null };
  }
}

// A repair-list code that isn't in the register joins it on the spot:
// status "Repairing", no location until it comes back. The return flow
// then treats it like any register device — update, not create.
function repairingGhost(line, { batchId, stockSource, currency, title, who, now }) {
  const bb = line.bbDevice || {};
  return {
    imei: line.code,
    brand: bb.brand || "",
    model: bb.model || line.model || line.productName || "",
    color: bb.color || line.color || "",
    storage: bb.storage || line.storage || "",
    grade: line.grade || "",
    costPrice: line.deviceCost == null ? null : Number(line.deviceCost),
    currency: currency || "AUD",
    stockSource,
    location: "",
    status: STATUS_REPAIRING,
    salesOrder: null,
    serialNumber: bb.serialNumber || "",
    batteryHealth: bb.batteryHealth == null ? null : bb.batteryHealth,
    batteryCycleCount: bb.batteryCycleCount == null ? null : bb.batteryCycleCount,
    batteryCapacity: bb.batteryCapacity || "",
    aNumber: bb.aNumber || "",
    blackbeltChecked: line.bbStatus === "found",
    blackbeltReportId: line.bbReportId || "",
    blackbeltStatus: bb.reportStatus || "",
    note: "",
    repairBatchId: batchId,
    history: [{ at: now, by: who, action: "created", note: `Uploaded on repair batch ${title}` }],
    createdAt: now,
    updatedAt: now,
    createdBy: who,
  };
}

function summarize(batch) {
  const lines = batch.lines || [];
  return {
    total: lines.length,
    sent: lines.filter((l) => l.sent).length,
    returned: lines.filter((l) => l.returned).length,
    committed: lines.filter((l) => l.committedAt).length,
    inRegister: lines.filter((l) => l.deviceId).length,
    inBlackbelt: lines.filter((l) => l.bbStatus === "found").length,
  };
}

async function loadBatch(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Bad id" });
    return null;
  }
  const db = await connectToDatabase();
  const batch = await db.collection(BATCHES).findOne({ _id: new ObjectId(req.params.id) });
  if (!batch) {
    res.status(404).json({ success: false, message: "Repair batch not found" });
    return null;
  }
  return { db, batch };
}

// ── GET /refurbished/repairs ────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const batches = await db.collection(BATCHES).find({}).sort({ createdAt: -1 }).limit(200).toArray();
    return res.json({
      success: true,
      rows: batches.map((b) => ({
        _id: b._id,
        title: b.title,
        repairerId: b.repairerId,
        repairerName: b.repairerName,
        currency: b.currency,
        stockSource: b.stockSource || DEFAULT_STOCK_SOURCE,
        note: b.note,
        createdAt: b.createdAt,
        createdBy: b.createdBy,
        blackbelt: b.blackbelt || null,
        summary: summarize(b),
      })),
    });
  } catch (e) {
    console.error("List repair batches error:", e);
    return res.status(500).json({ success: false, message: "Failed to load repair batches" });
  }
});

// ── GET /refurbished/repairs/:id ────────────────────────────────────
router.get("/:id", VIEW, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    return res.json({ success: true, batch: { ...ctx.batch, summary: summarize(ctx.batch) } });
  } catch (e) {
    console.error("Get repair batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the repair batch" });
  }
});

// ── POST /refurbished/repairs ───────────────────────────────────────
// Body: { title, repairerId, currency, note, rows: [parsed sheet rows] }
router.post("/", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    const title = str(body.title, 120);
    if (!title) return res.status(400).json({ success: false, message: "A title is required" });
    if (!ObjectId.isValid(body.repairerId)) {
      return res.status(400).json({ success: false, message: "A repairer is required" });
    }

    const db = await connectToDatabase();
    const repairerId = new ObjectId(body.repairerId);
    const repairer = await db.collection(REPAIRERS).findOne({ _id: repairerId });
    if (!repairer) return res.status(404).json({ success: false, message: "Repairer not found" });

    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    if (!rawRows.length) return res.status(400).json({ success: false, message: "The list is empty" });
    if (rawRows.length > 2000) {
      return res.status(400).json({ success: false, message: "Too many rows in one batch" });
    }

    const seen = new Set();
    const lines = [];
    for (const r of rawRows) {
      const code = normalizeCode(r && r.code);
      if (!CODE_RE.test(code) || seen.has(code)) continue;
      seen.add(code);
      lines.push({
        no: lines.length + 1,
        code,
        // The exporting system's own id (EXY-0000020114 / 0000301854).
        stockId: str(r.stockId, 40),
        sku: str(r.sku, 60).toUpperCase(),
        productName: str(r.productName, 200),
        model: str(r.model, 120),
        color: str(r.color, 60).toUpperCase(),
        storage: str(r.storage, 40).toUpperCase(),
        grade: grade(r.grade),
        deviceCost: num(r.deviceCost),
        systemPrice: num(r.systemPrice),
        issues: str(r.issues, 300),
        // Normally Blackbelt is asked later, via the button on the batch —
        // but a row scanned in the New Batch dialog arrives with its answer
        // already looked up, and that shouldn't be thrown away. Sanitised
        // field by field; only a "found" row may carry a device blob.
        bbStatus: r.bbStatus === "found" ? "found" : "",
        bbMessage: "",
        bbReportId: r.bbStatus === "found" ? str(r.bbReportId, 120) : "",
        bbDevice:
          r.bbStatus === "found" && r.bbDevice
            ? {
                brand: str(r.bbDevice.brand, 60),
                model: str(r.bbDevice.model, 120),
                color: str(r.bbDevice.color, 60),
                storage: str(r.bbDevice.storage, 40),
                serialNumber: str(r.bbDevice.serialNumber, 60),
                batteryHealth: num(r.bbDevice.batteryHealth),
                batteryCycleCount: num(r.bbDevice.batteryCycleCount),
                batteryCapacity: str(r.bbDevice.batteryCapacity, 40),
                aNumber: str(r.bbDevice.aNumber, 40),
                reportStatus: str(r.bbDevice.reportStatus, 200),
              }
            : null,
        // Filled when the batch is matched against the register.
        deviceId: null,
        previousStatus: "",
        previousLocation: "",
        // Out
        sent: false,
        sentAt: null,
        sentBy: null,
        // Back
        returned: false,
        returnedAt: null,
        returnedBy: null,
        outcome: "",
        repairCost: null,
        returnGrade: "",
        committedAt: null,
      });
    }
    if (!lines.length) {
      return res.status(400).json({ success: false, message: "No usable IMEI / serial numbers in the list" });
    }

    // Link to register devices up front so the page can show what we
    // already hold before anything moves.
    const codes = lines.map((l) => l.code);
    const existing = await db
      .collection(DEVICES)
      .find({ imei: { $in: codes } }, { projection: { imei: 1, status: 1, location: 1 } })
      .toArray();
    const byCode = new Map(existing.map((d) => [d.imei, d]));
    for (const l of lines) {
      const d = byCode.get(l.code);
      if (d) {
        l.deviceId = d._id;
        l.previousStatus = d.status || "";
        l.previousLocation = d.location || "";
      }
    }

    const now = new Date();
    const doc = {
      title,
      repairerId,
      repairerName: repairer.name,
      currency: normalizeCurrency(body.currency),
      // Stamped on any device this batch has to create on return. The sample
      // sheet carries it as a column ("iMobile"); it's fixed per batch.
      stockSource: normalizeStockSource(body.stockSource, DEFAULT_STOCK_SOURCE),
      note: str(body.note, 500),
      lines,
      blackbelt: { total: lines.length, done: 0, running: false },
      createdAt: now,
      updatedAt: now,
      createdBy: actor(req),
    };
    const r = await db.collection(BATCHES).insertOne(doc);

    // Codes we don't hold join the register now, so the whole list is
    // visible in Stock while it's away.
    const ghosts = lines.filter((l) => !l.deviceId);
    let onRegister = 0;
    if (ghosts.length) {
      const who = actor(req);
      const docs = ghosts.map((l) =>
        repairingGhost(l, {
          batchId: r.insertedId,
          stockSource: doc.stockSource,
          currency: doc.currency,
          title,
          who,
          now,
        }),
      );
      try {
        const ins = await db.collection(DEVICES).insertMany(docs, { ordered: false });
        onRegister = ins.insertedCount;
      } catch (e) {
        onRegister = (e && e.result && e.result.insertedCount) || 0;
      }
      // Stamp the new ids onto the lines so the batch links like any other.
      const createdDocs = await db
        .collection(DEVICES)
        .find({ imei: { $in: ghosts.map((l) => l.code) } }, { projection: { imei: 1 } })
        .toArray();
      const idByImei = new Map(createdDocs.map((d) => [d.imei, d._id]));
      const sets = {};
      const filters = [];
      ghosts.forEach((l, i) => {
        const id = idByImei.get(l.code);
        if (!id) return;
        sets[`lines.$[g${i}].deviceId`] = id;
        filters.push({ [`g${i}.code`]: l.code });
      });
      if (filters.length) {
        await db.collection(BATCHES).updateOne({ _id: r.insertedId }, { $set: sets }, { arrayFilters: filters });
      }
    }

    return res.json({
      success: true,
      message: `${lines.length} device(s) added`,
      id: r.insertedId,
      onRegister,
      inRegister: lines.filter((l) => l.deviceId).length,
    });
  } catch (e) {
    console.error("Create repair batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to create the repair batch" });
  }
});

// ── POST /refurbished/repairs/:id/lines ─────────────────────────────
// The bench works the list locally — scanning a code that wasn't on the
// supplier's sheet, correcting a product name, dropping a row — and saves
// the lot in one call. Sending flushes through here first, so a batch can
// never leave carrying edits that were never written down.
//
// Body: { add: [{ code, productName, grade, issues }], update: [same], remove: [code] }
//
// Lines already out for repair are the record of where a device is, so
// they are reported back as skipped rather than touched.
router.post("/:id/lines", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;
    const body = req.body || {};
    const list = (v) => (Array.isArray(v) ? v : []);
    const now = new Date();

    // Worked out against a copy first so the three operations can see each
    // other — a code dropped and re-scanned before a save has to land as an
    // add, not a duplicate.
    const lines = (batch.lines || []).map((l) => ({ ...l }));
    const skipped = [];

    const removeCodes = [];
    const removedDeviceIds = [];
    for (const raw of list(body.remove)) {
      const code = normalizeCode(raw);
      const i = lines.findIndex((l) => l.code === code);
      if (i < 0) continue; // already gone — nothing to undo
      if (lines[i].sent) {
        skipped.push({ code, reason: "Out for repair — return it first" });
        continue;
      }
      // A ghost this batch created for the line goes with it — it never
      // physically existed outside this list.
      if (lines[i].deviceId) removedDeviceIds.push(lines[i].deviceId);
      lines.splice(i, 1);
      removeCodes.push(code);
    }

    const edits = [];
    for (const raw of list(body.update)) {
      const code = normalizeCode(raw && raw.code);
      const line = lines.find((l) => l.code === code);
      if (!line) continue;
      if (line.sent) {
        skipped.push({ code, reason: "Out for repair — its details are locked" });
        continue;
      }
      const set = {};
      if (raw.productName !== undefined) set.productName = str(raw.productName, 200);
      if (raw.grade !== undefined) set.grade = grade(raw.grade);
      if (raw.issues !== undefined) set.issues = str(raw.issues, 300);
      if (raw.stockId !== undefined) set.stockId = str(raw.stockId, 40);
      if (raw.deviceCost !== undefined) set.deviceCost = num(raw.deviceCost);
      if (!Object.keys(set).length) continue;
      Object.assign(line, set);
      edits.push({ code, set });
    }

    const present = new Set(lines.map((l) => l.code));
    const fresh = [];
    for (const raw of list(body.add)) {
      const code = normalizeCode(raw && raw.code);
      if (!CODE_RE.test(code)) {
        skipped.push({ code, reason: "Not a usable IMEI / serial" });
        continue;
      }
      if (present.has(code)) {
        skipped.push({ code, reason: "Already on this batch" });
        continue;
      }
      present.add(code);
      fresh.push(raw || {});
    }

    // Link new codes to the register the way an uploaded row is, so the
    // page can show what we already hold before anything moves.
    let held = new Map();
    if (fresh.length) {
      const found = await db
        .collection(DEVICES)
        .find(
          { imei: { $in: fresh.map((f) => normalizeCode(f.code)) } },
          { projection: { imei: 1, status: 1, location: 1 } },
        )
        .toArray();
      held = new Map(found.map((d) => [d.imei, d]));
    }
    let no = lines.reduce((m, l) => Math.max(m, Number(l.no) || 0), 0);
    const added = fresh.map((f) => {
      const code = normalizeCode(f.code);
      const d = held.get(code);
      no += 1;
      return {
        no,
        code,
        stockId: str(f.stockId, 40),
        sku: str(f.sku, 60).toUpperCase(),
        productName: str(f.productName, 200),
        model: str(f.model, 120),
        color: str(f.color, 60).toUpperCase(),
        storage: str(f.storage, 40).toUpperCase(),
        grade: grade(f.grade),
        deviceCost: num(f.deviceCost),
        systemPrice: num(f.systemPrice),
        issues: str(f.issues, 300),
        bbStatus: "",
        bbMessage: "",
        bbReportId: "",
        bbDevice: null,
        deviceId: d ? d._id : null,
        previousStatus: (d && d.status) || "",
        previousLocation: (d && d.location) || "",
        // Marks it as added at the bench rather than on the supplier's list.
        unlisted: true,
        sent: false,
        sentAt: null,
        sentBy: null,
        returned: false,
        returnedAt: null,
        returnedBy: null,
        outcome: "",
        repairCost: null,
        returnGrade: "",
        committedAt: null,
      };
    });

    if (!added.length && !edits.length && !removeCodes.length) {
      return res.json({
        success: true,
        message: "No change",
        added: 0,
        updated: 0,
        removed: 0,
        skipped,
      });
    }

    // Written with targeted operators rather than a whole-array $set so a
    // save can't undo something another operator did to a line meanwhile.
    // Mongo won't take $pull and $push on one field in a single update.
    if (removeCodes.length) {
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        {
          $pull: { lines: { code: { $in: removeCodes }, sent: { $ne: true } } },
          $inc: { "blackbelt.total": -removeCodes.length },
          $set: { updatedAt: now },
        },
      );
    }
    if (edits.length) {
      const set = { updatedAt: now };
      const filters = [];
      edits.forEach((e, i) => {
        const id = `e${i}`;
        for (const [k, v] of Object.entries(e.set)) set[`lines.$[${id}].${k}`] = v;
        filters.push({ [`${id}.code`]: e.code, [`${id}.sent`]: { $ne: true } });
      });
      await db
        .collection(BATCHES)
        .updateOne({ _id: batch._id }, { $set: set }, { arrayFilters: filters });
    }
    if (removedDeviceIds.length) {
      await db.collection(DEVICES).deleteMany({
        _id: { $in: removedDeviceIds },
        repairBatchId: batch._id,
        status: STATUS_REPAIRING,
      });
    }
    if (added.length) {
      // Scanned extras that aren't in the register join it as Repairing,
      // exactly like an uploaded row.
      const ghosts = added.filter((a) => !a.deviceId);
      if (ghosts.length) {
        const who = actor(req);
        const docs = ghosts.map((a) =>
          repairingGhost(a, {
            batchId: batch._id,
            stockSource: batch.stockSource || DEFAULT_STOCK_SOURCE,
            currency: batch.currency,
            title: batch.title,
            who,
            now,
          }),
        );
        try {
          const ins = await db.collection(DEVICES).insertMany(docs, { ordered: false });
          const createdDocs = await db
            .collection(DEVICES)
            .find({ imei: { $in: ghosts.map((a) => a.code) } }, { projection: { imei: 1 } })
            .toArray();
          const idByImei = new Map(createdDocs.map((d) => [d.imei, d._id]));
          for (const a of added) if (!a.deviceId) a.deviceId = idByImei.get(a.code) || null;
        } catch (e) {
          console.error("Repair line ghost create failed:", e);
        }
      }
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        {
          $push: { lines: { $each: added } },
          $inc: { "blackbelt.total": added.length },
          $set: { updatedAt: now },
        },
      );
    }

    const parts = [];
    if (added.length) parts.push(`${added.length} added`);
    if (edits.length) parts.push(`${edits.length} updated`);
    if (removeCodes.length) parts.push(`${removeCodes.length} removed`);
    return res.json({
      success: true,
      message: parts.join(" · "),
      added: added.length,
      updated: edits.length,
      removed: removeCodes.length,
      skipped,
    });
  } catch (e) {
    console.error("Save repair lines error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the list" });
  }
});

// ── POST /refurbished/repairs/:id/recheck ───────────────────────────
// Blackbelt for lines without a found report. Body may carry { codes }.
router.post("/:id/recheck", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;
    if (!blackbelt.isConfigured()) {
      return res.json({ success: true, queued: 0, message: "Blackbelt is not configured on the server" });
    }

    const only = Array.isArray(req.body && req.body.codes)
      ? new Set(req.body.codes.map(normalizeCode))
      : null;
    const todo = (batch.lines || [])
      .filter((l) => l.bbStatus !== "found")
      .filter((l) => !only || only.has(l.code))
      .map((l) => l.code);
    if (!todo.length) return res.json({ success: true, queued: 0, message: "Nothing to check" });

    const queue = todo.slice();
    const worker = async () => {
      for (;;) {
        const code = queue.shift();
        if (!code) return;
        const bb = await askBlackbelt(code);
        await db.collection(BATCHES).updateOne(
          { _id: batch._id },
          {
            $set: {
              "lines.$[l].bbStatus": bb.bbStatus,
              "lines.$[l].bbMessage": bb.bbMessage,
              "lines.$[l].bbReportId": bb.bbReportId,
              "lines.$[l].bbDevice": bb.bbDevice,
            },
            $inc: { "blackbelt.done": 1 },
          },
          { arrayFilters: [{ "l.code": code }] },
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(BLACKBELT_CONCURRENCY, queue.length) }, worker));
    return res.json({ success: true, queued: todo.length });
  } catch (e) {
    console.error("Repair batch recheck error:", e);
    return res.status(500).json({ success: false, message: "Blackbelt check failed" });
  }
});

// ── POST /refurbished/repairs/:id/send ──────────────────────────────
// The ticked devices physically left for the repairer. Registered ones go
// Out for Repair, remembering where they were so the return can put them
// back; unregistered ones just get stamped on the line.
router.post("/:id/send", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;

    const codes = [
      ...new Set((Array.isArray(req.body && req.body.codes) ? req.body.codes : []).map(normalizeCode)),
    ].filter((c) => CODE_RE.test(c));
    if (!codes.length) return res.status(400).json({ success: false, message: "Nothing selected" });

    const byCode = new Map((batch.lines || []).map((l) => [l.code, l]));
    const now = new Date();
    const who = actor(req);
    let sent = 0;
    const skipped = [];

    for (const code of codes) {
      const l = byCode.get(code);
      if (!l) {
        skipped.push({ code, reason: "Not on this batch" });
        continue;
      }
      if (l.sent) {
        skipped.push({ code, reason: "Already sent" });
        continue;
      }
      // Re-read the device now — it may have been sold since the upload.
      let deviceId = l.deviceId;
      let prevStatus = "";
      let prevLocation = "";
      if (deviceId) {
        const d = await db.collection(DEVICES).findOne({ _id: deviceId });
        if (!d) {
          deviceId = null;
        } else if (d.status === STATUS_SOLD) {
          skipped.push({ code, reason: "Sold — cancel the sales order first" });
          continue;
        } else if (d.status === STATUS_REPAIRING) {
          // Created by this repair list — already in the pipeline. The
          // send is just the physical hand-over, worth a history line.
          await db.collection(DEVICES).updateOne(
            { _id: deviceId },
            {
              $set: { updatedAt: now },
              $push: {
                history: {
                  $each: [
                    { at: now, by: who, action: `Sent for repair — ${batch.title} (${batch.repairerName})` },
                  ],
                  $slice: -100,
                },
              },
            },
          );
        } else {
          prevStatus = d.status || STATUS_IN_STOCK;
          prevLocation = d.location || "";
          await db.collection(DEVICES).updateOne(
            { _id: deviceId },
            {
              $set: { status: STATUS_OUT_FOR_REPAIR, updatedAt: now },
              $push: {
                history: {
                  $each: [
                    {
                      at: now,
                      by: who,
                      action: `Sent for repair — ${batch.title} (${batch.repairerName})`,
                    },
                  ],
                  $slice: -100,
                },
              },
            },
          );
        }
      }
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        {
          $set: {
            "lines.$[l].sent": true,
            "lines.$[l].sentAt": now,
            "lines.$[l].sentBy": who,
            "lines.$[l].deviceId": deviceId,
            "lines.$[l].previousStatus": prevStatus,
            "lines.$[l].previousLocation": prevLocation,
          },
        },
        { arrayFilters: [{ "l.code": code }] },
      );
      sent += 1;
    }

    await db.collection(BATCHES).updateOne({ _id: batch._id }, { $set: { updatedAt: now } });
    return res.json({ success: true, sent, skipped });
  } catch (e) {
    console.error("Repair batch send error:", e);
    return res.status(500).json({ success: false, message: "Failed to send the devices" });
  }
});

// ── POST /refurbished/repairs/:id/return ────────────────────────────
// The devices came back. Each returning line carries its outcome, the
// repair cost and optionally a re-grade; the batch then either puts them
// into stock at a chosen location or sells them straight out, mirroring
// Incoming Stocks' receive / sell.
//
// Body: {
//   codes, location,
//   details: { code: { outcome, repairCost, grade } },
//   sell?: { customerId, currency, notes, gstRate, prices: { code: price } }
// }
router.post("/:id/return", MANAGE, async (req, res, next) => {
  // Selling on the way back needs the sales permission too.
  if (req.body && req.body.sell) return SELL(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;
    const body = req.body || {};

    const codes = [
      ...new Set((Array.isArray(body.codes) ? body.codes : []).map(normalizeCode)),
    ].filter((c) => CODE_RE.test(c));
    if (!codes.length) return res.status(400).json({ success: false, message: "Nothing selected" });

    // Per-device outcome / cost / re-grade from the return dialog.
    const details = {};
    const rawDetails = body.details || {};
    for (const k of Object.keys(rawDetails)) {
      const d = rawDetails[k] || {};
      details[normalizeCode(k)] = {
        outcome: outcome(d.outcome),
        repairCost: num(d.repairCost),
        grade: grade(d.grade),
      };
    }

    const selling = !!body.sell;
    let customer = null;
    let orderId = null;
    let orderNo = null;
    let seq = null;
    if (selling) {
      const customerId = ObjectId.isValid(body.sell.customerId) ? new ObjectId(body.sell.customerId) : null;
      if (!customerId) return res.status(400).json({ success: false, message: "A customer is required" });
      customer = await db.collection(CUSTOMERS).findOne({ _id: customerId });
      if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
      orderId = new ObjectId();
      const next = await nextOrderNumber(db);
      seq = next.seq;
      orderNo = next.orderNo;
    }

    const location = normalizeReceiveLocation(body.location);
    const byCode = new Map((batch.lines || []).map((l) => [l.code, l]));
    const now = new Date();
    const who = actor(req);

    let returned = 0;
    const skipped = [];
    const soldDevices = [];

    const handle = async (code) => {
      const l = byCode.get(code);
      if (!l) return skipped.push({ code, reason: "Not on this batch" });
      if (l.returned) return skipped.push({ code, reason: "Already returned" });

      const fix = details[code] || { outcome: "repaired", repairCost: null, grade: "" };
      // A device that couldn't be fixed comes back but isn't sellable stock.
      const sellable = fix.outcome === "repaired";
      const newGrade = fix.grade || l.returnGrade || "";

      const stamp = {
        "lines.$[l].returned": true,
        "lines.$[l].returnedAt": now,
        "lines.$[l].returnedBy": who,
        "lines.$[l].outcome": fix.outcome,
        "lines.$[l].repairCost": fix.repairCost,
        "lines.$[l].returnGrade": newGrade,
      };

      const bb = l.bbDevice || {};
      let deviceId = l.deviceId;

      if (deviceId) {
        // Already ours — put it back where it belongs and record the spend.
        const set = {
          status: sellable ? STATUS_IN_STOCK : STATUS_OUT_FOR_REPAIR,
          location,
          updatedAt: now,
        };
        if (fix.repairCost != null) set.repairCost = fix.repairCost;
        if (newGrade) set.grade = newGrade;
        // Not repaired: it's physically back but not sellable, so it stays
        // out of stock until someone decides what to do with it.
        if (!sellable) set.status = STATUS_OUT_FOR_REPAIR;
        await db.collection(DEVICES).updateOne(
          { _id: deviceId },
          {
            $set: set,
            $push: {
              history: {
                $each: [
                  {
                    at: now,
                    by: who,
                    action: `Returned from repair — ${fix.outcome}${fix.repairCost != null ? ` (cost ${fix.repairCost})` : ""}`,
                  },
                ],
                $slice: -100,
              },
            },
          },
        );
      } else if (sellable) {
        // Wasn't in the register: a repaired device joins stock now.
        const clash = await db.collection(DEVICES).findOne({ imei: code }, { projection: { _id: 1 } });
        if (clash) {
          deviceId = clash._id;
        } else {
          const doc = {
            imei: code,
            brand: bb.brand || "",
            model: bb.model || l.model || "",
            color: bb.color || l.color || "",
            storage: bb.storage || l.storage || "",
            grade: newGrade || l.grade || "",
            costPrice: l.deviceCost == null ? null : Number(l.deviceCost),
            currency: batch.currency || "AUD",
            repairCost: fix.repairCost,
            stockSource: normalizeStockSource(batch.stockSource, DEFAULT_STOCK_SOURCE),
            location,
            status: STATUS_IN_STOCK,
            serialNumber: bb.serialNumber || "",
            batteryHealth: bb.batteryHealth != null ? bb.batteryHealth : null,
            batteryCycleCount: bb.batteryCycleCount == null ? null : bb.batteryCycleCount,
            batteryCapacity: bb.batteryCapacity || "",
            aNumber: bb.aNumber || "",
            blackbeltChecked: l.bbStatus === "found",
            blackbeltReportId: l.bbReportId || "",
            blackbeltStatus: bb.reportStatus || "",
            note: l.issues ? `Repaired: ${l.issues}` : "",
            repairBatchId: batch._id,
            history: [
              {
                at: now,
                by: who,
                action: "created",
                note: `Returned from repair — ${batch.title} (${batch.repairerName})`,
              },
            ],
            createdAt: now,
            updatedAt: now,
            createdBy: who,
          };
          const ins = await db.collection(DEVICES).insertOne(doc);
          deviceId = ins.insertedId;
        }
        stamp["lines.$[l].deviceId"] = deviceId;
        stamp["lines.$[l].committedAt"] = now;
      }

      // Selling on return: stamp the order onto the device now that it exists.
      if (selling && sellable && deviceId) {
        await db.collection(DEVICES).updateOne(
          { _id: deviceId, status: { $ne: STATUS_SOLD } },
          {
            $set: {
              status: STATUS_SOLD,
              salesOrder: { id: orderId, orderNo, customerName: customer.name, soldAt: now },
              updatedAt: now,
            },
            $push: {
              history: {
                $each: [{ at: now, by: who, action: `Sold on ${orderNo} to ${customer.name}` }],
                $slice: -100,
              },
            },
          },
        );
        const d = await db.collection(DEVICES).findOne({ _id: deviceId });
        if (d) soldDevices.push(d);
      }

      if (deviceId) stamp["lines.$[l].deviceId"] = deviceId;
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        { $set: stamp },
        { arrayFilters: [{ "l.code": code }] },
      );
      returned += 1;
    };

    const queue = codes.slice();
    const worker = async () => {
      for (;;) {
        const code = queue.shift();
        if (!code) return;
        await handle(code);
      }
    };
    await Promise.all(Array.from({ length: Math.min(COMMIT_CONCURRENCY, queue.length) }, worker));

    let order = null;
    if (selling && soldDevices.length) {
      const prices = {};
      for (const k of Object.keys(body.sell.prices || {})) prices[normalizeCode(k)] = body.sell.prices[k];
      const lines = soldDevices.map((d) => deviceLine(d, prices[d.imei]));
      order = {
        _id: orderId,
        orderNo,
        seq,
        customerId: customer._id,
        customerName: customer.name,
        currency: normalizeCurrency(body.sell.currency),
        notes: str(body.sell.notes, 1000),
        lines,
        ...computeTotals(lines, body.sell.gstRate),
        status: "Pending",
        confirmedAt: null,
        confirmedBy: null,
        repairBatchId: batch._id,
        repairBatchTitle: batch.title,
        createdAt: now,
        createdBy: who,
        cancelledAt: null,
        cancelledBy: null,
      };
      await db.collection(ORDERS).insertOne(order);
    }

    await db.collection(BATCHES).updateOne({ _id: batch._id }, { $set: { updatedAt: now } });
    return res.json({ success: true, returned, skipped, order });
  } catch (e) {
    console.error("Repair batch return error:", e);
    return res.status(500).json({ success: false, message: "Failed to return the devices" });
  }
});

// ── DELETE /refurbished/repairs/:id ─────────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;
    // Devices still away would be stranded Out for Repair with no record of
    // where they went, so deleting has to put them back. The caller confirms
    // that first; without `force` this just reports what's in the way.
    const away = (batch.lines || []).filter((l) => l.sent && !l.returned);
    const force = String((req.query && req.query.force) || "") === "true";
    if (away.length && !force) {
      return res.status(400).json({
        success: false,
        stillOut: away.length,
        message: `${away.length} device(s) are still out for repair`,
      });
    }

    // Register entries this list created that never came back as real
    // stock leave with the paperwork.
    const ghosts = await db
      .collection(DEVICES)
      .deleteMany({ repairBatchId: batch._id, status: STATUS_REPAIRING });

    let restored = 0;
    if (away.length) {
      const now = new Date();
      const who = actor(req);
      for (const l of away) {
        if (!l.deviceId) continue;
        const set = {
          status: l.previousStatus || STATUS_IN_STOCK,
          updatedAt: now,
        };
        if (l.previousLocation) set.location = l.previousLocation;
        const r = await db.collection(DEVICES).updateOne(
          { _id: l.deviceId, status: STATUS_OUT_FOR_REPAIR },
          {
            $set: set,
            $push: {
              history: {
                $each: [
                  {
                    at: now,
                    by: who,
                    action: `Repair batch "${batch.title}" deleted — returned to ${set.status}`,
                  },
                ],
                $slice: -100,
              },
            },
          },
        );
        restored += r.modifiedCount;
      }
    }

    await db.collection(BATCHES).deleteOne({ _id: batch._id });
    return res.json({
      success: true,
      removedDevices: ghosts.deletedCount,
      restored,
      message: restored
        ? `Repair batch removed — ${restored} device(s) put back`
        : "Repair batch removed",
    });
  } catch (e) {
    console.error("Delete repair batch error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the repair batch" });
  }
});

module.exports = router;
