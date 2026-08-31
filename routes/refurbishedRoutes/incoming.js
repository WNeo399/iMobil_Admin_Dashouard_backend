// Refurbished Device — Incoming Stocks.
//
// A supplier sends a list of units they're shipping; we upload it as a batch
// (Mongo: refurb_incoming_batches), Blackbelt is asked about every code in the
// background, and the warehouse then scans the shipment in. Scanning is
// entirely client-side — nothing is persisted until "Add Received to Stock",
// which marks the scanned lines received AND creates the stock records under
// the stock source chosen when the batch was uploaded, in one call.
//
//   GET    /refurbished/incoming            batch list
//   POST   /refurbished/incoming            create a batch from parsed rows
//   GET    /refurbished/incoming/:id        one batch with all its lines
//   POST   /refurbished/incoming/:id/commit scanned codes → received + stock
//   POST   /refurbished/incoming/:id/sell   scanned codes → stock + a sales order
//   POST   /refurbished/incoming/:id/recheck re-run Blackbelt on unresolved lines
//   DELETE /refurbished/incoming/:id        remove a batch
//
// Admin-only for now: refurb:incoming:manage is held solely by *:*:*.

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
  LOCATION_IMOBILE,
  STATUS_NOT_RECEIVED,
  STATUS_IN_STOCK,
} = require("./stockSource");
const {
  ORDERS,
  normalizeCurrency,
  nextOrderNumber,
  deviceLine,
  computeTotals,
} = require("./salesOrderCore");

const MANAGE = requirePermission("refurb:incoming:manage");
// Selling off a shipment also writes a sales order, so that permission is
// required on top of the incoming one.
const SELL = requirePermission("refurb:sale:manage");
const CUSTOMERS = "refurb_customers";
const BATCHES = "refurb_incoming_batches";
const DEVICES = "refurb_devices";

const CURRENCIES = ["AUD", "CNY", "HKD"];
const GRADES = ["A++", "A+", "A", "B+", "B", "C+", "C"];
// Blackbelt is a third party — a handful of lookups at a time, not 69.
const BLACKBELT_CONCURRENCY = 3;

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

// Supplier lists express battery health inconsistently — some rows are a
// fraction (0.93, or 1 for a fresh cell), others are already a percentage
// (93, 100). Anything at or below 1 is read as a fraction.
function batteryPercent(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const pct = n <= 1 ? Math.round(n * 100) : Math.round(n);
  return pct > 0 && pct <= 100 ? pct : null;
}

// Grades come straight off the supplier's sheet when a grade column exists.
// Only our own scale is accepted; anything else is left blank for the Stock
// page to fill in later.
function grade(v) {
  const g = str(v, 8).toUpperCase().replace(/\s+/g, "");
  return GRADES.includes(g) ? g : "";
}

function currency(v) {
  const c = str(v, 8).toUpperCase();
  return CURRENCIES.includes(c) ? c : "AUD";
}

// ── Blackbelt sweep ─────────────────────────────────────────────────
// Ask Blackbelt about one code and shape the answer as line fields. Never
// throws — a failure is just an "error" status on the line.
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

// Push a "found" result onto the register record for that IMEI.
//
// The upload files every listed unit as "Not Yet Received" carrying the
// supplier's own wording ("14-128 CH"), and until now that stood until the
// unit was physically received. Blackbelt is the authority on what a device
// is, so its answer goes onto the register as soon as it lands — the Stock
// page then reads the same identity the receive dialog is showing.
//
// Only devices we still hold are touched. A Sold or Out-for-Repair unit has
// its identity snapshotted onto an order or repair batch, and quietly
// changing the register underneath those would leave the two disagreeing.
const REGISTER_UPDATABLE = [STATUS_NOT_RECEIVED, STATUS_IN_STOCK];

async function applyBlackbeltToRegister(db, code, result, by) {
  if (!result || result.bbStatus !== "found") return 0;
  const bb = result.bbDevice || {};

  // Only what Blackbelt actually answered. Some reports come back with an
  // empty colour; blanking the supplier's value would be a downgrade.
  const answered = {};
  for (const [field, value] of [
    ["brand", bb.brand],
    ["model", bb.model],
    ["color", bb.color],
    ["storage", bb.storage],
    ["serialNumber", bb.serialNumber],
    ["batteryCapacity", bb.batteryCapacity],
    ["aNumber", bb.aNumber],
  ]) {
    if (value) answered[field] = value;
  }
  if (bb.batteryHealth != null) answered.batteryHealth = bb.batteryHealth;
  if (bb.batteryCycleCount != null) answered.batteryCycleCount = bb.batteryCycleCount;

  const devices = await db
    .collection(DEVICES)
    .find({ imei: code, status: { $in: REGISTER_UPDATABLE } })
    .toArray();
  if (!devices.length) return 0;

  const now = new Date();
  let updated = 0;
  for (const d of devices) {
    // Identity fields that genuinely move, so a re-check of an already
    // correct device doesn't add a history line saying nothing changed.
    const changes = Object.entries(answered).filter(([f, v]) => d[f] !== v);
    const newlyChecked = d.blackbeltChecked !== true;
    const reportChanged = !!result.bbReportId && d.blackbeltReportId !== result.bbReportId;
    if (!changes.length && !newlyChecked && !reportChanged) continue;

    const $set = { ...answered, blackbeltChecked: true, updatedAt: now };
    if (result.bbReportId) $set.blackbeltReportId = result.bbReportId;
    if (bb.reportStatus) $set.blackbeltStatus = bb.reportStatus;

    const described = changes
      .filter(([f]) => ["model", "color", "storage", "brand"].includes(f))
      .map(([f, v]) => `${f} → ${v}`)
      .join(", ");
    const action = described
      ? `Blackbelt check updated ${described}`
      : "Blackbelt check confirmed the device details";

    await db.collection(DEVICES).updateOne(
      { _id: d._id },
      { $set, $push: { history: { $each: [{ at: now, by, action }], $slice: -100 } } },
    );
    updated += 1;
  }
  return updated;
}

// Runs after a batch is created, outside the request. Each result is written
// as it lands so the page can show progress, and a crash mid-sweep just
// leaves lines "pending" for the recheck endpoint to pick up.
const sweeping = new Set(); // batch ids with a sweep in flight

async function sweepBlackbelt(batchId, codes, by = null) {
  const key = String(batchId);
  if (sweeping.has(key)) return;
  sweeping.add(key);
  try {
    const db = await connectToDatabase();
    const queue = codes.slice();

    const worker = async () => {
      for (;;) {
        const code = queue.shift();
        if (!code) return;
        const set = await askBlackbelt(code);

        const $set = {};
        for (const k of Object.keys(set)) $set[`lines.$[l].${k}`] = set[k];
        $set.updatedAt = new Date();
        try {
          await db.collection(BATCHES).updateOne(
            { _id: batchId },
            { $set, $inc: { "blackbelt.done": 1 } },
            { arrayFilters: [{ "l.code": code }] },
          );
        } catch (e) {
          console.error("Incoming Blackbelt write failed:", (e && e.message) || e);
        }
        // The register carries the same device, so it learns the same
        // answer. Kept separate from the batch write: failing to update a
        // register row must not cost the batch its Blackbelt result.
        try {
          await applyBlackbeltToRegister(db, code, set, by);
        } catch (e) {
          console.error("Incoming Blackbelt register write failed:", (e && e.message) || e);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(BLACKBELT_CONCURRENCY, queue.length) }, worker),
    );
    await db
      .collection(BATCHES)
      .updateOne({ _id: batchId }, { $set: { "blackbelt.running": false } });
  } catch (e) {
    console.error("Incoming Blackbelt sweep failed:", (e && e.message) || e);
  } finally {
    sweeping.delete(key);
  }
}

// Counts the page needs, derived rather than stored so they can't drift.
function summarize(batch) {
  const lines = Array.isArray(batch.lines) ? batch.lines : [];
  let received = 0, committed = 0, inBlackbelt = 0, pending = 0, unresolved = 0, unlisted = 0;
  for (const l of lines) {
    if (l.received) received += 1;
    if (l.deviceId) committed += 1;
    if (l.bbStatus === "found") inBlackbelt += 1;
    if (!l.bbStatus || l.bbStatus === "pending") pending += 1;
    // "none" is a real answer; pending / error / skipped are not.
    if (!l.bbStatus || l.bbStatus === "pending" || l.bbStatus === "error" || l.bbStatus === "skipped") {
      unresolved += 1;
    }
    if (l.unlisted) unlisted += 1;
  }
  return {
    total: lines.length,
    listed: lines.length - unlisted,
    unlisted,
    received,
    committed,
    inBlackbelt,
    blackbeltPending: pending,
    blackbeltUnresolved: unresolved,
  };
}

// ── GET /refurbished/incoming ───────────────────────────────────────
router.get("/", MANAGE, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const batches = await db
      .collection(BATCHES)
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return res.json({
      success: true,
      rows: batches.map((b) => ({
        _id: b._id,
        title: b.title,
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
    console.error("Incoming list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load batches" });
  }
});

// ── POST /refurbished/incoming ──────────────────────────────────────
// Body: { title, stockSource, currency, note, rows: [{ no, code, model, color,
// capacity, battery, price }] } — the sheet is parsed in the browser, the
// same way dispatch lists are uploaded.
router.post("/", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    const title = str(body.title, 120);
    if (!title) return res.status(400).json({ success: false, message: "Title is required" });

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, message: "The list is empty" });
    if (rows.length > 2000) {
      return res.status(400).json({ success: false, message: "That list is too large (max 2000 rows)" });
    }

    const lines = [];
    const seen = new Set();
    const rejected = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const code = normalizeCode(r.code);
      if (!CODE_RE.test(code)) {
        rejected.push({ row: i + 1, code: str(r.code, 40), reason: "Not a valid IMEI or serial" });
        continue;
      }
      if (seen.has(code)) {
        rejected.push({ row: i + 1, code, reason: "Duplicated in this file" });
        continue;
      }
      seen.add(code);
      lines.push({
        no: num(r.no),
        code,
        // Colour and capacity are uppercased so mixed supplier casings
        // read uniformly; model keeps its casing to match Blackbelt.
        model: str(r.model, 120),
        color: str(r.color, 60).toUpperCase(),
        capacity: str(r.capacity, 40).toUpperCase(),
        battery: batteryPercent(r.battery),
        price: num(r.price),
        // Straight from the sheet when it has a grade column we recognise.
        grade: grade(r.grade),
        // Blackbelt sweep fills these in.
        bbStatus: "pending",
        bbMessage: "",
        bbReportId: "",
        bbDevice: null,
        // Stock take.
        received: false,
        receivedAt: null,
        receivedBy: null,
        unlisted: false,
        deviceId: null,
        committedAt: null,
      });
    }
    if (!lines.length) {
      return res.status(400).json({ success: false, message: "No usable rows in that file", rejected });
    }

    const db = await connectToDatabase();

    // A code already in stock is worth knowing about before the shipment
    // even arrives, so flag it up front rather than at commit time.
    const known = await db
      .collection(DEVICES)
      .find({ imei: { $in: lines.map((l) => l.code) } }, { projection: { imei: 1 } })
      .toArray();
    const inStock = new Set(known.map((d) => d.imei));
    for (const l of lines) l.alreadyInStock = inStock.has(l.code);

    const now = new Date();
    const doc = {
      title,
      currency: currency(body.currency),
      // Fixed at upload: every device received against this batch is filed
      // under it, whoever does the receiving.
      stockSource: normalizeStockSource(body.stockSource, DEFAULT_STOCK_SOURCE),
      note: str(body.note, 500),
      lines,
      blackbelt: { total: lines.length, done: 0, running: false },
      createdAt: now,
      updatedAt: now,
      createdBy: (req.user && req.user.username) || null,
    };
    const r = await db.collection(BATCHES).insertOne(doc);

    // Every listed unit goes onto the register immediately: status "Not
    // Yet Received", no location until it physically lands. Codes already
    // in the register are left alone (they're flagged on the line).
    const toCreate = lines.filter((l) => !l.alreadyInStock);
    let onRegister = 0;
    if (toCreate.length) {
      const docs = toCreate.map((l) => ({
        imei: l.code,
        brand: "",
        model: l.model || "",
        color: l.color || "",
        storage: l.capacity || "",
        grade: l.grade || "",
        costPrice: l.price == null ? null : Number(l.price),
        currency: doc.currency,
        stockSource: doc.stockSource,
        location: "",
        status: STATUS_NOT_RECEIVED,
        salesOrder: null,
        serialNumber: "",
        batteryHealth: l.battery,
        batteryCycleCount: null,
        batteryCapacity: "",
        aNumber: "",
        blackbeltChecked: false,
        blackbeltReportId: "",
        blackbeltStatus: "",
        note: "",
        incomingBatchId: r.insertedId,
        history: [
          { at: now, by: doc.createdBy, action: "created", note: `Uploaded on ${title} — not yet received` },
        ],
        createdAt: now,
        updatedAt: now,
        createdBy: doc.createdBy,
      }));
      try {
        const ins = await db.collection(DEVICES).insertMany(docs, { ordered: false });
        onRegister = ins.insertedCount;
      } catch (e) {
        // A race on a duplicate IMEI skips that one row, not the batch.
        onRegister = (e && e.result && e.result.insertedCount) || 0;
      }
    }

    // Deliberately no Blackbelt sweep here — lines stay "pending" until the
    // Check Blackbelt button fires the recheck endpoint.
    return res.json({ success: true, id: r.insertedId, accepted: lines.length, onRegister, rejected });
  } catch (e) {
    console.error("Incoming create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create the batch" });
  }
});

async function loadBatch(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Bad id" });
    return null;
  }
  const db = await connectToDatabase();
  const batch = await db.collection(BATCHES).findOne({ _id: new ObjectId(req.params.id) });
  if (!batch) {
    res.status(404).json({ success: false, message: "Batch not found" });
    return null;
  }
  return { db, batch };
}

// ── GET /refurbished/incoming/:id ───────────────────────────────────
router.get("/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    return res.json({ success: true, batch: { ...ctx.batch, summary: summarize(ctx.batch) } });
  } catch (e) {
    console.error("Incoming get error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the batch" });
  }
});

// ── POST /refurbished/incoming/:id/commit ───────────────────────────
// Body: { codes: [...], grades: { code: grade }, location } — every code
// the warehouse scanned this session, grades picked in the dialog for lines
// the sheet left ungraded (a sheet grade always wins), and the location the
// received devices are filed under (whitelisted; defaults to iMobile).
// Scanning itself is client-side; this one call does the whole thing:
// listed codes are marked received, codes not on the supplier's list are
// appended as unlisted lines (Blackbelt answered inline — they missed the
// upload sweep), and every received line not already in stock becomes a
// device under the batch's stock source. Blackbelt's answer wins over the
// supplier's spreadsheet where they disagree — it's the one that actually
// looked at the handset.
// Scanned codes from a dialog, normalized and de-duplicated.
function parseCodes(body) {
  return [
    ...new Set(
      (Array.isArray(body && body.codes) ? body.codes : [])
        .map(normalizeCode)
        .filter((c) => CODE_RE.test(c)),
    ),
  ];
}

// Shared by /commit and /sell: turn scanned codes into stock records against
// this batch. Codes that aren't on the supplier's list become unlisted lines
// (with a live Blackbelt lookup), every scanned line is marked received, and
// each new device is inserted under the batch's stock source.
//
// `sale`, when given, is the order the devices are being sold on: they land
// as Sold carrying its stamp instead of going into stock, and the created
// device docs come back so the caller can build the order's lines.
async function receiveScanned({ db, batch }, req, codes, { location, sale = null }) {
  const now = new Date();
  const who = (req.user && req.user.username) || null;
  const byCode = new Map((batch.lines || []).map((l) => [l.code, l]));

  // Grades picked in the dialog, validated and keyed by normalized code.
  const picks = {};
  const rawPicks = (req.body && req.body.grades) || {};
  for (const k of Object.keys(rawPicks)) {
    const g = grade(rawPicks[k]);
    if (g) picks[normalizeCode(k)] = g;
  }
  // A sheet grade always wins over a dialog pick.
  const gradeFor = (l) => l.grade || picks[l.code] || "";

  // Model / colour / capacity corrected in the dialog for lines Blackbelt
  // has no report on — the supplier's own wording is often a shorthand
  // ("14-128 CH"). Blackbelt still wins wherever it has a value.
  const details = {};
  const rawDetails = (req.body && req.body.details) || {};
  for (const k of Object.keys(rawDetails)) {
    const d = rawDetails[k] || {};
    details[normalizeCode(k)] = {
      model: str(d.model, 120),
      color: str(d.color, 60).toUpperCase(),
      capacity: str(d.storage || d.capacity, 40).toUpperCase(),
    };
  }

  // Codes that aren't on the supplier's list become unlisted lines. Their
  // Blackbelt lookups missed the upload sweep, so they run here — a few
  // at a time, like the sweep, so a pile of extras doesn't serialize.
  const extras = [];
  const extraQueue = codes.filter((c) => !byCode.has(c));
  const lookupWorker = async () => {
    for (;;) {
      const code = extraQueue.shift();
      if (!code) return;
      const bb = await askBlackbelt(code);
      const extra = {
        no: null,
        code,
        model: "",
        color: "",
        capacity: "",
        battery: null,
        price: null,
        grade: "",
        ...bb,
        received: false,
        receivedAt: null,
        receivedBy: null,
        unlisted: true,
        alreadyInStock: false,
        deviceId: null,
        committedAt: null,
      };
      extras.push(extra);
      byCode.set(code, extra);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BLACKBELT_CONCURRENCY, extraQueue.length) }, lookupWorker),
  );
  if (extras.length) {
    await db.collection(BATCHES).updateOne(
      { _id: batch._id },
      {
        $push: { lines: { $each: extras } },
        $inc: { "blackbelt.total": extras.length, "blackbelt.done": extras.length },
      },
    );
  }

  // Full docs, not just imeis: a device pre-created at upload ("Not Yet
  // Received") is received by updating it, and its stored values are the
  // fallback wherever the sheet and Blackbelt are silent.
  const existing = await db
    .collection(DEVICES)
    .find({ imei: { $in: codes } })
    .toArray();
  const heldByImei = new Map(existing.map((d) => [d.imei, d]));

  let created = 0;
  const skipped = [];
  const devices = [];

  // A bulk receive is two Mongo round-trips per device; done one at a
  // time that outlives the client's request timeout, so a small pool runs
  // several devices at once. Per-device semantics are unchanged — each
  // code still gets its own insert + line update and its own error.
  const COMMIT_CONCURRENCY = 8;
  const commitQueue = codes.slice();

  const commitOne = async (code) => {
    const l = byCode.get(code);
    if (l.deviceId) {
      skipped.push({ code, reason: "Already added from this batch" });
      return;
    }
    // The unit was physically scanned, so it's received either way — a
    // clash with the stock register only blocks the device creation.
    const receive = {
      "lines.$[l].received": true,
      "lines.$[l].receivedAt": now,
      "lines.$[l].receivedBy": who,
      "lines.$[l].grade": gradeFor(l),
    };
    const held = heldByImei.get(code);
    if (held && held.status !== STATUS_NOT_RECEIVED) {
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        { $set: { ...receive, "lines.$[l].alreadyInStock": true } },
        { arrayFilters: [{ "l.code": code }] },
      );
      skipped.push({ code, reason: "Already in stock" });
      return;
    }
    const bb = l.bbDevice || {};
    const history = [
      {
        at: now,
        by: who,
        action: held ? `Received — ${batch.title}` : "created",
        note: held ? "" : `Received via Incoming Stocks — ${batch.title}`,
      },
    ];
    if (sale) {
      history.push({
        at: now,
        by: who,
        action: `Sold on ${sale.orderNo} to ${sale.customerName}`,
      });
    }
    const fix = details[code] || {};
    const doc = {
      imei: code,
      brand: bb.brand || "",
      model: bb.model || fix.model || l.model || "",
      color: bb.color || fix.color || l.color || "",
      storage: bb.storage || fix.capacity || l.capacity || "",
      grade: gradeFor(l),
      costPrice: l.price == null ? null : Number(l.price),
      currency: batch.currency || "AUD",
      stockSource: normalizeStockSource(batch.stockSource, DEFAULT_STOCK_SOURCE),
      location,
      // Sale status. Sold straight off the shipment when this receive is
      // part of a sale; otherwise the unit goes into stock.
      status: sale ? "Sold" : "In Stock",
      salesOrder: sale
        ? {
            id: sale.orderId,
            orderNo: sale.orderNo,
            customerName: sale.customerName,
            soldAt: now,
          }
        : null,
      serialNumber: bb.serialNumber || "",
      batteryHealth: bb.batteryHealth != null ? bb.batteryHealth : l.battery,
      batteryCycleCount: bb.batteryCycleCount == null ? null : bb.batteryCycleCount,
      batteryCapacity: bb.batteryCapacity || "",
      aNumber: bb.aNumber || "",
      blackbeltChecked: l.bbStatus === "found",
      blackbeltReportId: l.bbReportId || "",
      blackbeltStatus: bb.reportStatus || "",
      note: "",
      incomingBatchId: batch._id,
      history,
      createdAt: now,
      updatedAt: now,
      createdBy: who,
    };
    try {
      let deviceId;
      if (held) {
        // Pre-created at upload — receiving fills it in and puts it
        // somewhere. Sheet/Blackbelt values win; the stored ones back
        // them up. The status guard keeps a concurrent receive honest.
        const set = {
          model: doc.model || held.model || "",
          color: doc.color || held.color || "",
          storage: doc.storage || held.storage || "",
          grade: doc.grade || held.grade || "",
          brand: doc.brand || held.brand || "",
          serialNumber: doc.serialNumber || held.serialNumber || "",
          costPrice: doc.costPrice == null ? held.costPrice : doc.costPrice,
          batteryHealth: doc.batteryHealth == null ? held.batteryHealth : doc.batteryHealth,
          batteryCycleCount: doc.batteryCycleCount == null ? held.batteryCycleCount : doc.batteryCycleCount,
          batteryCapacity: doc.batteryCapacity || held.batteryCapacity || "",
          aNumber: doc.aNumber || held.aNumber || "",
          blackbeltChecked: held.blackbeltChecked === true || doc.blackbeltChecked,
          blackbeltReportId: doc.blackbeltReportId || held.blackbeltReportId || "",
          blackbeltStatus: doc.blackbeltStatus || held.blackbeltStatus || "",
          location,
          status: doc.status,
          salesOrder: doc.salesOrder,
          incomingBatchId: batch._id,
          updatedAt: now,
        };
        const u = await db.collection(DEVICES).findOneAndUpdate(
          { _id: held._id, status: STATUS_NOT_RECEIVED },
          {
            $set: set,
            $push: { history: { $each: history, $slice: -100 } },
          },
          { returnDocument: "after" },
        );
        const updatedDoc = u ? u.value || u : null;
        if (!updatedDoc) {
          skipped.push({ code, reason: "Already in stock" });
          return;
        }
        deviceId = held._id;
        devices.push(updatedDoc);
      } else {
        const r = await db.collection(DEVICES).insertOne(doc);
        deviceId = r.insertedId;
        devices.push({ ...doc, _id: r.insertedId });
      }
      await db.collection(BATCHES).updateOne(
        { _id: batch._id },
        { $set: { ...receive, "lines.$[l].deviceId": deviceId, "lines.$[l].committedAt": now } },
        { arrayFilters: [{ "l.code": code }] },
      );
      created += 1;
    } catch (e) {
      skipped.push({ code, reason: (e && e.message) || "Insert failed" });
    }
  };

  const commitWorker = async () => {
    for (;;) {
      const code = commitQueue.shift();
      if (!code) return;
      await commitOne(code);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(COMMIT_CONCURRENCY, commitQueue.length) }, commitWorker),
  );

  await db.collection(BATCHES).updateOne({ _id: batch._id }, { $set: { updatedAt: now } });
  return { created, skipped, devices, now };
}

router.post("/:id/commit", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;

    const codes = parseCodes(req.body);
    if (!codes.length) {
      return res.json({ success: true, created: 0, skipped: [], message: "Nothing scanned" });
    }
    if (codes.length > 2000) {
      return res.status(400).json({ success: false, message: "Too many codes in one commit" });
    }

    const { created, skipped } = await receiveScanned(ctx, req, codes, {
      location: normalizeReceiveLocation(req.body && req.body.location),
    });
    return res.json({ success: true, created, skipped });
  } catch (e) {
    console.error("Incoming commit error:", e);
    return res.status(500).json({ success: false, message: "Failed to add to stock" });
  }
});

// ── POST /refurbished/incoming/:id/sell ─────────────────────────────
// Sell scanned units straight off the shipment: the stock records and the
// sales order are created together, so the devices never sit in stock. They
// are still filed at the iMobile location — location says where a unit
// physically sits, and "sold" is carried by the status, not the location.
//
// Body: { codes, grades, customerId, currency, notes, prices: { code: price } }
router.post("/:id/sell", MANAGE, SELL, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;

    const codes = parseCodes(req.body);
    if (!codes.length) {
      return res.status(400).json({ success: false, message: "Select at least one device" });
    }
    if (codes.length > 200) {
      return res.status(400).json({ success: false, message: "Too many devices in one sale (max 200)" });
    }

    const customerId = ObjectId.isValid(req.body && req.body.customerId)
      ? new ObjectId(req.body.customerId)
      : null;
    if (!customerId) {
      return res.status(400).json({ success: false, message: "A customer is required" });
    }
    const customer = await db.collection(CUSTOMERS).findOne({ _id: customerId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    // Sale prices keyed by normalized code (cost comes from the sheet).
    const prices = {};
    const rawPrices = (req.body && req.body.prices) || {};
    for (const k of Object.keys(rawPrices)) prices[normalizeCode(k)] = rawPrices[k];

    // The order id is minted up front so each device can carry its stamp as
    // it's inserted; the order itself is written once the devices exist.
    const orderId = new ObjectId();
    const { seq, orderNo } = await nextOrderNumber(db);
    const currency = normalizeCurrency(req.body && req.body.currency);

    const { created, skipped, devices, now } = await receiveScanned(ctx, req, codes, {
      location: LOCATION_IMOBILE,
      sale: { orderId, orderNo, customerName: customer.name },
    });

    if (!created) {
      return res.status(400).json({
        success: false,
        message: skipped.length
          ? `Nothing could be sold — ${skipped[0].reason}`
          : "No devices were created",
        skipped,
      });
    }

    const lines = devices.map((d) => deviceLine(d, prices[d.imei]));
    const order = {
      _id: orderId,
      orderNo,
      seq,
      customerId,
      customerName: customer.name,
      currency,
      notes: String((req.body && req.body.notes) || "").trim().slice(0, 1000),
      lines,
      ...computeTotals(lines, req.body && req.body.gstRate),
      // Same lifecycle as an order raised from the register: starts Pending,
      // locked once confirmed.
      status: "Pending",
      confirmedAt: null,
      confirmedBy: null,
      // Where these units came from — this order was raised off a shipment
      // rather than from the stock register.
      incomingBatchId: batch._id,
      incomingBatchTitle: batch.title,
      createdAt: now,
      createdBy: (req.user && req.user.username) || null,
      cancelledAt: null,
      cancelledBy: null,
    };
    await db.collection(ORDERS).insertOne(order);

    return res.json({ success: true, created, skipped, order });
  } catch (e) {
    console.error("Incoming sell error:", e);
    return res.status(500).json({ success: false, message: "Failed to create the sale" });
  }
});

// ── GET /refurbished/incoming/:id/received ──────────────────────────
// Everything counted in against this batch, joined to where it ended up:
// its location in the register and, if it has since been sold, the sales
// order number and customer. Feeds the batch's "Download Received" export.
router.get("/:id/received", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;

    const lines = (batch.lines || []).filter((l) => l.received || l.deviceId);
    if (!lines.length) return res.json({ success: true, title: batch.title, rows: [] });

    // Devices created by this batch, plus any line that was already in the
    // register when it was scanned (matched on the code).
    const ids = lines.map((l) => l.deviceId).filter(Boolean);
    const codes = lines.map((l) => l.code);
    const devices = await db
      .collection(DEVICES)
      .find({ $or: [{ _id: { $in: ids } }, { imei: { $in: codes } }] })
      .toArray();
    const byId = new Map(devices.map((d) => [String(d._id), d]));
    const byCode = new Map(devices.map((d) => [d.imei, d]));

    const rows = lines.map((l) => {
      const d = (l.deviceId && byId.get(String(l.deviceId))) || byCode.get(l.code) || null;
      const so = (d && d.salesOrder) || null;
      const bb = l.bbDevice || {};
      return {
        code: l.code,
        model: (d && d.model) || bb.model || l.model || "",
        color: (d && d.color) || bb.color || l.color || "",
        storage: (d && d.storage) || bb.storage || l.capacity || "",
        grade: (d && d.grade) || l.grade || "",
        batteryHealth: d && d.batteryHealth != null ? d.batteryHealth : l.battery,
        costPrice: d && d.costPrice != null ? d.costPrice : l.price,
        currency: (d && d.currency) || batch.currency || "",
        stockSource: (d && d.stockSource) || batch.stockSource || "",
        location: (d && d.location) || "",
        status: (d && d.status) || "",
        orderNo: (so && so.orderNo) || "",
        customerName: (so && so.customerName) || "",
        soldAt: (so && so.soldAt) || null,
        receivedAt: l.receivedAt || null,
        receivedBy: l.receivedBy || "",
        unlisted: !!l.unlisted,
        // Scanned here but the register already had it — the device row
        // belongs to whichever batch first recorded it.
        alreadyInStock: !!l.alreadyInStock,
        inRegister: !!d,
      };
    });

    return res.json({ success: true, title: batch.title, rows });
  } catch (e) {
    console.error("Incoming received export error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the received list" });
  }
});

// ── POST /refurbished/incoming/:id/recheck ──────────────────────────
// Runs Blackbelt for lines without a found report. This is the Check
// Blackbelt button's trigger (uploads don't sweep automatically). Body may
// carry { codes: [...] } — the dialog sends the selected rows so lookups
// are only spent on the devices actually being received; without it every
// line still waiting on an answer is swept.
router.post("/:id/recheck", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;
    if (!blackbelt.isConfigured()) {
      return res.json({ success: true, queued: 0, message: "Blackbelt is not configured" });
    }
    const wanted = Array.isArray(req.body && req.body.codes)
      ? new Set(req.body.codes.map(normalizeCode).filter((c) => CODE_RE.test(c)))
      : null;
    const codes = (batch.lines || [])
      .filter((l) => l.bbStatus !== "found")
      .filter((l) => !wanted || wanted.has(l.code))
      .map((l) => l.code);
    if (!codes.length) return res.json({ success: true, queued: 0 });

    const done = (batch.lines || []).length - codes.length;
    await db
      .collection(BATCHES)
      .updateOne(
        { _id: batch._id },
        { $set: { blackbelt: { total: (batch.lines || []).length, done, running: true } } },
      );
    sweepBlackbelt(batch._id, codes, (req.user && req.user.username) || null);
    return res.json({ success: true, queued: codes.length });
  } catch (e) {
    console.error("Incoming recheck error:", e);
    return res.status(500).json({ success: false, message: "Failed to re-check" });
  }
});

// ── DELETE /refurbished/incoming/:id ────────────────────────────────
// Received devices are real stock and are left alone — deleting the
// paperwork shouldn't silently delete them. The upload's never-received
// register entries go with the batch, though: they only ever described
// this shipment.
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const gone = await ctx.db
      .collection(DEVICES)
      .deleteMany({ incomingBatchId: ctx.batch._id, status: STATUS_NOT_RECEIVED });
    await ctx.db.collection(BATCHES).deleteOne({ _id: ctx.batch._id });
    return res.json({ success: true, removedDevices: gone.deletedCount });
  } catch (e) {
    console.error("Incoming delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the batch" });
  }
});

module.exports = router;

// Mark the batch lines for these devices received.
//
// Selling an unreceived unit proves it arrived — you cannot ship what you
// do not have — so the shipment paperwork is closed off rather than left
// showing a line the warehouse will hunt for. Exported because the sales
// order path drives it; kept here so the "received" shape is written in one
// place and can't drift from the receive dialog's own.
//
// Devices carry `incomingBatchId` from the upload, so no lookup by IMEI is
// needed. Safe to call with an empty list, and safe to call twice.
async function receiveLinesForDevices(db, devices, who, note) {
  const onBatches = (devices || []).filter((d) => d && d.incomingBatchId && d.imei);
  if (!onBatches.length) return 0;

  const byBatch = new Map();
  for (const d of onBatches) {
    const key = String(d.incomingBatchId);
    if (!byBatch.has(key)) byBatch.set(key, { id: d.incomingBatchId, codes: [] });
    byBatch.get(key).codes.push(d.imei);
  }

  const now = new Date();
  let updated = 0;
  for (const { id, codes } of byBatch.values()) {
    const r = await db.collection(BATCHES).updateOne(
      { _id: id },
      {
        $set: {
          "lines.$[l].received": true,
          "lines.$[l].receivedAt": now,
          "lines.$[l].receivedBy": who || null,
          "lines.$[l].receivedNote": note || "",
          updatedAt: now,
        },
      },
      // Only lines not already received, so a re-run can't rewrite a
      // genuine receive date with a later one.
      { arrayFilters: [{ "l.code": { $in: codes }, "l.received": { $ne: true } }] },
    );
    updated += r.modifiedCount;
  }
  return updated;
}

module.exports.receiveLinesForDevices = receiveLinesForDevices;
