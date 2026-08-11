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
} = require("./stockSource");

const MANAGE = requirePermission("refurb:incoming:manage");
const BATCHES = "refurb_incoming_batches";
const DEVICES = "refurb_devices";

const CURRENCIES = ["AUD", "CNY", "HKD"];
const GRADES = ["A+", "A", "B+", "B", "C+", "C"];
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

// Runs after a batch is created, outside the request. Each result is written
// as it lands so the page can show progress, and a crash mid-sweep just
// leaves lines "pending" for the recheck endpoint to pick up.
const sweeping = new Set(); // batch ids with a sweep in flight

async function sweepBlackbelt(batchId, codes) {
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
        // Uppercased so mixed supplier casings read uniformly.
        model: str(r.model, 120).toUpperCase(),
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

    // Deliberately no Blackbelt sweep here — lines stay "pending" until the
    // Check Blackbelt button fires the recheck endpoint.
    return res.json({ success: true, id: r.insertedId, accepted: lines.length, rejected });
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
router.post("/:id/commit", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    const { db, batch } = ctx;

    const codes = [
      ...new Set(
        (Array.isArray(req.body && req.body.codes) ? req.body.codes : [])
          .map(normalizeCode)
          .filter((c) => CODE_RE.test(c)),
      ),
    ];
    if (!codes.length) {
      return res.json({ success: true, created: 0, skipped: [], message: "Nothing scanned" });
    }
    if (codes.length > 2000) {
      return res.status(400).json({ success: false, message: "Too many codes in one commit" });
    }

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

    const location = normalizeReceiveLocation(req.body && req.body.location);

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

    const existing = await db
      .collection(DEVICES)
      .find({ imei: { $in: codes } }, { projection: { imei: 1 } })
      .toArray();
    const already = new Set(existing.map((d) => d.imei));

    let created = 0;
    const skipped = [];

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
      if (already.has(code)) {
        await db.collection(BATCHES).updateOne(
          { _id: batch._id },
          { $set: { ...receive, "lines.$[l].alreadyInStock": true } },
          { arrayFilters: [{ "l.code": code }] },
        );
        skipped.push({ code, reason: "Already in stock" });
        return;
      }
      const bb = l.bbDevice || {};
      const doc = {
        imei: code,
        brand: bb.brand || "",
        model: bb.model || l.model || "",
        color: bb.color || l.color || "",
        storage: bb.storage || l.capacity || "",
        grade: gradeFor(l),
        costPrice: l.price == null ? null : Number(l.price),
        currency: batch.currency || "AUD",
        stockSource: normalizeStockSource(batch.stockSource, DEFAULT_STOCK_SOURCE),
        location,
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
        history: [
          {
            at: now,
            by: who,
            action: "created",
            note: `Received via Incoming Stocks — ${batch.title}`,
          },
        ],
        createdAt: now,
        updatedAt: now,
        createdBy: who,
      };
      try {
        const r = await db.collection(DEVICES).insertOne(doc);
        await db.collection(BATCHES).updateOne(
          { _id: batch._id },
          { $set: { ...receive, "lines.$[l].deviceId": r.insertedId, "lines.$[l].committedAt": now } },
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
    return res.json({ success: true, created, skipped });
  } catch (e) {
    console.error("Incoming commit error:", e);
    return res.status(500).json({ success: false, message: "Failed to add to stock" });
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
    sweepBlackbelt(batch._id, codes);
    return res.json({ success: true, queued: codes.length });
  } catch (e) {
    console.error("Incoming recheck error:", e);
    return res.status(500).json({ success: false, message: "Failed to re-check" });
  }
});

// ── DELETE /refurbished/incoming/:id ────────────────────────────────
// Devices already added to stock are left alone — deleting the paperwork
// shouldn't silently delete the stock.
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadBatch(req, res);
    if (!ctx) return;
    await ctx.db.collection(BATCHES).deleteOne({ _id: ctx.batch._id });
    return res.json({ success: true });
  } catch (e) {
    console.error("Incoming delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the batch" });
  }
});

module.exports = router;
