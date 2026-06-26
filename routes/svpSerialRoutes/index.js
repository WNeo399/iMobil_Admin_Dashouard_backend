// Admin management of the Apple SVP genuine-serial list (imb_svp_serials).
//
// The supplier provides a flat list of genuine part serial numbers (no
// database). Staff upload the sheet from the dashboard — the frontend parses
// the Excel in the browser and POSTs the serial array here. We store one doc
// per normalized serial (the serial IS the _id, so lookups are an indexed
// findOne and re-imports can't create duplicates).
//
// Mounted under the authenticated chain in app.js.

var express = require("express");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const { normalizeSerial } = require("../../utils/svpSerial");

const COLLECTION = "imb_svp_serials";
const META = "imb_svp_serials_meta"; // single doc tracking last import
// Serials spot-checked on the admin page that weren't on record. One doc per
// normalized serial (serial IS the _id) with a hit count, so the same serial
// checked twice doesn't duplicate. Downloadable / clearable below.
const MISSES = "imb_svp_serial_misses";

const VIEW = requirePermission("svp:serial:view");
const MANAGE = requirePermission("svp:serial:manage");

// ── GET /svpSerial/stats ────────────────────────────────────────────
// Current total + when/how it was last refreshed (for the admin page).
router.get("/stats", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const count = await db.collection(COLLECTION).countDocuments({});
    const meta = await db.collection(META).findOne({ _id: "meta" });
    const missCount = await db.collection(MISSES).countDocuments({});
    return res.json({
      success: true,
      count,
      lastImportedAt: (meta && meta.lastImportedAt) || null,
      lastMode: (meta && meta.lastMode) || null,
      lastSubmitted: (meta && meta.lastSubmitted) || null,
      lastBy: (meta && meta.lastBy) || null,
      missCount,
    });
  } catch (error) {
    console.error("SVP serial stats error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load serial stats" });
  }
});

// ── GET /svpSerial/check?serial= ────────────────────────────────────
// Spot-check a single serial from the admin page (same normalization as the
// public lookup).
router.get("/check", VIEW, async function (req, res) {
  try {
    const serial = normalizeSerial(req.query.serial);
    if (!serial) {
      return res
        .status(400)
        .json({ success: false, message: "serial is required" });
    }
    const db = await connectToDatabase();
    const hit = await db.collection(COLLECTION).findOne({ _id: serial });

    // Log serials that came back not-found so staff can download them later
    // (e.g. to send back to the supplier). Deduplicated by serial with a hit
    // count; a failure here must not break the check itself.
    if (!hit) {
      try {
        await db.collection(MISSES).updateOne(
          { _id: serial },
          {
            $setOnInsert: { _id: serial, firstCheckedAt: new Date() },
            $set: {
              lastCheckedAt: new Date(),
              lastBy: (req.user && req.user.username) || "system",
            },
            $inc: { count: 1 },
          },
          { upsert: true },
        );
      } catch (logErr) {
        console.error("SVP serial miss log error:", logErr);
      }
    }

    return res.json({ success: true, found: !!hit, serial });
  } catch (error) {
    console.error("SVP serial check error:", error);
    return res.status(500).json({ success: false, message: "Lookup failed" });
  }
});

// ── POST /svpSerial/import ──────────────────────────────────────────
// Body: { serials: string[], mode: 'replace' | 'merge' }
//   replace (default) — the new sheet IS the list: clear, then insert.
//   merge             — add the new serials on top of the existing list.
router.post("/import", MANAGE, async function (req, res) {
  try {
    const body = req.body || {};
    const mode = body.mode === "merge" ? "merge" : "replace";
    const raw = Array.isArray(body.serials) ? body.serials : [];

    // Normalize + dedupe before touching the DB.
    const set = new Set();
    for (const s of raw) {
      const n = normalizeSerial(s);
      if (n) set.add(n);
    }
    const serials = [...set];
    if (serials.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No valid serials found in the upload" });
    }

    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const now = new Date();

    if (mode === "replace") {
      await col.deleteMany({});
    }

    // Upsert in batches so a re-imported serial can't duplicate, and a huge
    // sheet doesn't build one giant op.
    const BATCH = 2000;
    let inserted = 0;
    for (let i = 0; i < serials.length; i += BATCH) {
      const chunk = serials.slice(i, i + BATCH);
      const ops = chunk.map((s) => ({
        updateOne: {
          filter: { _id: s },
          update: { $setOnInsert: { _id: s, addedAt: now } },
          upsert: true,
        },
      }));
      const r = await col.bulkWrite(ops, { ordered: false });
      inserted += r.upsertedCount || 0;
    }

    // Any serial we just put on record is no longer a "not found" — drop it
    // from the misses log so the download stays a list of still-unknown serials.
    await db.collection(MISSES).deleteMany({ _id: { $in: serials } });

    const total = await col.countDocuments({});
    await db.collection(META).updateOne(
      { _id: "meta" },
      {
        $set: {
          lastImportedAt: now,
          lastMode: mode,
          lastSubmitted: serials.length,
          lastBy: (req.user && req.user.username) || "system",
          lastCount: total,
        },
      },
      { upsert: true },
    );

    return res.json({
      success: true,
      mode,
      submitted: serials.length,
      inserted, // newly added (excludes ones already present on a merge)
      total,
    });
  } catch (error) {
    console.error("SVP serial import error:", error);
    return res.status(500).json({
      success: false,
      message: `Import failed: ${error.message || error}`,
    });
  }
});

// ── GET /svpSerial/misses ───────────────────────────────────────────
// The full list of serials checked here that weren't on record, newest first.
// The frontend turns this into a CSV download.
router.get("/misses", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const docs = await db
      .collection(MISSES)
      .find({})
      .sort({ lastCheckedAt: -1 })
      .toArray();
    const misses = docs.map((m) => ({
      serial: m._id,
      count: m.count || 1,
      firstCheckedAt: m.firstCheckedAt || null,
      lastCheckedAt: m.lastCheckedAt || null,
      lastBy: m.lastBy || null,
    }));
    return res.json({ success: true, count: misses.length, misses });
  } catch (error) {
    console.error("SVP serial misses error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load not-found serials" });
  }
});

// ── DELETE /svpSerial/misses ────────────────────────────────────────
// Clear the not-found log (after downloading it).
router.delete("/misses", MANAGE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const r = await db.collection(MISSES).deleteMany({});
    return res.json({ success: true, deleted: r.deletedCount || 0 });
  } catch (error) {
    console.error("SVP serial misses clear error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to clear not-found serials" });
  }
});

module.exports = router;
