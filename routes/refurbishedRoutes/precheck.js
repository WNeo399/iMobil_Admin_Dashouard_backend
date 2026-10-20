// Refurbished Device — Pending Stock 待入库 (first named Pre-Check; the
// API path and collection keep that name — Mongo: refurb_precheck), user ask
// 2026-10-20: "a new page for Phone Supplier to load some of their devices
// before checking in Blackbelt and before loading into stock … only IMEI,
// Device, Supplier and Note, only IMEI required … a new record separate
// from the stock".
//
// Phone suppliers only (user, the same day: "only phone supplier needs this
// page"): every call needs the phone-supplier role, like the Suppliers page,
// and is scoped to the stock source on their user record — they see, add,
// edit and remove only theirs. Nothing here touches the stock register; a
// row says whether it went into their Stock (`addedToStock` {at, by,
// deviceId} — set by Stock's own add, or found there when the list loads).
//
//   GET    /refurbished/precheck           list (search, supplierId, added=yes|no, page)
//   POST   /refurbished/precheck           add { imei, device?, supplierId?, assign?, note? }
//   PUT    /refurbished/precheck/:id       edit (same fields)
//   DELETE /refurbished/precheck/:id       remove one
//   POST   /refurbished/precheck/delete    remove several { ids }

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { userHasRole } = require("../../constants/roles");
const { normalizeStockSource } = require("./stockSource");

const VIEW = requirePermission("refurb:precheck:view");
const MANAGE = requirePermission("refurb:precheck:manage");
const PRECHECK = "refurb_precheck";
const DEVICES = "refurb_devices";
const SUPPLIERS = "refurb_suppliers";

const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
// IMEI or serial number (a WiFi iPad has only the serial): letters and
// digits, spaces dropped, upper case
const cleanImei = (v) => String(v == null ? "" : v).replace(/\s+/g, "").toUpperCase();
// the Stock page's rule (devices.js CODE_RE), so a record can go into Stock
const IMEI_OK = /^[A-Z0-9]{10,20}$/;

// The caller's stock source. Anyone but a phone supplier, or one with no
// source on their account, is refused — answered here, null returned.
function scopeOf(req, res) {
  if (!userHasRole(req.user, "phone-supplier")) {
    res.status(403).json({ success: false, message: "Pending Stock is for phone-supplier accounts" });
    return null;
  }
  const src = normalizeStockSource(req.user.stockSource);
  if (!src) {
    res.status(400).json({ success: false, message: "Your account has no stock source assigned — ask an admin to set it first" });
    return null;
  }
  return src;
}

let indexed = false;
async function collection() {
  const db = await connectToDatabase();
  const col = db.collection(PRECHECK);
  if (!indexed) {
    indexed = true;
    // one record per IMEI on a source's list
    await col.createIndex({ stockSource: 1, imei: 1 }, { unique: true }).catch(() => {});
    await col.createIndex({ stockSource: 1, createdAt: -1 }).catch(() => {});
  }
  return { db, col };
}

// The fields from a request. { doc } or { error }. `partial`: only those sent.
async function readFields(db, body, src, { partial = false } = {}) {
  const b = body || {};
  const doc = {};
  if (!partial || b.imei !== undefined) {
    const imei = cleanImei(b.imei);
    if (!imei) return { error: "Enter the IMEI" };
    if (!IMEI_OK.test(imei)) return { error: "Enter a 10–20 character IMEI or serial number" };
    doc.imei = imei;
  }
  // a text area (2026-10-20): its lines kept, spaces tidied, 300 characters at most
  if (!partial || b.device !== undefined) {
    doc.device = String(b.device == null ? "" : b.device).replace(/\r\n?/g, "\n").split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 300);
  }
  if (!partial || b.note !== undefined) doc.note = str(b.note, 500);
  // who it is assigned to — plain text (user 2026-10-20)
  if (!partial || b.assign !== undefined) doc.assign = str(b.assign, 100).replace(/\s+/g, " ");
  if (!partial || b.supplierId !== undefined) {
    const id = str(b.supplierId, 40);
    if (!id) doc.supplier = null;
    else {
      if (!ObjectId.isValid(id)) return { error: "Bad supplier" };
      // one of the supplier's own suppliers (the Suppliers page)
      const sup = await db.collection(SUPPLIERS).findOne({ _id: new ObjectId(id), stockSource: src }, { projection: { name: 1 } });
      if (!sup) return { error: "That supplier isn't on your suppliers list" };
      doc.supplier = { id: sup._id, name: sup.name };
    }
  }
  return { doc };
}

// "Added to Stock" for records whose IMEI (or serial) is in the supplier's
// Stock already without the mark — Stock's own add sets it (devices.js),
// this catches every other way in (a supply batch, an import, an older
// add). Run before each list read; the lists are small.
async function markFoundInStock(db, col, src) {
  const open = await col.find({ stockSource: src, addedToStock: { $exists: false } }, { projection: { imei: 1 } }).toArray();
  if (!open.length) return;
  const codes = [...new Set(open.map((r) => r.imei).filter(Boolean))];
  const found = await db.collection(DEVICES).find(
    { stockSource: src, $or: [{ imei: { $in: codes } }, { serialNumber: { $in: codes } }] },
    { projection: { imei: 1, serialNumber: 1, createdAt: 1, createdBy: 1 } },
  ).toArray();
  const byCode = new Map();
  for (const d of found) for (const c of [d.imei, d.serialNumber]) if (c) byCode.set(String(c).toUpperCase(), d);
  const ops = open.filter((r) => byCode.has(r.imei)).map((r) => {
    const d = byCode.get(r.imei);
    return { updateOne: { filter: { _id: r._id, addedToStock: { $exists: false } }, update: { $set: { addedToStock: { at: d.createdAt || new Date(), by: d.createdBy || null, deviceId: d._id, found: true } } } } };
  });
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
}

// ── GET /refurbished/precheck ────────────────────────────────────────
router.get("/", VIEW, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { db, col } = await collection();
    await markFoundInStock(db, col, src);
    const match = { stockSource: src };
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search.replace(/\s+/g, " ")), "i");
      const imeiRe = new RegExp(escapeRegex(cleanImei(search)), "i");
      match.$or = [{ imei: imeiRe }, { device: re }, { note: re }, { assign: re }, { "supplier.name": re }];
    }
    const supplierId = str(req.query.supplierId, 40);
    if (supplierId && ObjectId.isValid(supplierId)) match["supplier.id"] = new ObjectId(supplierId);
    // added=yes / no: in Stock already, or still to go
    if (req.query.added === "yes") match.addedToStock = { $exists: true };
    if (req.query.added === "no") match.addedToStock = { $exists: false };
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [total, rows] = await Promise.all([
      col.countDocuments(match),
      col.find(match).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
    ]);
    return res.json({ success: true, total, page, pageSize, rows });
  } catch (e) {
    console.error("Pre-check list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the list" });
  }
});

// ── POST /refurbished/precheck ───────────────────────────────────────
router.post("/", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { db, col } = await collection();
    const { doc, error } = await readFields(db, req.body, src);
    if (error) return res.status(400).json({ success: false, message: error });
    const dup = await col.findOne({ stockSource: src, imei: doc.imei }, { projection: { _id: 1 } });
    if (dup) return res.status(400).json({ success: false, message: `${doc.imei} is on the list already` });
    const now = new Date();
    const row = { ...doc, stockSource: src, createdAt: now, createdBy: actor(req), updatedAt: now, updatedBy: actor(req) };
    const r = await col.insertOne(row);
    // already in their Stock? marked at once
    await markFoundInStock(db, col, src);
    return res.json({ success: true, row: await col.findOne({ _id: r.insertedId }) });
  } catch (e) {
    if (e && e.code === 11000) return res.status(400).json({ success: false, message: "That IMEI is on the list already" });
    console.error("Pre-check add error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the record" });
  }
});

// ── PUT /refurbished/precheck/:id ────────────────────────────────────
router.put("/:id", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const _id = new ObjectId(req.params.id);
    const { db, col } = await collection();
    const existing = await col.findOne({ _id, stockSource: src });
    if (!existing) return res.status(404).json({ success: false, message: "Record not found" });
    const { doc, error } = await readFields(db, req.body, src, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });
    if (doc.imei && doc.imei !== existing.imei) {
      const dup = await col.findOne({ stockSource: src, imei: doc.imei, _id: { $ne: _id } }, { projection: { _id: 1 } });
      if (dup) return res.status(400).json({ success: false, message: `${doc.imei} is on the list already` });
    }
    await col.updateOne({ _id }, { $set: { ...doc, updatedAt: new Date(), updatedBy: actor(req) } });
    await markFoundInStock(db, col, src);
    return res.json({ success: true, row: await col.findOne({ _id }) });
  } catch (e) {
    if (e && e.code === 11000) return res.status(400).json({ success: false, message: "That IMEI is on the list already" });
    console.error("Pre-check edit error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the record" });
  }
});

// ── DELETE /refurbished/precheck/:id · POST /refurbished/precheck/delete
async function remove(req, res, ids) {
  const src = scopeOf(req, res);
  if (!src) return;
  const oids = ids.filter((x) => ObjectId.isValid(String(x))).map((x) => new ObjectId(String(x)));
  if (!oids.length) return res.status(400).json({ success: false, message: "Nothing to remove" });
  const { col } = await collection();
  const r = await col.deleteMany({ _id: { $in: oids }, stockSource: src });
  return res.json({ success: true, removed: r.deletedCount });
}
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    return await remove(req, res, [req.params.id]);
  } catch (e) {
    console.error("Pre-check remove error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the record" });
  }
});
router.post("/delete", MANAGE, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 500) : [];
    return await remove(req, res, ids);
  } catch (e) {
    console.error("Pre-check bulk remove error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the records" });
  }
});

module.exports = router;
