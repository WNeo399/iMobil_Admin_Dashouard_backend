// Refurbished Device — Pending Stock repairs (user ask 2026-11-04): a phone
// supplier sends its Pending Stock devices to its repairers, in batches.
//
// A device's status lives on its refurb_precheck record:
//   待处理 "pending"  — not with a repairer (a record with no status yet too)
//   已分配 "assigned" — on a repair batch, with its repairer
//   已处理 "done"     — back from the repairer, marked processed
// Marked done one by one (Pending Stock or a batch) or a whole batch at a
// time. Repairers are the phone supplier's own list
// (refurb_precheck_repairers), batches are RPB-10001+
// (refurb_precheck_repair_batches); both scoped to the caller's stock source,
// like Pending Stock. A batch keeps no copy of its devices: the records point
// at it (`repairBatch`), so a device leaves a batch by being unassigned and
// the counts can't drift.
//
//   GET    /refurbished/precheck-repair/repairers            list (search, active=1)
//   POST   /refurbished/precheck-repair/repairers            add { name, phone?, note? }
//   PUT    /refurbished/precheck-repair/repairers/:id        edit (+ active)
//   DELETE /refurbished/precheck-repair/repairers/:id        remove (not while a batch names it)
//   GET    /refurbished/precheck-repair/batches              list (search, status=open|done, repairerId)
//   POST   /refurbished/precheck-repair/batches              new { repairerId, ids, note? }: devices → 已分配
//   GET    /refurbished/precheck-repair/batches/:id          one batch and its devices
//   PUT    /refurbished/precheck-repair/batches/:id          { note }
//   POST   /refurbished/precheck-repair/batches/:id/devices  more devices { ids }
//   POST   /refurbished/precheck-repair/batches/:id/done     every 已分配 device on it → 已处理
//   DELETE /refurbished/precheck-repair/batches/:id          remove a batch with no devices left
//   POST   /refurbished/precheck-repair/status               { ids, action }: done | reopen | unassign
//
// Phone suppliers only, with the Pending Stock permissions (refurb:precheck:*).

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
const REPAIRERS = "refurb_precheck_repairers";
const BATCHES = "refurb_precheck_repair_batches";
const MAX_IDS = 500;
// a record with no status yet is waiting too
const PENDING = { $in: ["pending", null] };

const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const oid = (v) => (ObjectId.isValid(String(v || "")) ? new ObjectId(String(v)) : null);
const idsOf = (body) => [...new Set((Array.isArray(body && body.ids) ? body.ids : []).slice(0, MAX_IDS).map(String))].map(oid).filter(Boolean);
const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });

// The caller's stock source; anyone but a phone supplier is refused, as on Pending Stock.
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
async function cols() {
  const db = await connectToDatabase();
  const out = { db, records: db.collection(PRECHECK), repairers: db.collection(REPAIRERS), batches: db.collection(BATCHES) };
  if (!indexed) {
    indexed = true;
    await out.batches.createIndex({ batchNo: 1 }, { unique: true }).catch(() => {});
    await out.batches.createIndex({ stockSource: 1, seq: -1 }).catch(() => {});
    await out.repairers.createIndex({ stockSource: 1, name: 1 }).catch(() => {});
    await out.records.createIndex({ "repairBatch.id": 1 }).catch(() => {});
  }
  return out;
}

function fail(res, e, what) {
  console.error(`Pending Stock repair: ${what} error:`, e);
  return res.status(500).json({ success: false, message: `Failed to ${what}` });
}

// ── repairers ────────────────────────────────────────────────────────
function repairerFields(body, { partial = false } = {}) {
  const b = body || {};
  const doc = {};
  if (!partial || b.name !== undefined) doc.name = str(b.name, 100).replace(/\s+/g, " ");
  if (!partial || b.phone !== undefined) doc.phone = str(b.phone, 60);
  if (!partial || b.note !== undefined) doc.note = str(b.note, 500);
  if (b.active !== undefined) doc.active = b.active !== false;
  return doc;
}

router.get("/repairers", VIEW, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { records, repairers } = await cols();
    const query = { stockSource: src };
    if (req.query.active === "1") query.active = { $ne: false };
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ name: re }, { phone: re }, { note: re }];
    }
    const rows = await repairers.find(query).sort({ name: 1 }).limit(300).toArray();
    // how many devices each one has now
    const busy = await records.find({ stockSource: src, status: "assigned" }, { projection: { "repairer.id": 1 } }).toArray();
    const inRepair = {};
    for (const r of busy) if (r.repairer && r.repairer.id) inRepair[String(r.repairer.id)] = (inRepair[String(r.repairer.id)] || 0) + 1;
    return res.json({ success: true, repairers: rows.map((r) => ({ ...r, active: r.active !== false, inRepair: inRepair[String(r._id)] || 0 })) });
  } catch (e) {
    return fail(res, e, "load the repairers");
  }
});

router.post("/repairers", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const doc = repairerFields(req.body);
    if (!doc.name) return bad(res, "Repairer name is required");
    const { repairers } = await cols();
    const dup = await repairers.findOne({ stockSource: src, name: new RegExp("^" + escapeRegex(doc.name) + "$", "i") });
    if (dup) return bad(res, `"${doc.name}" is on the list already`, 409);
    const now = new Date();
    const row = { ...doc, active: doc.active !== false, stockSource: src, createdAt: now, createdBy: actor(req), updatedAt: now };
    const r = await repairers.insertOne(row);
    return res.json({ success: true, repairer: { ...row, _id: r.insertedId } });
  } catch (e) {
    return fail(res, e, "add the repairer");
  }
});

router.put("/repairers/:id", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const set = repairerFields(req.body, { partial: true });
    if (set.name !== undefined && !set.name) return bad(res, "Repairer name is required");
    const { records, repairers, batches } = await cols();
    const was = await repairers.findOne({ _id, stockSource: src });
    if (!was) return bad(res, "Repairer not found", 404);
    if (set.name) {
      const dup = await repairers.findOne({ _id: { $ne: _id }, stockSource: src, name: new RegExp("^" + escapeRegex(set.name) + "$", "i") });
      if (dup) return bad(res, `"${set.name}" is on the list already`, 409);
    }
    await repairers.updateOne({ _id }, { $set: { ...set, updatedAt: new Date(), updatedBy: actor(req) } });
    // devices and batches carry the name: it follows a rename
    if (set.name && set.name !== was.name) {
      await records.updateMany({ stockSource: src, "repairer.id": _id }, { $set: { "repairer.name": set.name } });
      await batches.updateMany({ stockSource: src, "repairer.id": _id }, { $set: { "repairer.name": set.name } });
    }
    return res.json({ success: true, repairer: await repairers.findOne({ _id }) });
  } catch (e) {
    return fail(res, e, "save the repairer");
  }
});

router.delete("/repairers/:id", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "Bad id");
    const { repairers, batches } = await cols();
    const used = await batches.countDocuments({ stockSource: src, "repairer.id": _id });
    if (used) return bad(res, `${used} repair batch(es) name this repairer — switch it off instead`);
    const r = await repairers.deleteOne({ _id, stockSource: src });
    if (!r.deletedCount) return bad(res, "Repairer not found", 404);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "remove the repairer");
  }
});

// ── repair batches ───────────────────────────────────────────────────
async function nextBatchNo(batches) {
  const last = await batches.find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max(10000, (last[0] && last[0].seq) || 0) + 1;
  return { seq, batchNo: `RPB-${seq}` };
}

// each batch's device counts, from the records pointing at it
async function countsFor(records, src, batchIds) {
  const rows = batchIds.length
    ? await records.find({ stockSource: src, "repairBatch.id": { $in: batchIds } }, { projection: { "repairBatch.id": 1, status: 1 } }).toArray()
    : [];
  const out = {};
  for (const r of rows) {
    const k = String(r.repairBatch.id);
    const c = out[k] || (out[k] = { devices: 0, processed: 0 });
    c.devices += 1;
    if (r.status === "done") c.processed += 1;
  }
  return out;
}
// 处理中 while a device is still with the repairer; 已处理 once every one is back
const batchStatus = (c) => (!c.devices ? "empty" : c.processed === c.devices ? "done" : "open");

// Puts pending devices on a batch. → { assigned, skipped: [{ imei, reason }] }
async function assignTo(records, src, batch, ids, req) {
  const docs = await records.find({ _id: { $in: ids }, stockSource: src }, { projection: { imei: 1, status: 1, repairBatch: 1 } }).toArray();
  const found = new Set(docs.map((d) => String(d._id)));
  const skipped = ids.filter((id) => !found.has(String(id))).map(() => ({ imei: "", reason: "not on your Pending Stock" }));
  const ok = [];
  for (const d of docs) {
    if (!d.status || d.status === "pending") ok.push(d._id);
    else skipped.push({ imei: d.imei, reason: d.status === "done" ? "processed already" : `on ${(d.repairBatch && d.repairBatch.batchNo) || "a batch"} already` });
  }
  if (!ok.length) return { assigned: 0, skipped };
  const now = new Date();
  const r = await records.updateMany(
    { _id: { $in: ok }, stockSource: src, status: PENDING },
    {
      $set: {
        status: "assigned",
        repairer: batch.repairer,
        repairBatch: { id: batch._id, batchNo: batch.batchNo },
        assignedAt: now,
        assignedBy: actor(req),
        updatedAt: now,
        updatedBy: actor(req),
      },
      $unset: { processedAt: "", processedBy: "" },
    },
  );
  return { assigned: r.modifiedCount, skipped };
}

router.get("/batches", VIEW, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { records, batches } = await cols();
    const query = { stockSource: src };
    const repairerId = oid(req.query.repairerId);
    if (repairerId) query["repairer.id"] = repairerId;
    const search = str(req.query.search, 100);
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      query.$or = [{ batchNo: re }, { "repairer.name": re }, { note: re }];
    }
    const rows = await batches.find(query).sort({ seq: -1 }).limit(500).toArray();
    const counts = await countsFor(records, src, rows.map((b) => b._id));
    let out = rows.map((b) => {
      const c = counts[String(b._id)] || { devices: 0, processed: 0 };
      return { ...b, ...c, status: batchStatus(c) };
    });
    const tally = { all: out.length, open: out.filter((b) => b.status === "open").length, done: out.filter((b) => b.status === "done").length };
    if (["open", "done", "empty"].includes(req.query.status)) out = out.filter((b) => b.status === req.query.status);
    return res.json({ success: true, batches: out, counts: tally });
  } catch (e) {
    return fail(res, e, "load the repair batches");
  }
});

router.post("/batches", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const repairerId = oid(req.body && req.body.repairerId);
    if (!repairerId) return bad(res, "Pick the repairer");
    const ids = idsOf(req.body);
    if (!ids.length) return bad(res, "Pick the devices for the batch");
    const { records, repairers, batches } = await cols();
    const rep = await repairers.findOne({ _id: repairerId, stockSource: src });
    if (!rep) return bad(res, "That repairer isn't on your list");
    if (rep.active === false) return bad(res, `${rep.name} is switched off on the Repairers page`);
    const pending = await records.countDocuments({ _id: { $in: ids }, stockSource: src, status: PENDING });
    if (!pending) return bad(res, "None of these devices is waiting (待处理) any more");
    const now = new Date();
    let batch = null;
    for (let tries = 0; !batch && tries < 5; tries++) {
      const { seq, batchNo } = await nextBatchNo(batches);
      const doc = { stockSource: src, batchNo, seq, repairer: { id: rep._id, name: rep.name }, note: str(req.body.note, 500), createdAt: now, createdBy: actor(req), updatedAt: now };
      try {
        const r = await batches.insertOne(doc);
        batch = { ...doc, _id: r.insertedId };
      } catch (e) {
        if (!(e && e.code === 11000)) throw e; // another batch took the number: the next one
      }
    }
    if (!batch) return bad(res, "Could not number the batch — try again", 409);
    const out = await assignTo(records, src, batch, ids, req);
    if (!out.assigned) {
      // the devices moved meanwhile: no empty batch left behind
      await batches.deleteOne({ _id: batch._id });
      return bad(res, "None of these devices is waiting (待处理) any more");
    }
    return res.json({ success: true, batch, ...out });
  } catch (e) {
    return fail(res, e, "create the repair batch");
  }
});

async function batchOf(batches, src, id) {
  const _id = oid(id);
  return _id ? batches.findOne({ _id, stockSource: src }) : null;
}

router.get("/batches/:id", VIEW, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { records, batches } = await cols();
    const batch = await batchOf(batches, src, req.params.id);
    if (!batch) return bad(res, "Repair batch not found", 404);
    const rows = await records.find({ stockSource: src, "repairBatch.id": batch._id }).sort({ assignedAt: 1, imei: 1 }).toArray();
    const c = { devices: rows.length, processed: rows.filter((r) => r.status === "done").length };
    return res.json({ success: true, batch: { ...batch, ...c, status: batchStatus(c) }, rows });
  } catch (e) {
    return fail(res, e, "load the repair batch");
  }
});

router.put("/batches/:id", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { batches } = await cols();
    const batch = await batchOf(batches, src, req.params.id);
    if (!batch) return bad(res, "Repair batch not found", 404);
    await batches.updateOne({ _id: batch._id }, { $set: { note: str(req.body && req.body.note, 500), updatedAt: new Date(), updatedBy: actor(req) } });
    return res.json({ success: true, batch: await batches.findOne({ _id: batch._id }) });
  } catch (e) {
    return fail(res, e, "save the repair batch");
  }
});

router.post("/batches/:id/devices", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const ids = idsOf(req.body);
    if (!ids.length) return bad(res, "Pick the devices to add");
    const { records, batches } = await cols();
    const batch = await batchOf(batches, src, req.params.id);
    if (!batch) return bad(res, "Repair batch not found", 404);
    const out = await assignTo(records, src, batch, ids, req);
    if (!out.assigned) return bad(res, "None of these devices is waiting (待处理) any more");
    await batches.updateOne({ _id: batch._id }, { $set: { updatedAt: new Date(), updatedBy: actor(req) } });
    return res.json({ success: true, ...out });
  } catch (e) {
    return fail(res, e, "add the devices");
  }
});

// the whole batch back from the repairer
router.post("/batches/:id/done", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { records, batches } = await cols();
    const batch = await batchOf(batches, src, req.params.id);
    if (!batch) return bad(res, "Repair batch not found", 404);
    const now = new Date();
    const r = await records.updateMany(
      { stockSource: src, "repairBatch.id": batch._id, status: "assigned" },
      { $set: { status: "done", processedAt: now, processedBy: actor(req), updatedAt: now, updatedBy: actor(req) } },
    );
    return res.json({ success: true, processed: r.modifiedCount });
  } catch (e) {
    return fail(res, e, "mark the batch processed");
  }
});

router.delete("/batches/:id", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const { records, batches } = await cols();
    const batch = await batchOf(batches, src, req.params.id);
    if (!batch) return bad(res, "Repair batch not found", 404);
    const left = await records.countDocuments({ stockSource: src, "repairBatch.id": batch._id });
    if (left) return bad(res, `${left} device(s) are still on ${batch.batchNo} — take them off first`);
    await batches.deleteOne({ _id: batch._id });
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "remove the repair batch");
  }
});

// ── a device's status, from Pending Stock or a batch ─────────────────
//   done     待处理 / 已分配 → 已处理
//   reopen   已处理 → back where it was (已分配 on its batch, else 待处理)
//   unassign 已分配 → 待处理, off its batch
router.post("/status", MANAGE, async (req, res) => {
  try {
    const src = scopeOf(req, res);
    if (!src) return;
    const ids = idsOf(req.body);
    if (!ids.length) return bad(res, "Pick the devices");
    const action = str(req.body && req.body.action, 20);
    const { records } = await cols();
    const now = new Date();
    const by = actor(req);
    const scope = { _id: { $in: ids }, stockSource: src };
    let changed = 0;
    if (action === "done") {
      const r = await records.updateMany({ ...scope, status: { $in: ["pending", "assigned", null] } },
        { $set: { status: "done", processedAt: now, processedBy: by, updatedAt: now, updatedBy: by } });
      changed = r.modifiedCount;
    } else if (action === "reopen") {
      const a = await records.updateMany({ ...scope, status: "done", "repairBatch.id": { $exists: true } },
        { $set: { status: "assigned", updatedAt: now, updatedBy: by }, $unset: { processedAt: "", processedBy: "" } });
      const p = await records.updateMany({ ...scope, status: "done", "repairBatch.id": { $exists: false } },
        { $set: { status: "pending", updatedAt: now, updatedBy: by }, $unset: { processedAt: "", processedBy: "" } });
      changed = a.modifiedCount + p.modifiedCount;
    } else if (action === "unassign") {
      const r = await records.updateMany({ ...scope, status: "assigned" },
        { $set: { status: "pending", updatedAt: now, updatedBy: by }, $unset: { repairer: "", repairBatch: "", assignedAt: "", assignedBy: "" } });
      changed = r.modifiedCount;
    } else {
      return bad(res, "Unknown action");
    }
    return res.json({ success: true, changed });
  } catch (e) {
    return fail(res, e, "change the status");
  }
});

module.exports = router;
