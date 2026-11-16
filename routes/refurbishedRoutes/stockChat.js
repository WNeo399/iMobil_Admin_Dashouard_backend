// Customer stock chat — the staff side (2026-11-16). See
// utils/stockChat.js for what customers can see and
// routes/stockChatPublicRoutes for the page they use.
//
//   GET    /refurbished/stock-chat/customers              enable list + usage
//   POST   /refurbished/stock-chat/customers              { name, phone, note, enabled }
//   PUT    /refurbished/stock-chat/customers/:id          same fields
//   POST   /refurbished/stock-chat/customers/:id/new-link new token (the old link dies)
//   DELETE /refurbished/stock-chat/customers/:id
//   GET    /refurbished/stock-chat/customers/:id/log      their recent questions
//   GET    /refurbished/stock-chat/prices
//   POST   /refurbished/stock-chat/prices                 one row { model, storage, grade, price, currency }
//   PUT    /refurbished/stock-chat/prices/:id
//   DELETE /refurbished/stock-chat/prices/:id
//   POST   /refurbished/stock-chat/prices/import          { rows, mode: "replace" | "merge" }
//   GET    /refurbished/stock-chat/settings · PUT     price note, daily limit, hidden models, HKD / CNY → AUD
//   GET    /refurbished/stock-chat/preview?fresh=1        exactly what customers see
//
// All of it needs refurb:stockchat:manage (Admin's wildcard for now).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const SC = require("../../utils/stockChat");

const MANAGE = requirePermission("refurb:stockchat:manage");
const CURRENCIES = ["AUD", "HKD", "CNY", "USD"];
const MAX_IMPORT = 3000;

const actor = (req) => (req.user && req.user.username) || null;
const badId = (id) => !ObjectId.isValid(String(id || ""));

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  await Promise.all([
    db.collection(SC.CUSTOMERS).createIndex({ phone: 1 }, { unique: true }),
    db.collection(SC.CUSTOMERS).createIndex({ token: 1 }, { unique: true }),
    db.collection(SC.PRICES).createIndex({ modelKey: 1, storageKey: 1, gradeKey: 1 }, { unique: true }),
    db.collection(SC.LOG).createIndex({ customerId: 1, at: -1 }),
    db.collection(SC.LOG).createIndex({ customerId: 1, day: 1 }),
  ]);
  indexed = true;
}

async function db() {
  const d = await connectToDatabase();
  await ensureIndexes(d);
  return d;
}

// ── customers ────────────────────────────────────────────────────────
function customerFields(body) {
  const b = body || {};
  const out = {};
  if (b.name !== undefined) out.name = SC.clean(b.name).slice(0, 80);
  if (b.note !== undefined) out.note = SC.clean(b.note).slice(0, 300);
  if (b.enabled !== undefined) out.enabled = b.enabled === true || b.enabled === "true";
  if (b.phone !== undefined) out.phone = SC.normalizePhone(b.phone);
  return out;
}

router.get("/customers", MANAGE, async (req, res) => {
  try {
    const d = await db();
    const customers = await d.collection(SC.CUSTOMERS).find({}).sort({ name: 1 }).toArray();
    const ids = customers.map((c) => c._id);
    const today = SC.melbourneDay();
    const usage = ids.length
      ? await d.collection(SC.LOG).aggregate([
          { $match: { customerId: { $in: ids }, day: { $ne: null } } },
          {
            $group: {
              _id: "$customerId",
              total: { $sum: 1 },
              today: { $sum: { $cond: [{ $eq: ["$day", today] }, 1, 0] } },
              lastAt: { $max: "$at" },
            },
          },
        ]).toArray()
      : [];
    const byId = new Map(usage.map((u) => [String(u._id), u]));
    const settings = await SC.getSettings(d);
    return res.json({
      success: true,
      limit: settings.dailyLimit,
      customers: customers.map((c) => {
        const u = byId.get(String(c._id)) || {};
        return { ...c, questionsToday: u.today || 0, questionsTotal: u.total || 0, lastAskedAt: u.lastAt || null };
      }),
    });
  } catch (e) {
    console.error("Stock chat customers error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the customers" });
  }
});

router.post("/customers", MANAGE, async (req, res) => {
  try {
    const f = customerFields(req.body);
    if (!f.phone) return res.status(400).json({ success: false, message: "Enter a valid phone number" });
    if (!f.name) return res.status(400).json({ success: false, message: "Enter the customer's name" });
    const d = await db();
    if (await d.collection(SC.CUSTOMERS).findOne({ phone: f.phone })) {
      return res.status(409).json({ success: false, message: `+${f.phone} is already on the list` });
    }
    const now = new Date();
    const doc = {
      name: f.name,
      phone: f.phone,
      note: f.note || "",
      enabled: f.enabled !== false,
      token: SC.newToken(),
      tokenAt: now,
      createdAt: now,
      createdBy: actor(req),
      updatedAt: now,
      updatedBy: actor(req),
    };
    const r = await d.collection(SC.CUSTOMERS).insertOne(doc);
    return res.json({ success: true, customer: { ...doc, _id: r.insertedId } });
  } catch (e) {
    console.error("Stock chat add customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the customer" });
  }
});

router.put("/customers/:id", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const f = customerFields(req.body);
    if (req.body && req.body.phone !== undefined && !f.phone) {
      return res.status(400).json({ success: false, message: "Enter a valid phone number" });
    }
    if (f.name !== undefined && !f.name) return res.status(400).json({ success: false, message: "Enter the customer's name" });
    const d = await db();
    const _id = new ObjectId(req.params.id);
    if (f.phone && (await d.collection(SC.CUSTOMERS).findOne({ phone: f.phone, _id: { $ne: _id } }))) {
      return res.status(409).json({ success: false, message: `+${f.phone} is already on the list` });
    }
    const r = await d.collection(SC.CUSTOMERS).findOneAndUpdate(
      { _id },
      { $set: { ...f, updatedAt: new Date(), updatedBy: actor(req) } },
      { returnDocument: "after" },
    );
    const doc = r && r.value !== undefined ? r.value : r;
    if (!doc) return res.status(404).json({ success: false, message: "Customer not found" });
    return res.json({ success: true, customer: doc });
  } catch (e) {
    console.error("Stock chat edit customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the customer" });
  }
});

router.post("/customers/:id/new-link", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const d = await db();
    const now = new Date();
    const r = await d.collection(SC.CUSTOMERS).findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { token: SC.newToken(), tokenAt: now, updatedAt: now, updatedBy: actor(req) } },
      { returnDocument: "after" },
    );
    const doc = r && r.value !== undefined ? r.value : r;
    if (!doc) return res.status(404).json({ success: false, message: "Customer not found" });
    return res.json({ success: true, customer: doc });
  } catch (e) {
    console.error("Stock chat new link error:", e);
    return res.status(500).json({ success: false, message: "Failed to make a new link" });
  }
});

router.delete("/customers/:id", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const d = await db();
    // Their question log stays (it carries the phone and name).
    const r = await d.collection(SC.CUSTOMERS).deleteOne({ _id: new ObjectId(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Customer not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("Stock chat delete customer error:", e);
    return res.status(500).json({ success: false, message: "Failed to remove the customer" });
  }
});

router.get("/customers/:id/log", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const d = await db();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const log = await d
      .collection(SC.LOG)
      .find({ customerId: new ObjectId(req.params.id) }, { projection: { tools: 0 } })
      .sort({ at: -1 })
      .limit(limit)
      .toArray();
    return res.json({ success: true, log });
  } catch (e) {
    console.error("Stock chat log error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the questions" });
  }
});

// ── price list ───────────────────────────────────────────────────────
// One row = Model + Storage + Grade (blank storage / grade = all of them).
function priceRow(raw) {
  const r = raw || {};
  const model = SC.clean(r.model).slice(0, 120);
  const storage = SC.clean(r.storage).slice(0, 40);
  const grade = SC.clean(r.grade).slice(0, 40);
  const price = r.price === "" || r.price == null ? NaN : Number(String(r.price).replace(/[^0-9.]/g, ""));
  const cur = String(r.currency || "AUD").trim().toUpperCase();
  if (!model) return { error: "Model is required" };
  if (!Number.isFinite(price) || price <= 0) return { error: `${model}: price must be a number above 0` };
  if (!CURRENCIES.includes(cur)) return { error: `${model}: currency must be one of ${CURRENCIES.join(", ")}` };
  return {
    row: {
      model,
      storage,
      grade,
      price: Math.round(price * 100) / 100,
      currency: cur,
      modelKey: SC.modelKey(model),
      storageKey: storage ? SC.storageKey(storage) : "",
      gradeKey: grade ? SC.gradeKey(grade) : "",
    },
  };
}

router.get("/prices", MANAGE, async (req, res) => {
  try {
    const d = await db();
    const prices = await d.collection(SC.PRICES).find({}).sort({ modelKey: 1, storageKey: 1, gradeKey: 1 }).toArray();
    return res.json({ success: true, prices });
  } catch (e) {
    console.error("Stock chat prices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the price list" });
  }
});

async function savePrice(req, res, id) {
  const p = priceRow(req.body);
  if (p.error) return res.status(400).json({ success: false, message: p.error });
  const d = await db();
  const key = { modelKey: p.row.modelKey, storageKey: p.row.storageKey, gradeKey: p.row.gradeKey };
  const clash = await d.collection(SC.PRICES).findOne(id ? { ...key, _id: { $ne: id } } : key);
  if (clash) {
    return res.status(409).json({
      success: false,
      message: `There's already a price for ${[p.row.model, p.row.storage || "any storage", p.row.grade || "any grade"].join(" · ")}`,
    });
  }
  const now = new Date();
  if (id) {
    const r = await d.collection(SC.PRICES).updateOne({ _id: id }, { $set: { ...p.row, updatedAt: now, updatedBy: actor(req) } });
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Price row not found" });
    return res.json({ success: true });
  }
  const r = await d.collection(SC.PRICES).insertOne({ ...p.row, createdAt: now, createdBy: actor(req), updatedAt: now, updatedBy: actor(req) });
  return res.json({ success: true, id: r.insertedId });
}

router.post("/prices", MANAGE, async (req, res) => {
  try {
    return await savePrice(req, res, null);
  } catch (e) {
    console.error("Stock chat add price error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the price" });
  }
});

router.put("/prices/:id", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    return await savePrice(req, res, new ObjectId(req.params.id));
  } catch (e) {
    console.error("Stock chat edit price error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the price" });
  }
});

router.delete("/prices/:id", MANAGE, async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const d = await db();
    await d.collection(SC.PRICES).deleteOne({ _id: new ObjectId(req.params.id) });
    return res.json({ success: true });
  } catch (e) {
    console.error("Stock chat delete price error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the price" });
  }
});

// A spreadsheet's rows (parsed in the browser). "replace" swaps the whole
// list; "merge" updates matching rows and adds the rest. Any bad row stops
// the import before anything is written.
router.post("/prices/import", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === "merge" ? "merge" : "replace";
    const raw = Array.isArray(body.rows) ? body.rows : [];
    if (!raw.length) return res.status(400).json({ success: false, message: "No rows to import" });
    if (raw.length > MAX_IMPORT) return res.status(400).json({ success: false, message: `At most ${MAX_IMPORT} rows` });
    const rows = new Map();
    const errors = [];
    raw.forEach((r, i) => {
      const p = priceRow(r);
      if (p.error) errors.push(`Row ${i + 1}: ${p.error}`);
      else rows.set([p.row.modelKey, p.row.storageKey, p.row.gradeKey].join("|"), p.row); // a later duplicate wins
    });
    if (errors.length) {
      return res.status(400).json({ success: false, message: `${errors.length} row(s) can't be imported`, errors: errors.slice(0, 50) });
    }
    const d = await db();
    const now = new Date();
    const who = actor(req);
    const list = [...rows.values()];
    if (mode === "replace") {
      await d.collection(SC.PRICES).deleteMany({});
      await d.collection(SC.PRICES).insertMany(list.map((r) => ({ ...r, createdAt: now, createdBy: who, updatedAt: now, updatedBy: who })));
    } else {
      await d.collection(SC.PRICES).bulkWrite(
        list.map((r) => ({
          updateOne: {
            filter: { modelKey: r.modelKey, storageKey: r.storageKey, gradeKey: r.gradeKey },
            update: { $set: { ...r, updatedAt: now, updatedBy: who }, $setOnInsert: { createdAt: now, createdBy: who } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return res.json({ success: true, imported: list.length, duplicates: raw.length - list.length, mode });
  } catch (e) {
    console.error("Stock chat price import error:", e);
    return res.status(500).json({ success: false, message: "Failed to import the price list" });
  }
});

// ── settings ─────────────────────────────────────────────────────────
router.get("/settings", MANAGE, async (req, res) => {
  try {
    return res.json({ success: true, settings: await SC.getSettings(await db()) });
  } catch (e) {
    console.error("Stock chat settings error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the settings" });
  }
});

router.put("/settings", MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    if (b.priceNote !== undefined) set.priceNote = SC.clean(b.priceNote).slice(0, 120);
    if (b.dailyLimit !== undefined) {
      const n = parseInt(b.dailyLimit, 10);
      // 0 = no limit
      if (!Number.isFinite(n) || n < 0 || n > 500) {
        return res.status(400).json({ success: false, message: "Daily limit must be 0–500 (0 = no limit)" });
      }
      set.dailyLimit = n;
    }
    // models customers never see (whole name, any case)
    if (b.hiddenModels !== undefined) {
      if (!Array.isArray(b.hiddenModels)) return res.status(400).json({ success: false, message: "Hidden models must be a list" });
      set.hiddenModels = [...new Set(b.hiddenModels.map((m) => SC.clean(m).slice(0, 120)).filter(Boolean))].slice(0, 200);
    }
    // AUD per 1 HKD / CNY, for the below-cost check
    if (b.fxToAud !== undefined) {
      const fx = {};
      for (const cur of ["HKD", "CNY"]) {
        const v = Number(b.fxToAud && b.fxToAud[cur]);
        if (!Number.isFinite(v) || v <= 0 || v > 10) {
          return res.status(400).json({ success: false, message: `${cur} → AUD rate must be a number above 0` });
        }
        fx[cur] = Math.round(v * 10000) / 10000;
      }
      set.fxToAud = fx;
    }
    const d = await db();
    await d.collection(SC.SETTINGS).updateOne(
      { _id: "settings" },
      { $set: { ...set, updatedAt: new Date(), updatedBy: actor(req) } },
      { upsert: true },
    );
    return res.json({ success: true, settings: await SC.getSettings(d) });
  } catch (e) {
    console.error("Stock chat save settings error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the settings" });
  }
});

// ── preview: what customers see ─────────────────────────────────────
router.get("/preview", MANAGE, async (req, res) => {
  try {
    const s = await SC.pricedStock({ fresh: req.query.fresh === "1" });
    const priced = s.groups.filter((g) => g.price != null);
    return res.json({
      success: true,
      at: s.at,
      groups: s.groups,
      units: s.units,
      rows: s.groups.length,
      pricedRows: priced.length,
      pricedUnits: priced.reduce((n, g) => n + g.qty, 0),
      hiddenAtExyon: s.hiddenAtExyon,
      unconfirmedAtExyon: s.unconfirmedAtExyon,
      hiddenUnits: s.hiddenUnits,
      belowCostUnits: s.belowCostUnits,
      exyonOk: s.exyonOk,
      exyonError: s.exyonOk ? null : "Exyon's database couldn't be checked — units it may have sold are still shown.",
    });
  } catch (e) {
    console.error("Stock chat preview error:", e);
    return res.status(500).json({ success: false, message: "Failed to build the stock view" });
  }
});

module.exports = router;
