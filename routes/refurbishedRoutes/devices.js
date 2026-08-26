// Refurbished Device — Stock. Our own register of refurbished handsets,
// one document per physical device keyed by IMEI (Mongo: refurb_devices).
// Distinct from routes/refurbishedRoutes/index.js, which is read-only
// market data scraped from Reebelo.
//
//   GET    /refurbished/devices          paginated + filterable list
//   GET    /refurbished/devices/filters  distinct models / grades / sources
//   POST   /refurbished/devices          add one device
//   PUT    /refurbished/devices/:id      edit one device
//   DELETE /refurbished/devices/:id      remove one device
//
// Mounted under the authenticated chain. Reading needs refurb:stock:view,
// writing refurb:stock:manage — both covered by refurb:*:* (iMobile Admin)
// and *:*:* (Admin).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const blackbelt = require("../../utils/blackbelt");
const {
  stockSourceForUser,
  locationForUser,
  RECEIVE_LOCATIONS,
  STATUS_WITH_SUPPLIER,
} = require("./stockSource");

const VIEW = requirePermission("refurb:stock:view");
const MANAGE = requirePermission("refurb:stock:manage");

// A phone supplier only ever works their own shelf: reads are narrowed to
// the stock source on their user record and writes must land on a device
// that already belongs to it. null = unscoped (staff see everything). A
// supplier with no source assigned scopes to a value no device carries, so
// they see an empty register rather than someone else's.
function supplierSource(user) {
  if (!user || user.role !== "phone-supplier") return null;
  return stockSourceForUser(user) || "\u0000unassigned";
}
// 404, not 403 — a device outside the supplier's scope should read as
// nonexistent rather than confirm it exists.
function outOfScope(user, device) {
  const src = supplierSource(user);
  return src !== null && (!device || device.stockSource !== src);
}
const DEVICES = "refurb_devices";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The register is keyed on whatever code identifies the unit. Phones give a
// 15-digit IMEI; iPads and Watches only have an alphanumeric Apple serial
// (10 or 12 chars), and both turn up in supplier lists, so letters are
// allowed. Spaces and dashes are stripped and the code uppercased so the
// same unit can't be recorded twice under different spellings.
function normalizeImei(v) {
  return String(v == null ? "" : v).replace(/[\s-]/g, "").trim().toUpperCase();
}
const CODE_RE = /^[A-Z0-9]{10,20}$/;
const CODE_HINT = "Enter a 10–20 character IMEI or serial number";

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Stock is bought in more than one market, so a cost price is only
// meaningful next to its currency. AUD is the default.
const CURRENCIES = ["AUD", "CNY", "HKD"];
const DEFAULT_CURRENCY = "AUD";
function currency(v) {
  const c = String(v == null ? "" : v).trim().toUpperCase();
  return CURRENCIES.includes(c) ? c : DEFAULT_CURRENCY;
}

// ── History ─────────────────────────────────────────────────────────
// Every device carries its own audit trail: one entry on creation and one
// per edit, with field-level before/after values. Capped so a much-edited
// device can't grow without bound.
const HISTORY_CAP = 100;

function historyEntry(user, action, extra) {
  return {
    at: new Date(),
    by: (user && user.username) || null,
    action,
    ...extra,
  };
}

// Field-level diff between the stored doc and a $set about to be applied.
// Only real changes are reported: null / "" / undefined all mean "empty".
function diffDevice(existing, set) {
  const changes = [];
  for (const k of Object.keys(set)) {
    if (k === "updatedAt" || k === "updatedBy") continue;
    const before = existing[k];
    const after = set[k];
    const empty = (v) => v === null || v === undefined || v === "";
    let same;
    if (k === "blackbeltChecked") same = !!before === !!after;
    else if (empty(before) && empty(after)) same = true;
    else same = before === after;
    if (!same) changes.push({ field: k, from: empty(before) ? null : before, to: empty(after) ? null : after });
  }
  return changes;
}

// Shape a request body into a device document. `partial` keeps undefined
// fields out of the $set on edit so a PUT only touches what it sends.
function buildDevice(body, { partial = false } = {}) {
  const doc = {};
  const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
  const set = (key, value) => {
    if (partial && value === undefined) return;
    doc[key] = value;
  };
  if (!partial || body.model !== undefined) set("model", str(body.model, 120));
  if (!partial || body.color !== undefined) set("color", str(body.color, 60));
  if (!partial || body.storage !== undefined) set("storage", str(body.storage, 40));
  if (!partial || body.grade !== undefined) set("grade", str(body.grade, 40));
  if (!partial || body.costPrice !== undefined) set("costPrice", num(body.costPrice));
  if (!partial || body.currency !== undefined) set("currency", currency(body.currency));
  if (!partial || body.blackbeltChecked !== undefined) {
    set("blackbeltChecked", body.blackbeltChecked === true || body.blackbeltChecked === "true");
  }
  if (!partial || body.note !== undefined) set("note", str(body.note, 500));
  // Extras that come back with a Blackbelt report.
  if (!partial || body.brand !== undefined) set("brand", str(body.brand, 60));
  if (!partial || body.serialNumber !== undefined) set("serialNumber", str(body.serialNumber, 60));
  if (!partial || body.batteryHealth !== undefined) set("batteryHealth", num(body.batteryHealth));
  if (!partial || body.batteryCycleCount !== undefined) set("batteryCycleCount", num(body.batteryCycleCount));
  if (!partial || body.batteryCapacity !== undefined) set("batteryCapacity", str(body.batteryCapacity, 40));
  if (!partial || body.aNumber !== undefined) set("aNumber", str(body.aNumber, 40));
  if (!partial || body.blackbeltReportId !== undefined) set("blackbeltReportId", str(body.blackbeltReportId, 120));
  if (!partial || body.blackbeltStatus !== undefined) set("blackbeltStatus", str(body.blackbeltStatus, 200));
  return doc;
}

// ── GET /refurbished/devices ────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 200);

    const match = {};
    // A comma-separated id list — the sales-order dialog re-reads the cost
    // of the devices already on an order in one call.
    if (req.query.ids) {
      const ids = String(req.query.ids)
        .split(",")
        .map((v) => v.trim())
        .filter((v) => ObjectId.isValid(v))
        .slice(0, 200)
        .map((v) => new ObjectId(v));
      if (ids.length) match._id = { $in: ids };
    }
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      match.$or = [
        { imei: rx },
        { serialNumber: rx },
        { model: rx },
        { color: rx },
        { stockSource: rx },
        { storage: rx },
      ];
    }
    if (req.query.grade) match.grade = String(req.query.grade);
    if (req.query.stockSource) match.stockSource = String(req.query.stockSource);
    // Applied after the query params so a crafted stockSource= can't widen
    // a supplier's view.
    const scope = supplierSource(req.user);
    if (scope !== null) match.stockSource = scope;
    if (req.query.location) match.location = String(req.query.location);
    if (req.query.model) match.model = String(req.query.model);
    // Sale status. Devices recorded before the field existed are unsold, so
    // "In Stock" also matches docs with no status at all. A comma list
    // matches any of the named statuses (the supply picker spans our stock
    // and the supplier's shelf).
    if (req.query.status) {
      const picked = String(req.query.status).split(",").map((v) => v.trim()).filter(Boolean);
      const withLegacy = picked.includes("In Stock") ? [...picked, null] : picked;
      match.status = withLegacy.length === 1 ? withLegacy[0] : { $in: withLegacy };
    }
    const checked = String(req.query.blackbeltChecked || "");
    if (checked === "true") match.blackbeltChecked = true;
    else if (checked === "false") match.blackbeltChecked = { $ne: true };

    const SORTABLE = ["imei", "model", "color", "storage", "grade", "costPrice", "stockSource", "createdAt"];
    const sortField = SORTABLE.includes(req.query.sort) ? req.query.sort : "createdAt";
    const sortDir = String(req.query.order).toLowerCase() === "asc" ? 1 : -1;

    const [total, rows, checkedCount, valueAgg] = await Promise.all([
      db.collection(DEVICES).countDocuments(match),
      db
        .collection(DEVICES)
        .find(match)
        .sort({ [sortField]: sortDir, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      db.collection(DEVICES).countDocuments({ ...match, blackbeltChecked: true }),
      db
        .collection(DEVICES)
        .aggregate([
          { $match: match },
          {
            $group: {
              // Devices recorded before currencies existed are AUD.
              _id: { $ifNull: ["$currency", DEFAULT_CURRENCY] },
              v: { $sum: { $ifNull: ["$costPrice", 0] } },
            },
          },
        ])
        .toArray(),
    ]);

    // Cost is only summable within a currency, so report one total each.
    const costTotals = {};
    for (const r of valueAgg) {
      if (r.v) costTotals[currency(r._id)] = (costTotals[currency(r._id)] || 0) + r.v;
    }

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      checkedCount,
      costTotals,
      rows,
    });
  } catch (e) {
    console.error("Refurb devices list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load devices" });
  }
});

// ── GET /refurbished/devices/filters ────────────────────────────────
router.get("/filters", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const scope = supplierSource(req.user);
    const distinct = async (field) =>
      (
        await db
          .collection(DEVICES)
          .aggregate([
            { $match: { [field]: { $nin: [null, ""] }, ...(scope !== null ? { stockSource: scope } : {}) } },
            { $group: { _id: `$${field}` } },
            { $sort: { _id: 1 } },
            { $limit: 500 },
          ])
          .toArray()
      ).map((r) => r._id);
    const [models, grades, stockSources, storages, colors, locations] = await Promise.all([
      distinct("model"),
      distinct("grade"),
      distinct("stockSource"),
      distinct("storage"),
      distinct("color"),
      distinct("location"),
    ]);
    return res.json({
      success: true,
      models,
      grades,
      stockSources,
      storages,
      colors,
      locations,
      statuses: ["In Stock", "Sold"],
    });
  } catch (e) {
    console.error("Refurb devices filters error:", e);
    return res.status(500).json({ success: false, message: "Failed to load filters" });
  }
});

// ── GET /refurbished/devices/lookup?imei= ───────────────────────────
// Device identity for an IMEI (or serial), from the Blackbelt Defence
// report. The Add Device dialog calls this so staff only type IMEI, grade
// and cost — brand / model / colour / storage / battery come back here.
// A device Blackbelt has a report for IS the "Blackbelt checked" state,
// so `blackbeltChecked` comes back true on a hit.
router.get("/lookup", VIEW, async (req, res) => {
  try {
    const imei = normalizeImei(req.query.imei);
    if (!imei) return res.status(400).json({ success: false, message: "IMEI is required" });
    // Serial numbers are allowed through — Blackbelt accepts either, and
    // routes on a Luhn check. Only reject something implausibly short.
    if (imei.length < 6) {
      return res.status(400).json({ success: false, message: "Enter a full IMEI or serial number" });
    }

    // Already in our register? Answer from there — no point asking
    // upstream about a device we've already recorded.
    const db = await connectToDatabase();
    const known = await db.collection(DEVICES).findOne({ imei });
    if (known && outOfScope(req.user, known)) {
      // The create would 409 anyway, so say it's taken — but none of the
      // other shelf's details go out with it.
      return res.json({
        success: true,
        source: "register",
        alreadyInStock: true,
        message: "This IMEI is already recorded in the register.",
        device: { imei },
      });
    }
    if (known) {
      return res.json({
        success: true,
        source: "register",
        alreadyInStock: true,
        device: {
          imei,
          brand: known.brand || "",
          model: known.model || "",
          color: known.color || "",
          storage: known.storage || "",
          stockSource: known.stockSource || "",
          serialNumber: known.serialNumber || "",
          batteryHealth: known.batteryHealth == null ? null : known.batteryHealth,
          batteryCycleCount: known.batteryCycleCount == null ? null : known.batteryCycleCount,
        },
      });
    }

    const r = await blackbelt.lookupDevice(imei);
    if (r && r.notConfigured) {
      return res.json({
        success: true,
        notConfigured: true,
        message:
          "Blackbelt credentials aren't set on the server — enter grade and cost, and the device details can be filled in later.",
        device: { imei, model: "", color: "", storage: "", stockSource: "" },
      });
    }
    if (r && r.error) {
      return res.json({ success: true, lookupError: r.error, device: { imei } });
    }
    if (!r || !r.found) {
      return res.json({
        success: true,
        found: false,
        message: "Blackbelt has no report for this device.",
        device: { imei },
      });
    }

    const d = r.device;
    return res.json({
      success: true,
      found: true,
      source: "blackbelt",
      // A Blackbelt report exists → the device is Blackbelt checked.
      blackbeltChecked: true,
      blackbeltReportId: r.reportID || "",
      blackbeltStatus: d.reportStatus || "",
      device: {
        // Keep the scanned code as the register's key — the report's own
        // IMEI field is blank for serial-number lookups.
        imei,
        brand: d.brandName || "",
        model: d.modelName || "",
        color: d.color || "",
        storage: d.storage || "",
        serialNumber: d.serialNumber || "",
        batteryHealth: d.batteryHealth,
        batteryCycleCount: d.batteryCycleCount,
        batteryCapacity: d.batteryCapacity || "",
        aNumber: d.aNumber || "",
        stockSource: "",
      },
    });
  } catch (e) {
    console.error("Refurb device lookup error:", e);
    return res.status(500).json({ success: false, message: "IMEI lookup failed" });
  }
});

// ── GET /refurbished/devices/:id/report ─────────────────────────────
// Full Blackbelt report detail for the dialog's Report tab, fetched fresh
// by the report id stored on the device.
router.get("/:id/report", VIEW, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    {
      const db = await connectToDatabase();
      const d = await db
        .collection(DEVICES)
        .findOne({ _id: new ObjectId(req.params.id) }, { projection: { stockSource: 1 } });
      if (!d || outOfScope(req.user, d)) {
        return res.status(404).json({ success: false, message: "Device not found" });
      }
    }
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const device = await db
      .collection(DEVICES)
      .findOne({ _id: new ObjectId(req.params.id) }, { projection: { blackbeltReportId: 1 } });
    if (!device) return res.status(404).json({ success: false, message: "Device not found" });
    if (!device.blackbeltReportId) {
      return res.json({ success: true, hasReport: false, message: "No Blackbelt report recorded for this device." });
    }

    const r = await blackbelt.fetchReportDetail(device.blackbeltReportId);
    if (r.notConfigured) {
      return res.json({ success: true, hasReport: false, message: "Blackbelt credentials aren't set on the server." });
    }
    if (r.error) return res.json({ success: true, hasReport: false, message: r.error });
    if (!r.found) {
      return res.json({ success: true, hasReport: false, message: "Blackbelt no longer returns this report." });
    }
    return res.json({
      success: true,
      hasReport: true,
      reportId: String(device.blackbeltReportId),
      report: r.report,
    });
  } catch (e) {
    console.error("Refurb device report error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the report" });
  }
});

// ── POST /refurbished/devices/:id/blackbelt-check ───────────────────
// Re-asks Blackbelt about a device already in the register — for units
// added before their report existed, and to correct one whose details were
// typed or imported wrong.
//
// Blackbelt is the source of truth: every field it reports a value for is
// written, blank or not. A field it has nothing for is left alone, so a
// thin report can never wipe details the register already holds. Every
// change lands in the device's history.
router.post("/:id/blackbelt-check", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    const existing = await db.collection(DEVICES).findOne({ _id });
    if (!existing || outOfScope(req.user, existing)) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    const r = await blackbelt.lookupDevice(existing.imei);
    if (r && r.notConfigured) {
      return res.json({ success: true, found: false, message: "Blackbelt credentials aren't set on the server." });
    }
    if (r && r.error) return res.json({ success: true, found: false, message: r.error });
    if (!r || !r.found) {
      return res.json({ success: true, found: false, message: "Blackbelt still has no report for this device." });
    }

    const d = r.device;
    const set = {
      blackbeltChecked: true,
      blackbeltReportId: r.reportID || "",
      blackbeltStatus: d.reportStatus || "",
      updatedAt: new Date(),
      updatedBy: (req.user && req.user.username) || null,
    };
    const empty = (v) => v === null || v === undefined || v === "";
    const fillable = {
      brand: d.brandName,
      model: d.modelName,
      color: d.color,
      storage: d.storage,
      serialNumber: d.serialNumber,
      batteryHealth: d.batteryHealth,
      batteryCycleCount: d.batteryCycleCount,
      batteryCapacity: d.batteryCapacity,
      aNumber: d.aNumber,
    };
    // Case-only differences ("Silver" vs "SILVER") aren't worth a history
    // entry, so they don't count as a change.
    const same = (a, b) =>
      String(a == null ? "" : a).trim().toLowerCase() ===
      String(b == null ? "" : b).trim().toLowerCase();
    for (const [k, v] of Object.entries(fillable)) {
      if (empty(v) || same(existing[k], v)) continue;
      set[k] = v;
    }

    // A report that carries no colour looks exactly like a broken check:
    // "report found", nothing changes, no explanation. Report what was
    // filled, what was corrected, and what the report simply doesn't carry.
    const LABELS = {
      brand: "Brand",
      model: "Model",
      color: "Colour",
      storage: "Storage",
      serialNumber: "Serial Number",
      batteryHealth: "Battery Health",
      batteryCycleCount: "Battery Cycles",
      batteryCapacity: "Battery Capacity",
      aNumber: "A Number",
    };
    // Only the identity fields are worth naming as missing — nobody needs
    // to be told a report has no A Number.
    const NAMED_WHEN_BLANK = ["model", "color", "storage"];
    const filled = [];
    const blank = [];
    const corrected = [];
    for (const [k, v] of Object.entries(fillable)) {
      if (set[k] !== undefined) {
        if (empty(existing[k])) filled.push(LABELS[k]);
        else corrected.push({ field: k, label: LABELS[k], from: existing[k], to: v });
      } else if (empty(v) && NAMED_WHEN_BLANK.includes(k) && empty(existing[k])) {
        blank.push(LABELS[k]);
      }
    }
    const parts = [
      filled.length ? `filled ${filled.join(", ")}` : "",
      corrected.length ? `corrected ${corrected.map((c) => c.label).join(", ")}` : "",
      blank.length ? `this report has no ${blank.join(" or ")}` : "",
    ].filter(Boolean);
    const message = `Report found — ${parts.join(" · ") || "everything already matches"}`;

    const changes = diffDevice(existing, set);
    const update = { $set: set };
    if (changes.length) {
      update.$push = {
        history: { $each: [historyEntry(req.user, "updated", { changes })], $slice: -HISTORY_CAP },
      };
    }
    const u = await db.collection(DEVICES).findOneAndUpdate({ _id }, update, { returnDocument: "after" });
    const updated = u ? u.value || u : null;
    return res.json({ success: true, found: true, device: updated, message, filled, blank, corrected });
  } catch (e) {
    console.error("Refurb device blackbelt-check error:", e);
    return res.status(500).json({ success: false, message: "Blackbelt check failed" });
  }
});

// ── POST /refurbished/devices ───────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const imei = normalizeImei(req.body && req.body.imei);
    if (!imei) return res.status(400).json({ success: false, message: "IMEI is required" });
    if (!CODE_RE.test(imei)) {
      return res.status(400).json({ success: false, message: CODE_HINT });
    }
    if (req.user && req.user.role === "phone-supplier" && !stockSourceForUser(req.user)) {
      return res.status(400).json({
        success: false,
        message: "Your account has no stock source assigned — ask an admin to set it first",
      });
    }
    const db = await connectToDatabase();
    const clash = await db.collection(DEVICES).findOne({ imei }, { projection: { _id: 1 } });
    if (clash) {
      return res.status(409).json({ success: false, message: `IMEI ${imei} is already in stock` });
    }
    const now = new Date();
    const doc = {
      imei,
      ...buildDevice(req.body || {}),
      stockSource: stockSourceForUser(req.user),
      location: locationForUser(req.user),
      // Sale status — flips to "Sold" when the device lands on a sales
      // order. A supplier's unit sits on THEIR shelf, not ours, so it
      // starts With Supplier and only becomes In Stock by arriving
      // through a supply batch.
      status:
        req.user && req.user.role === "phone-supplier" ? STATUS_WITH_SUPPLIER : "In Stock",
      history: [historyEntry(req.user, "created")],
      createdAt: now,
      updatedAt: now,
      createdBy: (req.user && req.user.username) || null,
    };
    const r = await db.collection(DEVICES).insertOne(doc);
    return res.json({ success: true, id: r.insertedId, device: doc });
  } catch (e) {
    console.error("Refurb device create error:", e);
    return res.status(500).json({ success: false, message: "Failed to add device" });
  }
});

// ── POST /refurbished/devices/bulk-location ─────────────────────────
// Move a set of In Stock devices to another of our shelves in one go —
// the Stock page's Bulk Action. Only In Stock units move (a sold or away
// device's location is part of its story); everything else is reported
// back. Suppliers never shuffle stock between our shelves.
router.post("/bulk-location", MANAGE, async (req, res) => {
  try {
    if (supplierSource(req.user) !== null) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const body = req.body || {};
    const location = RECEIVE_LOCATIONS.find(
      (l) => l.toLowerCase() === String(body.location || "").trim().toLowerCase(),
    );
    if (!location) {
      return res.status(400).json({
        success: false,
        message: `Location must be one of: ${RECEIVE_LOCATIONS.join(", ")}`,
      });
    }
    const deviceIds = [...new Set((Array.isArray(body.deviceIds) ? body.deviceIds : []).map(String))]
      .filter((v) => ObjectId.isValid(v))
      .slice(0, 500)
      .map((v) => new ObjectId(v));
    if (!deviceIds.length) {
      return res.status(400).json({ success: false, message: "Add at least one device" });
    }

    const db = await connectToDatabase();
    const devices = await db
      .collection(DEVICES)
      .find({ _id: { $in: deviceIds } }, { projection: { imei: 1, status: 1, location: 1 } })
      .toArray();

    const now = new Date();
    const who = (req.user && req.user.username) || null;
    let moved = 0;
    const skipped = [];
    for (const d of devices) {
      if (d.status && d.status !== "In Stock") {
        skipped.push({ imei: d.imei, reason: `${d.status} — not movable` });
        continue;
      }
      if (d.location === location) {
        skipped.push({ imei: d.imei, reason: `Already at ${location}` });
        continue;
      }
      const r = await db.collection(DEVICES).updateOne(
        // Status re-checked in the write so a concurrent sale can't race in.
        { _id: d._id, $or: [{ status: "In Stock" }, { status: null }, { status: { $exists: false } }] },
        {
          $set: { location, updatedAt: now },
          $push: {
            history: {
              $each: [{ at: now, by: who, action: `Moved to ${location}` }],
              $slice: -HISTORY_CAP,
            },
          },
        },
      );
      if (r.modifiedCount) moved += 1;
      else skipped.push({ imei: d.imei, reason: "No longer In Stock" });
    }
    return res.json({
      success: true,
      moved,
      skipped,
      message: `${moved} device(s) moved to ${location}`,
    });
  } catch (e) {
    console.error("Refurb bulk-location error:", e);
    return res.status(500).json({ success: false, message: "Failed to move the devices" });
  }
});

// ── PUT /refurbished/devices/:id ────────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);

    // The stored doc is needed to diff the edit for the history log.
    const existing = await db.collection(DEVICES).findOne({ _id });
    if (!existing || outOfScope(req.user, existing)) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }

    const set = buildDevice(req.body || {}, { partial: true });

    // The IMEI / serial is the register's key — once a device is recorded
    // it can't be edited from the dashboard. Echoing the stored value back
    // is fine (the edit form always sends it); anything else is rejected.
    if (req.body && req.body.imei !== undefined) {
      const imei = normalizeImei(req.body.imei);
      if (imei && imei !== existing.imei) {
        return res.status(400).json({
          success: false,
          message: "The IMEI / serial can't be changed once a device is recorded",
        });
      }
    }

    set.updatedAt = new Date();
    set.updatedBy = (req.user && req.user.username) || null;

    // Audit trail — only when something actually changed.
    const changes = diffDevice(existing, set);
    const update = { $set: set };
    if (changes.length) {
      update.$push = {
        history: { $each: [historyEntry(req.user, "updated", { changes })], $slice: -HISTORY_CAP },
      };
    }

    const r = await db.collection(DEVICES).findOneAndUpdate(
      { _id },
      update,
      { returnDocument: "after" },
    );
    const updated = r ? r.value || r : null;
    if (!updated) return res.status(404).json({ success: false, message: "Device not found" });
    return res.json({ success: true, device: updated });
  } catch (e) {
    console.error("Refurb device update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update device" });
  }
});

// ── DELETE /refurbished/devices/:id ─────────────────────────────────
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(req.params.id);
    // A sold device is referenced by its sales order — cancel that first.
    const existing = await db
      .collection(DEVICES)
      .findOne({ _id }, { projection: { status: 1, salesOrder: 1, stockSource: 1, location: 1 } });
    if (!existing || outOfScope(req.user, existing)) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }
    // A supplier may only delete what is physically still on their shelf —
    // once a unit is on the road or received here, its record is part of
    // our paperwork too.
    const src = supplierSource(req.user);
    if (src !== null && (existing.location || "") !== src) {
      return res.status(400).json({
        success: false,
        message: "This device isn't at your location — only devices on your shelf can be deleted",
      });
    }
    if (existing.status === "Sold") {
      const orderNo = (existing.salesOrder && existing.salesOrder.orderNo) || "a sales order";
      return res.status(400).json({
        success: false,
        message: `This device is sold on ${orderNo} — cancel that order first`,
      });
    }
    const r = await db.collection(DEVICES).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Device not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("Refurb device delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete device" });
  }
});

module.exports = router;
