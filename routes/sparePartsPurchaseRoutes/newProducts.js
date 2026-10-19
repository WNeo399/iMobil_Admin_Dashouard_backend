// Spare Parts Purchase → New Products (user ask 2026-10-06): the device
// models we want parts for, and whether Zoho Inventory already has each of
// the part types a brand needs — with the missing ones created from here.
//
// Models live in imb_spp_new_products (one record per model; the first
// batch is Skyline Mobile Parts' 107 Motorola models, seeded 2026-10-06).
// What a brand needs per model (Motorola: Screen, Battery, Charging Port)
// is the BRANDS table below — a new brand is a new entry there plus its
// models.
//
// "Have" is read from the stock register (imb_stock_items — Zoho's own
// Classification / Sub Classification / Device Brand / Compatible Model
// custom fields): an active Zoho item of the right classification whose
// Compatible Model names the model (or one of its aliases — Skyline's
// wording, China-market names), compared with brand words, 4G/5G, model
// codes and punctuation ignored. An item filed in the register's Archive
// bucket still exists in Zoho, so it still counts (shown as archived).
// One item can fit several models (the Compatible Model field holds a
// "; "-separated list): it is created once and counted for every model
// picked. Items created from this page are kept on
// the model (`created`) so they count straight away; the nightly register
// refresh picks them up from Zoho.
//
//   GET  /new-products                      brands + models with coverage (every brand, or ?brand=)
//   GET  /new-products/models/:id/items     one model's items, every classification
//   GET  /new-products/model-options        Add Model's Model list: models Zoho has parts for in a brand + series, not on the page yet
//   POST /new-products/models               add a model (categoryId? = its store category)
//   PUT  /new-products/models/:id           edit a model (or hide it: active false; categoryId links its store category)
//   GET  /new-products/next-sku             the next free parts SKU (22xxx) — asks Zoho
//   GET  /new-products/categories           the store categories to file a new item under (Zoho Commerce)
//   POST /new-products/items                create one Zoho item for a model + part (+ photos, price lists; or from a draft)
//   POST /new-products/drafts               save the create dialog as a draft (not in Zoho)
//   GET  /new-products/drafts/:id           one draft
//   PUT  /new-products/drafts/:id           change a draft (fields, photos and their order)
//   DELETE /new-products/drafts/:id         delete a draft (marked deleted, kept in the DB)
//
// Permissions (2026-10-16, the page moved under iMobile Listing):
// listing:product:view / listing:product:create — Admin, iMobile Warehouse,
// iMobile Purchase (listing:*:*). /next-sku also answers spp:product:create:
// the Purchase Order page's "Create in Zoho" dialog asks it for a SKU.

const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { hasPermission } = require("../../constants/roles");
const { connectToDatabase } = require("../../utils/mongodb");
const { refreshToken } = require("../../utils/zohoRequest");
const { imageUrlFromId } = require("../../utils/productImage");
const { storeImage, removeImage } = require("../../utils/sppImages");
// creating the Zoho item (shared with the Purchase Order page's New Product lines)
const {
  PLACEHOLDER_RATE, PRICE_LISTS, MAX_IMAGES, acceptPhotos, parsePriceLists, qualityOptions, classificationOptions, cleanQuality,
  skuTaken, nextFreeSku, createZohoItem, setItemCategory, setPriceLists, uploadItemPhotos, readImagesFromUrls, readCost,
} = require("../../utils/zohoNewItem");
// the pricing formula (the dialog prices a typed cost with it) and the store categories
const { PRICE_FORMULAS, priceRuleFamily } = require("../../utils/priceRules");
const { loadCategories, findCategory } = require("../websiteRoutes/categories");
const { qualitiesByClassification, ZOHO_CLASSIFICATIONS } = require("../../utils/listingQualities");

const MODELS = "imb_spp_new_products";
const ITEMS = "imb_stock_items";

const VIEW = requirePermission("listing:product:view");
const CREATE = requirePermission("listing:product:create");
// the next free SKU: this page, or "Create in Zoho" on a Purchase Order line
const SKU = (req, res, next) => {
  const have = (req.user && req.user.permissions) || [];
  if (["listing:product:create", "spp:product:create"].some((p) => hasPermission(have, p))) return next();
  return res.status(403).json({ success: false, message: "You do not have permission for this action" });
};

// The parts a brand needs for every model, and how each is written up in
// Zoho — the register's Classification / Sub Classification, and the item
// name the team's recent Motorola items follow ("MOTO G86 / G86 Power 5G
// (XT2527) Compatible LCD Touch Digitizer Screen", "MOTO Razr 40 Ultra
// Compatible Charging Port"). `compatibleModel` is the Compatible Model
// value for a new item; `short` is the model without the brand's own
// prefix ("Moto G96" → "G96").
const BRANDS = {
  Motorola: {
    label: "Motorola",
    deviceBrand: "Motorola",
    parts: [
      { key: "screen", label: "Screen", classification: "Screen", subClassification: "", name: (m) => `MOTO ${withCodes(m)} Compatible LCD Touch Digitizer Screen` },
      { key: "battery", label: "Battery", classification: "Battery", subClassification: "", name: (m) => `MOTO ${withCodes(m)} Compatible Battery` },
      { key: "chargingPort", label: "Charging Port", classification: "Small Parts", subClassification: "Charging Port", name: (m) => `MOTO ${withCodes(m)} Compatible Charging Port` },
    ],
    compatibleModel: (m) => `Motorola ${m.model}`,
    short: (m) => String(m.model).replace(/^Moto\s+/i, ""),
    // how any other product's name starts (the rest is typed)
    namePrefix: (m) => `MOTO ${withCodes(m)} Compatible`,
    // Device Series from a Compatible Model — the product line's own name +
    // " Series" (user 2026-10-07; the 163 existing items were set the same way)
    series: (compatibleModel) => {
      const m = String(compatibleModel || "").replace(/^Motorola\s+/i, "").trim();
      if (/^Razr\b/i.test(m)) return "Razr Series";
      if (/^Edge\b/i.test(m)) return "Edge Series";
      if (/^Moto G/i.test(m)) return "Moto G Series";
      if (/^Moto E/i.test(m)) return "Moto E Series";
      if (/^Moto X/i.test(m)) return "Moto X Series";
      if (/^Moto Z/i.test(m)) return "Moto Z Series";
      if (/^Moto S/i.test(m)) return "Moto S Series";
      if (/^One\b/i.test(m)) return "One Series";
      if (/^ThinkPhone/i.test(m)) return "ThinkPhone";
      return "";
    },
    // the Add Model dialog's hints, and a new store category's name start
    // (the page keeps Motorola's own rule: "MOTO G96", "Edge 70 Pro")
    modelHint: "e.g. Moto G96",
    codesHint: "XT…",
    categoryPrefix: "MOTO ",
    words: ["motorola", "moto"],
  },
};

// The other brands (user ask 2026-10-19, "more brands"): the same three
// needed parts, named the way the register's own items of the brand are —
// "Samsung Galaxy A52 (A525) Compatible …" (Compatible Model "Galaxy A52
// (A525)"), "Google Pixel 11 Compatible …", "iPhone 17 Pro Compatible …",
// "OPPO Reno 13 5G Compatible …". No series rule: an item's Device Series is
// its models' own series on this page, picked from the brand's Zoho Device
// Series ("S Series", "Fold Series", "Pixel", "iPhone").
// the model without the brand's own words in front ("Samsung Galaxy S26" → "S26")
const stripWords = (model, words) => {
  let s = String(model || "").trim();
  for (let again = true; again;) {
    again = false;
    for (const w of words) {
      const rx = new RegExp(`^${w}\\s+`, "i");
      if (rx.test(s)) { s = s.replace(rx, ""); again = true; }
    }
  }
  return s;
};
function otherBrand({ label, deviceBrand = label, words, display, cm, categoryPrefix, modelHint, codesHint = "" }) {
  const cfg = {
    label,
    deviceBrand,
    words,
    short: (m) => stripWords(m.model, words),
    compatibleModel: (m) => cm(m, cfg.short(m)),
    namePrefix: (m) => `${display(m, cfg.short(m))} Compatible`,
    series: null,
    stripModel: true,
    categoryPrefix,
    modelHint,
    codesHint,
  };
  // Motorola's three, as "<display> Compatible …"
  cfg.parts = [
    { key: "screen", label: "Screen", classification: "Screen", subClassification: "", name: (m) => `${cfg.namePrefix(m)} LCD Touch Digitizer Screen` },
    { key: "battery", label: "Battery", classification: "Battery", subClassification: "", name: (m) => `${cfg.namePrefix(m)} Battery` },
    { key: "chargingPort", label: "Charging Port", classification: "Small Parts", subClassification: "Charging Port", name: (m) => `${cfg.namePrefix(m)} Charging Port` },
  ];
  return cfg;
}
// Realme / OnePlus phones are filed under OPPO in Zoho (brand rules 2026-09) but keep their own name
const oppoName = (s) => (/^(realme|oneplus)\b/i.test(s) ? s : `OPPO ${s}`);
Object.assign(BRANDS, {
  Samsung: otherBrand({ label: "Samsung", words: ["samsung", "galaxy"], display: (m) => `Samsung Galaxy ${withCodes(m)}`, cm: (m) => `Galaxy ${withCodes(m)}`, categoryPrefix: "Galaxy ", modelHint: "e.g. S26 Ultra, Z Fold 8, A57", codesHint: "e.g. S948" }),
  Google: otherBrand({ label: "Google", words: ["google"], display: (m) => `Google ${withCodes(m)}`, cm: (m, s) => `Google ${s}`, categoryPrefix: "Google ", modelHint: "e.g. Pixel 11 Pro" }),
  Apple: otherBrand({ label: "Apple", words: ["apple"], display: (m) => withCodes(m), cm: (m, s) => s, categoryPrefix: "", modelHint: "e.g. iPhone 17 Pro", codesHint: "e.g. A3256" }),
  OPPO: otherBrand({ label: "OPPO", words: ["oppo"], display: (m) => oppoName(withCodes(m)), cm: (m, s) => oppoName(s), categoryPrefix: "OPPO ", modelHint: "e.g. Reno 14 5G, Find X9 Pro", codesHint: "e.g. CPH2689" }),
  Xiaomi: otherBrand({ label: "Xiaomi", words: ["xiaomi"], display: (m) => `Xiaomi ${withCodes(m)}`, cm: (m, s) => `Xiaomi ${s}`, categoryPrefix: "Xiaomi ", modelHint: "e.g. Redmi Note 14 Pro" }),
  Huawei: otherBrand({ label: "Huawei", words: ["huawei"], display: (m) => `Huawei ${withCodes(m)}`, cm: (m, s) => `Huawei ${s}`, categoryPrefix: "Huawei ", modelHint: "e.g. P60 Pro" }),
  Sony: otherBrand({ label: "Sony", words: ["sony"], display: (m) => `Sony ${withCodes(m)}`, cm: (m, s) => `Sony ${s}`, categoryPrefix: "Sony ", modelHint: "e.g. Xperia 1 VII" }),
  Nokia: otherBrand({ label: "Nokia", words: ["nokia"], display: (m) => `Nokia ${withCodes(m)}`, cm: (m, s) => `Nokia ${s}`, categoryPrefix: "Nokia ", modelHint: "e.g. G42" }),
});
// The Device Series for a set of Compatible Models ("; "-joined, like the
// other brands' items); "" when the brand has no series rule.
function seriesFor(cfg, models) {
  if (!cfg || !cfg.series) return "";
  return [...new Set((models || []).map(cfg.series).filter(Boolean))].join("; ");
}
// A new item's Device Series: the brand's rule (Motorola), else the series of
// every model of the brand it is given for — this one's, and those whose
// Compatible Model was picked too ("; "-joined).
async function deviceSeriesFor(db, model, compatibleModels) {
  const cfg = BRANDS[model.brand];
  if (cfg.series) return seriesFor(cfg, compatibleModels);
  const others = await db.collection(MODELS).find({ brand: model.brand, active: { $ne: false }, compatibleModel: { $in: compatibleModels } }, { projection: { series: 1 } }).toArray();
  return [...new Set([model.series, ...others.map((o) => o.series)].map(str).filter(Boolean))].join("; ");
}
function withCodes(m) {
  const short = BRANDS[m.brand].short(m);
  const codes = (m.codes || []).filter(Boolean);
  return codes.length ? `${short} (${codes.join(" / ")})` : short;
}

// Any other product for a model (user ask 2026-10-16) — not one of the
// brand's needed parts: its Zoho classification and sub classification are
// picked in the dialog and its name typed (no template). Part key "other".
const OTHER = "other";
// The part a request means: a needed part by key, or "other" with its
// classification. { part } or { error }.
function partFor(cfg, b) {
  const key = str(b.part);
  if (key === OTHER) {
    const classification = str(b.classification);
    if (!ZOHO_CLASSIFICATIONS.includes(classification)) return { error: "Pick the classification" };
    const subClassification = str(b.subClassification).replace(/\s+/g, " ").slice(0, 60);
    if (/[[\]]/.test(subClassification)) return { error: "Sub classification can't contain [ or ]" };
    return { part: { key: OTHER, label: classification, classification, subClassification, name: () => "" } };
  }
  const part = cfg && cfg.parts.find((p) => p.key === key);
  return part ? { part } : { error: "Unknown part type for this brand" };
}


const str = (v) => String(v == null ? "" : v).trim();
const oid = (v) => { try { return new ObjectId(String(v)); } catch (e) { return null; } };
const bad = (res, message) => res.status(400).json({ success: false, message });
const actor = (req) => (req.user && (req.user.username || req.user.email)) || null;
const list = (v) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,;\n]/)).map((x) => str(x)).filter(Boolean);

// A model name reduced to what identifies the phone: brand words, 4G/5G,
// model codes (XT2527-1, PB8F0000AU) and punctuation dropped, lower case.
function modelKey(s) {
  return String(s || "").toLowerCase()
    .replace(/\b(xt|pb|pa)[-\w]*\d[\w-]*/g, " ")
    .replace(/\b(motorola|moto|samsung|galaxy|google|apple|oppo|xiaomi|huawei|sony|nokia|5g|4g|us)\b/g, " ")
    .replace(/[^a-z0-9()]+/g, "");
}

// The keys a model is matched by: its name, Compatible Model and aliases.
function modelKeysOf(m) {
  return [...new Set([m.model, m.compatibleModel, ...(m.aliases || [])].map(modelKey).filter(Boolean))];
}

// Which of the brand's needed parts an item is, if any.
function partOf(cfg, it) {
  return cfg.parts.find((p) => p.classification === it.classification && (!p.subClassification || p.subClassification === it.subClassification)) || null;
}
// …and of one created from this page
function createdPart(cfg, c) {
  return c.part === OTHER ? partOf(cfg, c) : cfg.parts.find((p) => p.key === c.part) || null;
}

// The register's live items for a brand (archived ones included — they
// still exist in Zoho).
function brandItems(db, brand) {
  const cfg = BRANDS[brand];
  return db.collection(ITEMS).find(
    { deviceBrand: new RegExp(`^${cfg.deviceBrand}$`, "i"), active: { $ne: false } },
    { projection: { _id: 0, itemId: 1, sku: 1, name: 1, classification: 1, subClassification: 1, quality: 1, compatibleModels: 1, archived: 1, imageId: 1, scope: 1, "metrics.available": 1 } },
  ).toArray();
}

// The register's items for a brand, by model key, then the part they are.
async function registerIndex(db, brand) {
  const cfg = BRANDS[brand];
  const items = await brandItems(db, brand);
  const index = new Map(); // modelKey → partKey → [items]
  for (const it of items) {
    const part = partOf(cfg, it);
    if (!part) continue;
    for (const m of it.compatibleModels || []) {
      const k = modelKey(m);
      if (!k) continue;
      if (!index.has(k)) index.set(k, {});
      const byPart = index.get(k);
      (byPart[part.key] = byPart[part.key] || []).push({ itemId: it.itemId, sku: it.sku, name: it.name, quality: it.quality || "", archived: !!it.archived });
    }
  }
  return index;
}

function coverage(model, index) {
  const cfg = BRANDS[model.brand];
  const keys = modelKeysOf(model);
  const out = {};
  for (const p of cfg.parts) {
    const seen = new Map();
    for (const k of keys) for (const it of ((index.get(k) || {})[p.key] || [])) seen.set(String(it.itemId), it);
    // (any other product counts when its classification is a needed part's, as the register will)
    for (const c of model.created || []) if (createdPart(cfg, c) === p) seen.set(String(c.itemId), { itemId: c.itemId, sku: c.sku, name: c.name, quality: c.quality || "", createdHere: true });
    out[p.key] = [...seen.values()];
  }
  return out;
}

// ── GET /new-products ────────────────────────────────────────────────
// Every configured brand's models (the page's Brand › Series › Model tree),
// or one brand with ?brand=. Each row: the items found per needed part
// (`have`) and the needed parts with none (`missing`).
router.get("/", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const asked = str(req.query.brand);
    const brandList = BRANDS[asked] ? [asked] : Object.keys(BRANDS);
    const rows = [];
    // the series to pick from per brand (Add Model): the page's own, then —
    // for a brand without a series rule — Zoho's Device Series of its parts
    // (one query each — the database is a round trip away; 2026-10-19)
    const seriesOptions = Object.fromEntries(Object.keys(BRANDS).map((b) => [b, []]));
    const own = await db.collection(MODELS).aggregate([
      { $match: { active: { $ne: false }, series: { $nin: [null, ""] } } },
      { $group: { _id: { b: "$brand", s: "$series" }, o: { $min: "$seriesOrder" } } },
      { $sort: { o: 1, "_id.s": 1 } },
    ]).toArray();
    for (const x of own) if (seriesOptions[x._id.b]) seriesOptions[x._id.b].push(x._id.s);
    const zohoSeries = await db.collection(ITEMS).aggregate([
      { $match: { active: { $ne: false }, scope: "parts", deviceSeries: { $nin: [null, ""] } } },
      { $group: { _id: { b: "$deviceBrand", s: "$deviceSeries" }, n: { $sum: 1 } } },
    ]).toArray();
    for (const brand of Object.keys(BRANDS).filter((b) => !BRANDS[b].series)) {
      const counts = new Map();
      for (const x of zohoSeries) {
        if (String(x._id.b).toLowerCase() !== BRANDS[brand].deviceBrand.toLowerCase()) continue;
        // an item filed under several ("S Series; Note Series") counts for each
        for (const s of String(x._id.s).split(";").map((y) => y.trim()).filter(Boolean)) counts.set(s, (counts.get(s) || 0) + x.n);
      }
      const zoho = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
      seriesOptions[brand] = [...new Set([...seriesOptions[brand], ...zoho])];
    }
    const allModels = await db.collection(MODELS).find({ brand: { $in: brandList }, active: { $ne: false } }).sort({ seriesOrder: 1, series: 1, sortKey: 1, model: 1 }).toArray();
    for (const brand of brandList) {
      const models = allModels.filter((m) => m.brand === brand);
      if (!models.length) continue; // a brand with no models yet: nothing to read from the register
      const index = await registerIndex(db, brand);
      const cfg = BRANDS[brand];
      for (const m of models) {
        const have = coverage(m, index);
        const missing = cfg.parts.filter((p) => !(have[p.key] || []).length).map((p) => p.key);
        // the create dialog's default item name per part (no Zoho call — the
        // dialog opens straight away; only the SKU is fetched separately)
        const defaultNames = Object.fromEntries(cfg.parts.map((p) => [p.key, p.name(m)]));
        // any other product: the name's start, the rest typed
        defaultNames[OTHER] = `${cfg.namePrefix(m)} `;
        // a brand with a series rule (Motorola) works it out; the others use the model's own series
        const deviceSeries = cfg.series ? seriesFor(cfg, [m.compatibleModel || cfg.compatibleModel(m)]) : str(m.series);
        rows.push({ ...m, _id: String(m._id), have, missing, defaultNames, deviceSeries });
      }
    }
    return res.json({
      success: true,
      brand: brandList.length === 1 ? brandList[0] : "",
      brands: Object.keys(BRANDS).map((b) => ({
        value: b,
        label: BRANDS[b].label,
        deviceBrand: BRANDS[b].deviceBrand,
        // the Add Model dialog: the series to pick from, field hints, the
        // brand's own words (dropped from a model name) and how a new store
        // category's name starts
        series: seriesOptions[b] || [],
        modelHint: BRANDS[b].modelHint || "",
        codesHint: BRANDS[b].codesHint || "",
        words: BRANDS[b].words || [],
        categoryPrefix: BRANDS[b].categoryPrefix || "",
        parts: BRANDS[b].parts.map((p) => ({
          key: p.key, label: p.label, classification: p.classification, subClassification: p.subClassification,
          // which formula prices it (a "Service Pack" quality switches the dialog to that one)
          priceFamily: priceRuleFamily({ classification: p.classification }),
        })),
      })),
      qualities: await qualityOptions(db),
      // the qualities each classification comes in (iMobile Listing → Qualities); none = every one
      qualitiesByClass: await qualitiesByClassification(db),
      // any other product: Zoho's classifications with their subs, and which price formula each takes
      classifications: await classificationOptions(db),
      priceFamilies: Object.fromEntries(ZOHO_CLASSIFICATIONS.map((c) => [c, priceRuleFamily({ classification: c })])),
      placeholderRate: PLACEHOLDER_RATE,
      priceFormulas: PRICE_FORMULAS,
      rows,
      // the open drafts, newest first (each opens in the create dialog)
      drafts: (await db.collection(DRAFTS).find({ status: "draft", brand: { $in: brandList } }).sort({ updatedAt: -1 }).toArray()).map(draftBrief),
      summary: { models: rows.length, complete: rows.filter((r) => !r.missing.length).length, missingCells: rows.reduce((t, r) => t + r.missing.length, 0) },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /new-products/models/:id/items ───────────────────────────────
// Every register item filed under the model (its name, Compatible Model or
// an alias — any classification), plus the ones created from this page that
// the register hasn't picked up yet. `part` marks the brand's needed parts
// (Screen / Battery / Charging Port); `missing` lists the needed parts with
// no item at all.
router.get("/models/:id/items", VIEW, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const model = await db.collection(MODELS).findOne({ _id });
    if (!model) return res.status(404).json({ success: false, message: "Model not found" });
    const cfg = BRANDS[model.brand];
    if (!cfg) return bad(res, "Unknown brand");
    const keys = new Set(modelKeysOf(model));
    const seen = new Map();
    for (const it of await brandItems(db, model.brand)) {
      if (!(it.compatibleModels || []).some((m) => keys.has(modelKey(m)))) continue;
      const part = partOf(cfg, it);
      seen.set(String(it.itemId), {
        itemId: it.itemId,
        sku: it.sku || "",
        name: it.name || "",
        classification: it.classification || "",
        subClassification: it.subClassification || "",
        quality: it.quality || "",
        archived: !!it.archived,
        scope: it.scope || "",
        available: it.metrics ? it.metrics.available : null,
        imageUrl: imageUrlFromId(it.imageId),
        compatibleModels: it.compatibleModels || [],
        part: part ? part.key : null,
      });
    }
    for (const c of model.created || []) {
      if (seen.has(String(c.itemId))) { seen.get(String(c.itemId)).createdHere = true; continue; }
      const part = createdPart(cfg, c);
      const other = c.part === OTHER;
      seen.set(String(c.itemId), {
        itemId: c.itemId, sku: c.sku, name: c.name, quality: c.quality || "",
        // a needed part's, or the one picked for any other product
        classification: other || !part ? c.classification || "" : part.classification,
        subClassification: other || !part ? c.subClassification || "" : part.subClassification,
        archived: false, scope: "parts", available: null, imageUrl: imageUrlFromId(c.imageId),
        compatibleModels: c.compatibleModels || [c.compatibleModel].filter(Boolean),
        part: part ? part.key : null, createdHere: true,
      });
    }
    const items = [...seen.values()];
    const missing = cfg.parts.filter((p) => !items.some((i) => i.part === p.key)).map((p) => p.key);
    return res.json({ success: true, model: { ...model, _id: String(model._id) }, items, missing });
  } catch (error) {
    next(error);
  }
});

// A model from a request body — brand must be configured.
function modelFromBody(b, existing) {
  const brand = str(b.brand) || (existing && existing.brand);
  if (!BRANDS[brand]) return { error: "Unknown brand" };
  let model = str(b.model !== undefined ? b.model : existing && existing.model);
  // the other brands keep the model without their own words ("Samsung Galaxy Z Fold 8" → "Z Fold 8"); Motorola's are "Moto G96"
  if (BRANDS[brand].stripModel) model = stripWords(model, BRANDS[brand].words);
  if (!model) return { error: "Model is required" };
  const doc = {
    brand,
    series: str(b.series !== undefined ? b.series : existing && existing.series),
    model,
    codes: b.codes !== undefined ? list(b.codes) : (existing && existing.codes) || [],
    aliases: b.aliases !== undefined ? list(b.aliases) : (existing && existing.aliases) || [],
    note: str(b.note !== undefined ? b.note : existing && existing.note),
  };
  // The Compatible Model is no longer typed (Add Model, 2026-10-19): it is the
  // brand's rule — worked out again when the model or its codes change, unless
  // the record carries one of its own (Skyline's seeded wording).
  const auto = existing && existing.compatibleModel === BRANDS[brand].compatibleModel(existing);
  const kept = b.compatibleModel !== undefined ? b.compatibleModel : existing && !auto ? existing.compatibleModel : "";
  doc.compatibleModel = str(kept) || BRANDS[brand].compatibleModel(doc);
  return { doc };
}

// ── POST /new-products/models ────────────────────────────────────────
router.post("/models", CREATE, async (req, res, next) => {
  try {
    const { doc, error } = modelFromBody(req.body || {});
    if (error) return bad(res, error);
    const db = await connectToDatabase();
    // already listed: the same name once brand words, 4G/5G, case and punctuation are set aside
    const key = modelKey(doc.model);
    const listed = await db.collection(MODELS).find({ brand: doc.brand, active: { $ne: false } }, { projection: { model: 1 } }).toArray();
    const dup = listed.find((m) => modelKey(m.model) === key);
    if (dup) return bad(res, `${doc.brand} ${dup.model} is already listed`);
    // its store category, when one is picked already
    let link = {};
    if (req.body && req.body.categoryId !== undefined) {
      const c = await categoryLink(req.body.categoryId);
      if (c.error) return res.status(c.status).json({ success: false, message: c.error });
      link = c.link;
    }
    const now = new Date();
    const full = { ...doc, ...link, source: "added on the page", active: true, created: [], createdAt: now, createdBy: actor(req), updatedAt: now };
    const r = await db.collection(MODELS).insertOne(full);
    return res.json({ success: true, model: { ...full, _id: String(r.insertedId) } });
  } catch (error) {
    next(error);
  }
});

// ── GET /new-products/model-options?brand=&series= ───────────────────
// The Add Model dialog's Model list (user ask 2026-10-19): the models Zoho
// already has parts for in the brand + series — each Compatible Model value
// of the register's parts — less the ones on this page already. Each comes
// with the model name and codes the page keeps ("Galaxy Z Fold 8 (F971)" →
// "Z Fold 8" + F971), the Compatible Model itself (sent back on add, so the
// existing parts count at once), how many parts it has, which of the needed
// ones, and the store category most of them are filed under in Zoho (the
// dialog links the model there by default — linking never moves a part).
const MODEL_CODE = /\s*\(([A-Z]{1,3}\d{3,4}[A-Z]?)\)\s*$/i; // "(F971)", "(G850)" — not "(2022)" or "(44mm)"
// a brand's parts from the register (what the Model list reads), kept a minute
const PARTS_TTL = 60 * 1000;
const partsCache = new Map(); // deviceBrand → { at, items }
async function brandParts(db, cfg) {
  const hit = partsCache.get(cfg.deviceBrand);
  if (hit && Date.now() - hit.at < PARTS_TTL) return hit.items;
  const items = await db.collection(ITEMS).find(
    { deviceBrand: new RegExp(`^${cfg.deviceBrand}$`, "i"), active: { $ne: false }, scope: "parts" },
    { projection: { _id: 0, classification: 1, subClassification: 1, compatibleModels: 1, deviceSeries: 1, zohoCategoryId: 1, zohoCategory: 1 } },
  ).toArray();
  partsCache.set(cfg.deviceBrand, { at: Date.now(), items });
  return items;
}
function optionFromCompatibleModel(cfg, cm) {
  if (!cfg.stripModel) return { model: str(cm).replace(new RegExp(`^${cfg.deviceBrand}\\s+`, "i"), ""), codes: [] };
  const s = stripWords(cm, cfg.words);
  const code = s.match(MODEL_CODE);
  return code ? { model: s.replace(MODEL_CODE, "").trim(), codes: [code[1].toUpperCase()] } : { model: s, codes: [] };
}
router.get("/model-options", CREATE, async (req, res, next) => {
  try {
    const brand = str(req.query.brand);
    const series = str(req.query.series);
    const cfg = BRANDS[brand];
    if (!cfg) return bad(res, "Unknown brand");
    if (!series) return res.json({ success: true, options: [] });
    const db = await connectToDatabase();
    const onPage = await db.collection(MODELS).find({ brand, active: { $ne: false } }, { projection: { model: 1, compatibleModel: 1, aliases: 1 } }).toArray();
    const listed = new Set(onPage.flatMap(modelKeysOf));
    // the Zoho Device Series the page's series stands for: itself, or
    // (Motorola) the rule's series of the page's models in it ("G" → "Moto G Series")
    let zohoSeries = [series];
    if (cfg.series) {
      const mine = await db.collection(MODELS).find({ brand, series, active: { $ne: false } }, { projection: { model: 1, compatibleModel: 1 } }).toArray();
      zohoSeries = [...new Set(mine.map((m) => cfg.series(m.compatibleModel || cfg.compatibleModel(m))).filter(Boolean))];
      if (!zohoSeries.length) zohoSeries = [cfg.series(`${cfg.deviceBrand} ${series}`) || series];
    }
    // every part of the brand: a part that fits several phones carries one
    // Device Series, so a phone's own series is the one most of its parts
    // carry (an "A72" on an "S Series" part is still an A Series phone).
    // Kept a minute, for picking one series after another in the dialog.
    const items = await brandParts(db, cfg);
    // one option per phone: Zoho's spellings of the same model ("Pixel 10a" /
    // "Pixel 10A", "Moto G57" / "Moto G57 5G") are one, as the page counts
    // them — shown with the spelling most of its parts use
    const byKey = new Map();
    for (const it of items) {
      const itemSeries = String(it.deviceSeries || "").split(";").map((x) => x.trim()).filter(Boolean);
      const part = partOf(cfg, it);
      for (const cm of it.compatibleModels || []) {
        const name = str(cm);
        const key = modelKey(name);
        if (!name || !key || listed.has(key)) continue;
        const o = byKey.get(key) || { spellings: new Map(), series: new Map(), categories: new Map(), items: 0, have: [] };
        o.spellings.set(name, (o.spellings.get(name) || 0) + 1);
        for (const s of itemSeries) o.series.set(s, (o.series.get(s) || 0) + 1);
        // the store category its parts are filed under in Zoho
        if (it.zohoCategoryId) {
          const c = o.categories.get(String(it.zohoCategoryId)) || { id: String(it.zohoCategoryId), name: it.zohoCategory || "", n: 0 };
          c.n++;
          o.categories.set(c.id, c);
        }
        o.items++;
        if (part && !o.have.includes(part.key)) o.have.push(part.key);
        byKey.set(key, o);
      }
    }
    const wanted = new Set(zohoSeries.map((s) => s.toLowerCase()));
    // the brand's series by the name they start ("A Series" → "A95 5G", "Reno Series" → "Reno 13", "Tab Series" → "Tab S9"), longest first
    const stems = [...new Set(items.flatMap((it) => String(it.deviceSeries || "").split(";").map((x) => x.trim())).filter(Boolean))]
      .map((s) => ({ series: s, stem: s.replace(/\s*series$/i, "").trim().toLowerCase() }))
      .filter((x) => x.stem)
      .sort((a, b) => b.stem.length - a.stem.length);
    const byName = (model) => {
      const m = String(model || "").toLowerCase();
      const hit = stems.find((x) => m.startsWith(x.stem) && /^[\s\d]/.test(m.slice(x.stem.length)));
      return hit ? hit.series : "";
    };
    const inSeries = (o, name) => {
      // Motorola: the model's own series by the rule
      if (cfg.series) return zohoSeries.includes(cfg.series(name));
      // the name says it ("A95 5G" is an A Series phone, whatever one stray part carries)
      const named = byName(optionFromCompatibleModel(cfg, name).model);
      if (named) return wanted.has(named.toLowerCase());
      // else the series most of its parts carry — a tie ("S Series; Note Series" parts only) lists it under each
      const most = Math.max(0, ...o.series.values());
      return most > 0 && [...o.series.entries()].some(([s, n]) => n === most && wanted.has(s.toLowerCase()));
    };
    const options = [...byKey.values()].filter((o) => inSeries(o, [...o.spellings.keys()][0])).map((o) => {
      const compatibleModel = [...o.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
      // the store category most of its parts are in (the dialog links the model there by default)
      const top = [...o.categories.values()].sort((a, b) => b.n - a.n)[0] || null;
      const category = top ? { id: top.id, name: top.name, parts: top.n } : null;
      return { compatibleModel, ...optionFromCompatibleModel(cfg, compatibleModel), items: o.items, have: o.have, category };
    });
    // newest first: by the model's number ("S26 Ultra" 26, "iPhone SE 3 (2022)" 3; none — "iPhone XS" — last), then by name
    const numberOf = (m) => { const x = String(m).replace(/\([^)]*\)/g, " ").match(/\d+(\.\d+)?/); return x ? Number(x[0]) : -1; };
    options.sort((a, b) => numberOf(b.model) - numberOf(a.model) || b.model.localeCompare(a.model, undefined, { numeric: true, sensitivity: "base" }));
    return res.json({ success: true, options });
  } catch (error) {
    next(error);
  }
});

// ── PUT /new-products/models/:id ─────────────────────────────────────
router.put("/models/:id", CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "invalid id");
    const db = await connectToDatabase();
    const existing = await db.collection(MODELS).findOne({ _id });
    if (!existing) return res.status(404).json({ success: false, message: "Model not found" });
    const b = req.body || {};
    const set = { updatedAt: new Date(), updatedBy: actor(req) };
    if (b.active !== undefined) set.active = !!b.active;
    if (["model", "series", "codes", "aliases", "note", "compatibleModel"].some((k) => b[k] !== undefined)) {
      const { doc, error } = modelFromBody(b, existing);
      if (error) return bad(res, error);
      Object.assign(set, doc);
    }
    // link the model to a store category ("" unlinks it)
    if (b.categoryId !== undefined) {
      const c = await categoryLink(b.categoryId);
      if (c.error) return res.status(c.status).json({ success: false, message: c.error });
      Object.assign(set, c.link);
    }
    await db.collection(MODELS).updateOne({ _id }, { $set: set });
    return res.json({ success: true, model: { _id: String(_id), ...set } });
  } catch (error) {
    next(error);
  }
});

// ── the next free parts SKU (utils/zohoNewItem nextFreeSku) ──────────

router.get("/next-sku", SKU, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    await refreshToken();
    return res.json({ success: true, sku: await nextFreeSku(db) });
  } catch (error) {
    next(error);
  }
});

// The store categories (Zoho Commerce — the same tree Inventory files items
// under), for the create dialog's Category picker. The Categories page's
// minute cache.
router.get("/categories", CREATE, async (req, res) => {
  try {
    const categories = await loadCategories(req.query.refresh === "1");
    return res.json({ success: true, categories });
  } catch (e) {
    console.error("New Products categories error:", e.message);
    return res.status(502).json({ success: false, message: "Could not read the categories from Zoho Commerce" });
  }
});

// A model's store category (user ask 2026-10-16: linked, not matched by
// name) — every item created for the model is filed there. The name and the
// path are kept with the link so the page shows them without asking Zoho.
// { link } ({ categoryId, categoryName, categoryPath }; all null = unlinked)
// or { error, status }.
async function categoryLink(id) {
  const categoryId = str(id);
  if (!categoryId) return { link: { categoryId: null, categoryName: null, categoryPath: null } };
  if (!/^\d{1,30}$/.test(categoryId)) return { error: "Bad category", status: 400 };
  const { category, error, status } = await findCategory(categoryId);
  if (error) return { error, status };
  const byId = new Map((await loadCategories()).map((c) => [c.id, c]));
  const names = [];
  for (let c = category, n = 0; c && n < 12; c = byId.get(c.parentId), n++) names.unshift(c.name);
  return { link: { categoryId: category.id, categoryName: category.name, categoryPath: names.join(" › ") } };
}

// ── POST /new-products/items ─────────────────────────────────────────
// Create one Zoho Inventory item for a model + part. Body: { modelId, part,
// cost, name?, sku?, quality?, rate?, prices?, compatibleModels? } — the
// defaults are what the page shows. The cost price (the dialog prices the
// four lists from it, required) goes to Zoho as the purchase rate, and the
// item is filed under the store category the model is linked to (2026-10-16:
// a model without a link creates nothing until it is linked). Sent as
// multipart/form-data it may carry photos under "images" (compatibleModels
// then as a JSON array string).
router.post("/items", CREATE, acceptPhotos, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (typeof b.compatibleModels === "string" && b.compatibleModels.trim().startsWith("[")) {
      try { b.compatibleModels = JSON.parse(b.compatibleModels); } catch (e) { return bad(res, "Bad compatible models"); }
    }
    const files = req.files || [];
    const _id = oid(b.modelId);
    if (!_id) return bad(res, "invalid model id");
    const db = await connectToDatabase();
    const model = await db.collection(MODELS).findOne({ _id });
    if (!model) return res.status(404).json({ success: false, message: "Model not found" });
    const cfg = BRANDS[model.brand];
    if (!cfg) return bad(res, "Unknown part type for this brand");
    const { part, error: partError } = partFor(cfg, b);
    if (partError) return bad(res, partError);
    // submitted from a draft: its saved photos go with the item
    let draft = null;
    if (b.draftId) {
      const did = oid(b.draftId);
      draft = did ? await db.collection(DRAFTS).findOne({ _id: did, status: "draft" }) : null;
      if (!draft) return res.status(404).json({ success: false, message: "This draft was already submitted or deleted" });
      if (String(draft.modelId) !== String(_id)) return bad(res, "The draft belongs to another model");
    }
    const name = (str(b.name) || part.name(model)).replace(/[\r\n]+/g, " ");
    if (name.length < 5) return bad(res, "Item name is too short");
    if (part.key === OTHER && name.toLowerCase() === cfg.namePrefix(model).toLowerCase()) return bad(res, "Type what the product is after the model");
    const { quality, error: qualityError } = cleanQuality(b.quality);
    if (qualityError) return bad(res, qualityError);
    const rate = b.rate === undefined || b.rate === null || b.rate === "" ? PLACEHOLDER_RATE : Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0) return bad(res, "Selling price must be 0 or more");
    // the price lists given (blank = left unset), checked before creating
    const { rates: listRates, error: priceError } = parsePriceLists(b.prices);
    if (priceError) return bad(res, priceError);
    const { cost, error: costError } = readCost(b.cost);
    if (costError) return bad(res, costError);
    if (cost === null) return bad(res, "Enter the cost price");
    // the store category is the model's own link (2026-10-16), never picked per item
    const categoryId = str(model.categoryId);
    if (!categoryId) return bad(res, `Link ${model.model} to a store category first`);
    const { category, error: categoryError, status: categoryStatus } = await findCategory(categoryId);
    if (categoryError) {
      return res.status(categoryStatus).json({ success: false, message: categoryStatus === 400 ? `The store category linked to ${model.model} no longer exists — link it again` : categoryError });
    }
    // every model the part fits — the brand's models from the page, this
    // one by default; written to Zoho as one "; "-separated value, the way
    // the register reads it back
    const compatibleModels = [...new Set(list(b.compatibleModels !== undefined ? b.compatibleModels : b.compatibleModel))];
    if (!compatibleModels.length) compatibleModels.push(model.compatibleModel || cfg.compatibleModel(model));
    const compatibleModel = compatibleModels.join("; ");

    await refreshToken();
    let sku = str(b.sku);
    if (sku) {
      if (!/^\d{4,6}$/.test(sku)) return bad(res, "SKU must be a number");
      if (await skuTaken(sku)) return bad(res, `SKU ${sku} is already used in Zoho`);
    } else {
      sku = await nextFreeSku(db);
    }

    const z = await createZohoItem({
      name, sku, rate, quality,
      purchaseRate: cost,
      categoryId: category.id,
      classification: part.classification,
      subClassification: part.subClassification,
      deviceBrand: cfg.deviceBrand,
      deviceSeries: await deviceSeriesFor(db, model, compatibleModels),
      compatibleModel,
    });
    if (z.error) return res.status(502).json({ success: false, message: `Zoho: ${z.error}` });
    // the category: set on the item itself when the create call didn't keep it
    const filed = { id: category.id, name: category.name };
    if (String(z.item.category_id || "") !== category.id) {
      const c = await setItemCategory(String(z.item.item_id), category.id);
      if (c.error) filed.error = c.error;
    }
    // the photos go onto the new item; a failure there leaves the item made
    const fromDraft = draft ? await readImagesFromUrls(draft.images || []) : { files: [], errors: [] };
    const allFiles = [...fromDraft.files, ...files];
    const photos = allFiles.length ? await uploadItemPhotos(String(z.item.item_id), allFiles) : null;
    if (fromDraft.errors.length) {
      const note = `${fromDraft.errors.length} saved photo(s) could not be read`;
      if (photos) photos.error = photos.error ? `${photos.error}; ${note}` : note;
    }
    // then its price lists
    const prices = Object.keys(listRates).length ? await setPriceLists(String(z.item.item_id), listRates) : null;
    const created = {
      part: part.key,
      classification: part.classification,
      subClassification: part.subClassification || "",
      itemId: String(z.item.item_id),
      imageId: (photos && photos.imageId) || null,
      prices: prices ? prices.set : {},
      sku: String(z.item.sku || sku),
      name: z.item.name || name,
      quality,
      rate,
      cost,
      categoryId: filed.error ? null : filed.id,
      categoryName: filed.error ? null : filed.name,
      compatibleModel,
      compatibleModels,
      at: new Date(),
      by: actor(req),
    };
    // the item counts for this model and for every other model it was
    // given — the register will file it under each when it refreshes
    const keys = compatibleModels.map(modelKey);
    const others = await db.collection(MODELS).find({ brand: model.brand, _id: { $ne: _id } }, { projection: { compatibleModel: 1, model: 1, aliases: 1 } }).toArray();
    const alsoIds = others.filter((o) => [o.compatibleModel, o.model, ...(o.aliases || [])].map(modelKey).some((k) => k && keys.includes(k))).map((o) => o._id);
    await db.collection(MODELS).updateMany({ _id: { $in: [_id, ...alsoIds] } }, { $push: { created }, $set: { updatedAt: new Date() } });
    if (draft) {
      await db.collection(DRAFTS).updateOne(
        { _id: draft._id },
        { $set: { status: "submitted", submittedAt: new Date(), submittedBy: actor(req), itemId: created.itemId, submittedSku: created.sku } },
      );
    }
    return res.json({ success: true, item: created, countedFor: 1 + alsoIds.length, photos, prices, category: filed, draftId: draft ? String(draft._id) : null });
  } catch (error) {
    next(error);
  }
});

// ── Drafts ───────────────────────────────────────────────────────────
// The create dialog kept for later. Loosely checked (a draft may be
// unfinished) — the real checks run when it is submitted.
const DRAFTS = "imb_spp_new_product_drafts";
const jsonField = (v, fallback) => {
  if (typeof v !== "string") return v === undefined ? fallback : v;
  if (!v.trim()) return fallback;
  try { return JSON.parse(v); } catch (e) { return Symbol.for("bad"); }
};

function draftFields(b, cfg) {
  // any other product may be kept before its classification is picked
  const other = str(b.part) === OTHER;
  const { part, error: partError } = other && !str(b.classification) ? { part: { key: OTHER, classification: "", subClassification: "" } } : partFor(cfg, b);
  if (partError) return { error: partError };
  const name = str(b.name).replace(/[\r\n]+/g, " ").slice(0, 200);
  const sku = str(b.sku);
  if (sku && !/^\d{4,6}$/.test(sku)) return { error: "SKU must be a number" };
  const { quality, error: qualityError } = cleanQuality(b.quality);
  if (qualityError) return { error: qualityError };
  const rate = b.rate === undefined || b.rate === null || b.rate === "" ? null : Number(b.rate);
  if (rate !== null && (!Number.isFinite(rate) || rate < 0)) return { error: "Selling price must be 0 or more" };
  const askedPrices = jsonField(b.prices, {});
  if (askedPrices === Symbol.for("bad") || typeof askedPrices !== "object" || Array.isArray(askedPrices)) return { error: "Bad price lists" };
  const prices = {};
  for (const [k, v] of Object.entries(askedPrices || {})) {
    if (!PRICE_LISTS[k]) return { error: `Unknown price list "${k}"` };
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) return { error: `${PRICE_LISTS[k].label}: the price must be 0 or more` };
    prices[k] = Math.round(n * 100) / 100;
  }
  const { cost, error: costError } = readCost(b.cost);
  if (costError) return { error: costError };
  const models = jsonField(b.compatibleModels, []);
  if (models === Symbol.for("bad")) return { error: "Bad compatible models" };
  const fields = { part: part.key, name, sku, quality, rate, cost, prices, compatibleModels: [...new Set(list(models))] };
  if (other) Object.assign(fields, { classification: part.classification, subClassification: part.subClassification || "" });
  return { fields };
}

function draftBrief(d) {
  return {
    _id: String(d._id), modelId: String(d.modelId), brand: d.brand, part: d.part, name: d.name || "", sku: d.sku || "",
    classification: d.classification || "", subClassification: d.subClassification || "",
    imageCount: (d.images || []).length, thumb: ((d.images || [])[0] || {}).url || null,
    updatedAt: d.updatedAt, updatedBy: d.updatedBy || d.createdBy || null,
  };
}
function draftFull(d) {
  return {
    ...draftBrief(d),
    quality: d.quality || "", rate: d.rate, cost: d.cost == null ? null : d.cost,
    prices: d.prices || {}, compatibleModels: d.compatibleModels || [],
    images: (d.images || []).map((im) => ({ id: im.id, url: im.url, name: im.name || "", width: im.width || null, height: im.height || null })),
    createdAt: d.createdAt, createdBy: d.createdBy || null,
  };
}


async function draftModel(db, modelId) {
  const _id = oid(modelId);
  const model = _id ? await db.collection(MODELS).findOne({ _id }) : null;
  return model && BRANDS[model.brand] ? model : null;
}

router.post("/drafts", CREATE, acceptPhotos, async (req, res, next) => {
  try {
    const b = req.body || {};
    const db = await connectToDatabase();
    const model = await draftModel(db, b.modelId);
    if (!model) return res.status(404).json({ success: false, message: "Model not found" });
    const { fields, error } = draftFields(b, BRANDS[model.brand]);
    if (error) return bad(res, error);
    const _id = new ObjectId();
    const images = [];
    for (const file of req.files || []) images.push(await storeImage(file, `np-draft-${_id}`));
    const now = new Date();
    const doc = { _id, modelId: model._id, brand: model.brand, ...fields, images, status: "draft", createdAt: now, createdBy: actor(req), updatedAt: now, updatedBy: actor(req) };
    await db.collection(DRAFTS).insertOne(doc);
    return res.json({ success: true, draft: draftFull(doc) });
  } catch (error) {
    if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
});

router.get("/drafts/:id", CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const db = await connectToDatabase();
    const d = _id ? await db.collection(DRAFTS).findOne({ _id, status: "draft" }) : null;
    if (!d) return res.status(404).json({ success: false, message: "Draft not found" });
    return res.json({ success: true, draft: draftFull(d) });
  } catch (error) {
    next(error);
  }
});

// Change a draft. `order` (JSON) is the photo list as the dialog has it:
// [{ id }] for a photo already saved, [{ new: n }] for the n-th file sent
// now. A saved photo left out is removed (from S3 too).
router.put("/drafts/:id", CREATE, acceptPhotos, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const db = await connectToDatabase();
    const d = _id ? await db.collection(DRAFTS).findOne({ _id, status: "draft" }) : null;
    if (!d) return res.status(404).json({ success: false, message: "This draft was already submitted or deleted" });
    const b = req.body || {};
    const model = await draftModel(db, d.modelId);
    if (!model) return res.status(404).json({ success: false, message: "Model not found" });
    const { fields, error } = draftFields(b, BRANDS[model.brand]);
    if (error) return bad(res, error);

    const files = req.files || [];
    const old = d.images || [];
    let order = jsonField(b.order, null);
    if (order === Symbol.for("bad")) return bad(res, "Bad photo order");
    if (!Array.isArray(order)) order = [...old.map((im) => ({ id: im.id })), ...files.map((x, i) => ({ new: i }))];
    if (order.length > MAX_IMAGES) return bad(res, `Up to ${MAX_IMAGES} photos`);
    const images = [];
    const used = new Set();
    for (const o of order) {
      if (o && o.id) {
        const im = old.find((x) => x.id === o.id);
        if (im && !images.includes(im)) images.push(im);
      } else if (o && Number.isInteger(o.new) && files[o.new] && !used.has(o.new)) {
        used.add(o.new);
        images.push(await storeImage(files[o.new], `np-draft-${_id}`));
      }
    }
    for (const im of old) if (!images.includes(im)) await removeImage(im.key);

    const now = new Date();
    const set = { ...fields, images, updatedAt: now, updatedBy: actor(req) };
    await db.collection(DRAFTS).updateOne({ _id }, { $set: set });
    return res.json({ success: true, draft: draftFull({ ...d, ...set }) });
  } catch (error) {
    if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
});

// Delete = marked deleted (kept, photos too); gone from the page.
router.delete("/drafts/:id", CREATE, async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const db = await connectToDatabase();
    const r = _id ? await db.collection(DRAFTS).updateOne({ _id, status: "draft" }, { $set: { status: "deleted", deletedAt: new Date(), deletedBy: actor(req) } }) : { matchedCount: 0 };
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Draft not found" });
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.BRANDS = BRANDS;
module.exports.modelKey = modelKey;
