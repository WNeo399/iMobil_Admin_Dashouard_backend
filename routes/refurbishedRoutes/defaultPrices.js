// Refurbished Device — default prices (Mongo: refurb_default_prices).
//
// A phone supplier's usual price for a Model + Storage + Grade (user ask
// 2026-11-05). When they add a device Blackbelt has a report on, the model
// and storage come from the report; once a grade is picked the page asks
// here for that combination's default and fills the price in. The price can
// be changed and saved as the new default.
//
// Scoped like Suppliers: phone suppliers only, everything filed under the
// stock source on the caller's user record, so each supplier location keeps
// its own prices. The price is the supplier's own figure (what they charge
// us, in their currency) — never our landed cost.
//
//   POST /refurbished/default-prices/lookup  { pairs: [{ model, storage }] } → their defaults, every grade
//   PUT  /refurbished/default-prices          { model, storage, grade, price, currency } → saved as the default

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { actsAsPhoneSupplier } = require("../../constants/roles");
const { normalizeStockSource } = require("./stockSource");

const VIEW = requirePermission("refurb:stock:view");
const MANAGE = requirePermission("refurb:stock:manage");
const PRICES = "refurb_default_prices";
const CURRENCIES = ["AUD", "CNY", "HKD"];
const MAX_PAIRS = 200;

const str = (v, cap) => String(v == null ? "" : v).trim().replace(/\s+/g, " ").slice(0, cap);
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;

// The match keys: "iPhone 13" / "iphone 13", "128GB" / "128 GB", "a+" / "A+"
// are the same combination.
const modelKey = (v) => str(v, 120).toLowerCase();
const storageKey = (v) => str(v, 30).replace(/\s+/g, "").toUpperCase();
const gradeKey = (v) => str(v, 10).toUpperCase();

function supplierScope(req, res) {
  if (!actsAsPhoneSupplier(req.user)) {
    res.status(403).json({ success: false, message: "Default prices are kept by phone-supplier accounts" });
    return null;
  }
  const src = normalizeStockSource(req.user.stockSource);
  if (!src) {
    res.status(400).json({
      success: false,
      message: "Your account has no stock source assigned — ask an admin to set it first",
    });
    return null;
  }
  return src;
}

const view = (d) => ({
  model: d.model,
  storage: d.storage,
  grade: d.grade,
  price: d.price,
  currency: d.currency,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

// ── POST /refurbished/default-prices/lookup ─────────────────────────
// Every grade's default for each model + storage asked about.
router.post("/lookup", VIEW, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    const pairs = Array.isArray(req.body && req.body.pairs) ? req.body.pairs.slice(0, MAX_PAIRS) : [];
    const or = [];
    const seen = new Set();
    for (const p of pairs) {
      const m = modelKey(p && p.model);
      const s = storageKey(p && p.storage);
      if (!m || !s || seen.has(m + "|" + s)) continue;
      seen.add(m + "|" + s);
      or.push({ modelKey: m, storageKey: s });
    }
    if (!or.length) return res.json({ success: true, prices: [] });
    const db = await connectToDatabase();
    const docs = await db
      .collection(PRICES)
      .find({ stockSource: src, $or: or })
      .toArray();
    return res.json({ success: true, prices: docs.map(view) });
  } catch (e) {
    console.error("Default price lookup error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the default prices" });
  }
});

// ── PUT /refurbished/default-prices ─────────────────────────────────
// Saves the price as the default for that model + storage + grade (new, or
// replacing the old one — the earlier figure is kept in its history).
router.put("/", MANAGE, async (req, res) => {
  try {
    const src = supplierScope(req, res);
    if (!src) return;
    const b = req.body || {};
    const model = str(b.model, 120);
    const storage = str(b.storage, 30);
    const grade = gradeKey(b.grade);
    if (!model || !storage || !grade) {
      return res.status(400).json({ success: false, message: "Model, storage and grade are required" });
    }
    const price = Math.round(Number(b.price) * 100) / 100;
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ success: false, message: "Enter a price above 0" });
    }
    const currency = String(b.currency || "").trim().toUpperCase();
    if (!CURRENCIES.includes(currency)) {
      return res.status(400).json({ success: false, message: "Currency must be AUD, CNY or HKD" });
    }

    const db = await connectToDatabase();
    const col = db.collection(PRICES);
    const key = { stockSource: src, modelKey: modelKey(model), storageKey: storageKey(storage), grade };
    const before = await col.findOne(key);
    const now = new Date();
    const by = actor(req);
    if (before && before.price === price && before.currency === currency) {
      return res.json({ success: true, message: "Already the default price", price: view(before) });
    }
    await col.updateOne(
      key,
      {
        $set: { model, storage, price, currency, updatedAt: now, updatedBy: by },
        $setOnInsert: { createdAt: now, createdBy: by },
        $push: {
          history: {
            $each: [{ at: now, by, price, currency, ...(before ? { from: { price: before.price, currency: before.currency } } : {}) }],
            $slice: -50,
          },
        },
      },
      { upsert: true },
    );
    const saved = await col.findOne(key);
    return res.json({ success: true, message: "Default price saved", price: view(saved) });
  } catch (e) {
    console.error("Default price save error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the default price" });
  }
});

module.exports = router;
