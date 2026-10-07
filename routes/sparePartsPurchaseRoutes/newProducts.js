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
//   POST /new-products/models               add a model
//   PUT  /new-products/models/:id           edit a model (or hide it: active false)
//   GET  /new-products/next-sku             the next free parts SKU (22xxx) — asks Zoho
//   POST /new-products/items                create one Zoho item for a model + part (+ photos, price lists; or from a draft)
//   POST /new-products/drafts               save the create dialog as a draft (not in Zoho)
//   GET  /new-products/drafts/:id           one draft
//   PUT  /new-products/drafts/:id           change a draft (fields, photos and their order)
//   DELETE /new-products/drafts/:id         delete a draft (marked deleted, kept in the DB)
//
// Permissions: spp:product:view / spp:product:create — inside spp:*:*, so
// Admin, iMobile Admin, iMobile Purchase and iMobile Warehouse have them;
// the parts supplier (an explicit list) does not.

const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const multer = require("multer");
const FormData = require("form-data");
const { handleZohoInventoryRequest, handleZohoInventoryPostRequest, handleZohoInventoryMultipartPostRequest, handleZohoInventoryPutRequest, refreshToken } = require("../../utils/zohoRequest");
const { fetchItemDetails } = require("../../utils/zohoStock");
const { imageIdOf, imageUrlFromId } = require("../../utils/productImage");
const axios = require("axios");
const { storeImage, removeImage } = require("../../utils/sppImages");

const MODELS = "imb_spp_new_products";
const ITEMS = "imb_stock_items";
const ORG = "746138234";
const ZOHO = "https://www.zohoapis.com/inventory/v1";

const VIEW = requirePermission("spp:product:view");
const CREATE = requirePermission("spp:product:create");

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
  },
};
// The Device Series for a set of Compatible Models ("; "-joined, like the
// other brands' items); "" when the brand has no series rule.
function seriesFor(cfg, models) {
  if (!cfg || !cfg.series) return "";
  return [...new Set((models || []).map(cfg.series).filter(Boolean))].join("; ");
}
function withCodes(m) {
  const short = BRANDS[m.brand].short(m);
  const codes = (m.codes || []).filter(Boolean);
  return codes.length ? `${short} (${codes.join(" / ")})` : short;
}

// Zoho item setup copied from the team's own stock parts (items 21808 /
// 13136): an inventory item in qty, Sales / COGS / Inventory Asset, and a
// placeholder selling price (9999.99 — one of the values Price Monitoring
// reads as "price still to be set").
const SALES_ACCOUNT = "2591985000000000388";
const PURCHASE_ACCOUNT = "2591985000000034003";
const INVENTORY_ACCOUNT = "2591985000000034001";
const PLACEHOLDER_RATE = 9999.99;
// The four price lists (Zoho price books — the same ids as Price Monitoring,
// routes/stockMonitorRoutes PRICE_LISTS).
const PRICE_LISTS = {
  platinum: { id: "2591985000001439015", label: "Platinum" },
  vip: { id: "2591985000000103001", label: "VIP" },
  svip: { id: "2591985000078196985", label: "SVIP" },
  wholesale: { id: "2591985000000103011", label: "Wholesale" },
};
const QUALITIES = ["", "Aftermarket", "Original", "Service Pack", "IMB", "Original IMB+", "JK", "Refurbished", "Secondhand", "Original Secondhand", "iVolta", "Original AAA"];
// The parts SKU sequence (accessories are 25xxx).
const SKU_MIN = 22000;
const SKU_MAX = 22999;

// Photos for a new item — Zoho's limits (gif / png / jpeg / bmp / webp,
// 7 MB each) and 10 at a time, as on the Missing Images upload.
const IMAGE_MIME = /^image\/(gif|png|jpe?g|bmp|webp)$/i;
const MAX_IMAGES = 10;
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024, files: MAX_IMAGES },
  fileFilter: (req, file, cb) =>
    IMAGE_MIME.test(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error(`${file.originalname}: only gif, png, jpeg, bmp or webp images`), { badType: true })),
}).array("images", MAX_IMAGES);
function acceptPhotos(req, res, next) {
  photoUpload(req, res, (err) => {
    if (!err) return next();
    const message = err.badType ? err.message
      : err.code === "LIMIT_FILE_SIZE" ? "Each photo must be 7 MB or smaller"
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Up to ${MAX_IMAGES} photos`
          : "Could not read the photos";
    return res.status(400).json({ success: false, message });
  });
}

// Write a new item's price-list rates — one merge call per list (only this
// item is touched). Returns { set: { list: rate }, errors: { list: message } }.
async function setPriceLists(itemId, rates) {
  const out = { set: {}, errors: {} };
  for (const [list, rate] of Object.entries(rates)) {
    try {
      const r = await handleZohoInventoryPutRequest(
        `${ZOHO}/pricebooks/${PRICE_LISTS[list].id}/items?organization_id=${ORG}`,
        [{ item_id: itemId, pricebook_rate: rate }],
      );
      if (r && r.code === 0) out.set[list] = rate;
      else out.errors[list] = (r && r.message) || "Zoho did not take the price";
    } catch (e) {
      out.errors[list] = (e && e.message) || "Zoho did not take the price";
    }
  }
  return out;
}

// Upload photos to a new Zoho item (the first becomes its main image) and
// read back the main image id. Errors come back as a message, not a throw.
async function uploadItemPhotos(itemId, files) {
  try {
    const url = `${ZOHO}/items/${encodeURIComponent(itemId)}/images?organization_id=${ORG}&update_primary_image=true`;
    const buildForm = () => {
      const form = new FormData();
      for (const f of files) form.append("image", f.buffer, { filename: f.originalname || "image.jpg", contentType: f.mimetype });
      return form;
    };
    const r = await handleZohoInventoryMultipartPostRequest(url, buildForm);
    if (!r || r.code !== 0) return { uploaded: 0, error: (r && r.message) || "Zoho did not accept the photos" };
    const [detail] = await fetchItemDetails([itemId]).catch(() => []);
    return { uploaded: files.length, imageId: imageIdOf(detail) };
  } catch (e) {
    return { uploaded: 0, error: (e && e.message) || "Could not upload the photos" };
  }
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
    .replace(/\b(motorola|moto|5g|4g|us)\b/g, " ")
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
    for (const c of model.created || []) if (c.part === p.key) seen.set(String(c.itemId), { itemId: c.itemId, sku: c.sku, name: c.name, quality: c.quality || "", createdHere: true });
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
    for (const brand of brandList) {
      const models = await db.collection(MODELS).find({ brand, active: { $ne: false } }).sort({ seriesOrder: 1, series: 1, sortKey: 1, model: 1 }).toArray();
      const index = await registerIndex(db, brand);
      const cfg = BRANDS[brand];
      for (const m of models) {
        const have = coverage(m, index);
        const missing = cfg.parts.filter((p) => !(have[p.key] || []).length).map((p) => p.key);
        // the create dialog's default item name per part (no Zoho call — the
        // dialog opens straight away; only the SKU is fetched separately)
        const defaultNames = Object.fromEntries(cfg.parts.map((p) => [p.key, p.name(m)]));
        rows.push({ ...m, _id: String(m._id), have, missing, defaultNames, deviceSeries: seriesFor(cfg, [m.compatibleModel || cfg.compatibleModel(m)]) });
      }
    }
    return res.json({
      success: true,
      brand: brandList.length === 1 ? brandList[0] : "",
      brands: Object.keys(BRANDS).map((b) => ({
        value: b,
        label: BRANDS[b].label,
        deviceBrand: BRANDS[b].deviceBrand,
        parts: BRANDS[b].parts.map((p) => ({ key: p.key, label: p.label, classification: p.classification, subClassification: p.subClassification })),
      })),
      qualities: QUALITIES,
      placeholderRate: PLACEHOLDER_RATE,
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
      const part = cfg.parts.find((p) => p.key === c.part);
      seen.set(String(c.itemId), {
        itemId: c.itemId, sku: c.sku, name: c.name, quality: c.quality || "",
        classification: part ? part.classification : "", subClassification: part ? part.subClassification : "",
        archived: false, scope: "parts", available: null, imageUrl: imageUrlFromId(c.imageId),
        compatibleModels: c.compatibleModels || [c.compatibleModel].filter(Boolean),
        part: c.part, createdHere: true,
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
  const model = str(b.model !== undefined ? b.model : existing && existing.model);
  if (!model) return { error: "Model is required" };
  const doc = {
    brand,
    series: str(b.series !== undefined ? b.series : existing && existing.series),
    model,
    codes: b.codes !== undefined ? list(b.codes) : (existing && existing.codes) || [],
    aliases: b.aliases !== undefined ? list(b.aliases) : (existing && existing.aliases) || [],
    note: str(b.note !== undefined ? b.note : existing && existing.note),
  };
  doc.compatibleModel = str(b.compatibleModel !== undefined ? b.compatibleModel : existing && existing.compatibleModel) || BRANDS[brand].compatibleModel(doc);
  return { doc };
}

// ── POST /new-products/models ────────────────────────────────────────
router.post("/models", CREATE, async (req, res, next) => {
  try {
    const { doc, error } = modelFromBody(req.body || {});
    if (error) return bad(res, error);
    const db = await connectToDatabase();
    const dup = await db.collection(MODELS).findOne({ brand: doc.brand, active: { $ne: false }, model: new RegExp(`^${doc.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (dup) return bad(res, `${doc.brand} ${doc.model} is already listed`);
    const now = new Date();
    const full = { ...doc, source: "added on the page", active: true, created: [], createdAt: now, createdBy: actor(req), updatedAt: now };
    const r = await db.collection(MODELS).insertOne(full);
    return res.json({ success: true, model: { ...full, _id: String(r.insertedId) } });
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
    await db.collection(MODELS).updateOne({ _id }, { $set: set });
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── the next free parts SKU ──────────────────────────────────────────
// The highest 22xxx SKU in the register + 1, and Zoho asked whether it is
// free (the register lags Zoho by a day). Items created from this page are
// in `created`, so they count too.
async function nextFreeSku(db) {
  const inRegister = await db.collection(ITEMS).find({ sku: /^22\d{3}$/ }, { projection: { _id: 0, sku: 1 } }).toArray();
  const inCreated = await db.collection(MODELS).aggregate([{ $unwind: "$created" }, { $project: { _id: 0, sku: "$created.sku" } }]).toArray();
  let n = Math.max(SKU_MIN - 1, ...[...inRegister, ...inCreated].map((x) => Number(x.sku)).filter((x) => Number.isFinite(x) && x >= SKU_MIN && x <= SKU_MAX));
  for (let tries = 0; tries < 20; tries++) {
    n += 1;
    if (n > SKU_MAX) throw new Error("The 22xxx parts SKU range is used up");
    const r = await handleZohoInventoryRequest(`${ZOHO}/items?organization_id=${ORG}&sku=${n}`);
    const taken = ((r && r.items) || []).some((it) => String(it.sku).trim() === String(n));
    if (!taken) return String(n);
  }
  throw new Error("Could not find a free SKU");
}

router.get("/next-sku", CREATE, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    await refreshToken();
    return res.json({ success: true, sku: await nextFreeSku(db) });
  } catch (error) {
    next(error);
  }
});

// ── POST /new-products/items ─────────────────────────────────────────
// Create one Zoho Inventory item for a model + part. Body: { modelId, part,
// name?, sku?, quality?, rate?, compatibleModels? } — the defaults are what
// the page shows. Sent as multipart/form-data it may carry photos under
// "images" (compatibleModels then as a JSON array string).
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
    const part = cfg && cfg.parts.find((p) => p.key === str(b.part));
    if (!part) return bad(res, "Unknown part type for this brand");
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
    const quality = str(b.quality);
    if (quality && !QUALITIES.includes(quality)) return bad(res, "Unknown quality");
    const rate = b.rate === undefined || b.rate === null || b.rate === "" ? PLACEHOLDER_RATE : Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0) return bad(res, "Selling price must be 0 or more");
    // the price lists given (blank = left unset), checked before creating
    let askedPrices = b.prices || {};
    if (typeof askedPrices === "string") {
      try { askedPrices = JSON.parse(askedPrices || "{}"); } catch (e) { return bad(res, "Bad price lists"); }
    }
    const listRates = {};
    for (const [list, v] of Object.entries(askedPrices || {})) {
      if (!PRICE_LISTS[list]) return bad(res, `Unknown price list "${list}"`);
      if (v === null || v === undefined || v === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1000000) return bad(res, `${PRICE_LISTS[list].label}: the price must be 0 or more`);
      listRates[list] = Math.round(n * 100) / 100;
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
      const r = await handleZohoInventoryRequest(`${ZOHO}/items?organization_id=${ORG}&sku=${encodeURIComponent(sku)}`);
      if (((r && r.items) || []).some((it) => String(it.sku).trim() === sku)) return bad(res, `SKU ${sku} is already used in Zoho`);
    } else {
      sku = await nextFreeSku(db);
    }

    const customFields = [
      { api_name: "cf_tags", value: part.classification },
      { api_name: "cf_device_brand", value: cfg.deviceBrand },
      { api_name: "cf_compatible_model", value: compatibleModel },
    ];
    if (part.subClassification) customFields.push({ api_name: "cf_sub_classification", value: part.subClassification });
    const deviceSeries = seriesFor(cfg, compatibleModels);
    if (deviceSeries) customFields.push({ api_name: "cf_device_series", value: deviceSeries });
    if (quality) customFields.push({ api_name: "cf_quality", value: quality });
    const body = {
      name,
      sku,
      unit: "qty",
      item_type: "inventory",
      product_type: "goods",
      rate,
      purchase_rate: 0,
      account_id: SALES_ACCOUNT,
      purchase_account_id: PURCHASE_ACCOUNT,
      inventory_account_id: INVENTORY_ACCOUNT,
      custom_fields: customFields,
    };
    const z = await handleZohoInventoryPostRequest(`${ZOHO}/items?organization_id=${ORG}`, body);
    if (!z || z.code !== 0 || !z.item) {
      const msg = (z && (z.message || (z.error && z.error.message))) || "Zoho did not create the item";
      return res.status(502).json({ success: false, message: `Zoho: ${msg}` });
    }
    // the photos go onto the new item; a failure there leaves the item made
    const fromDraft = draft ? await readDraftImages(draft.images || []) : { files: [], errors: [] };
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
      itemId: String(z.item.item_id),
      imageId: (photos && photos.imageId) || null,
      prices: prices ? prices.set : {},
      sku: String(z.item.sku || sku),
      name: z.item.name || name,
      quality,
      rate,
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
    return res.json({ success: true, item: created, countedFor: 1 + alsoIds.length, photos, prices, draftId: draft ? String(draft._id) : null });
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
  const part = cfg.parts.find((p) => p.key === str(b.part));
  if (!part) return { error: "Unknown part type for this brand" };
  const name = str(b.name).replace(/[\r\n]+/g, " ").slice(0, 200);
  const sku = str(b.sku);
  if (sku && !/^\d{4,6}$/.test(sku)) return { error: "SKU must be a number" };
  const quality = str(b.quality);
  if (quality && !QUALITIES.includes(quality)) return { error: "Unknown quality" };
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
  const models = jsonField(b.compatibleModels, []);
  if (models === Symbol.for("bad")) return { error: "Bad compatible models" };
  return { fields: { part: part.key, name, sku, quality, rate, prices, compatibleModels: [...new Set(list(models))] } };
}

function draftBrief(d) {
  return {
    _id: String(d._id), modelId: String(d.modelId), brand: d.brand, part: d.part, name: d.name || "", sku: d.sku || "",
    imageCount: (d.images || []).length, thumb: ((d.images || [])[0] || {}).url || null,
    updatedAt: d.updatedAt, updatedBy: d.updatedBy || d.createdBy || null,
  };
}
function draftFull(d) {
  return {
    ...draftBrief(d),
    quality: d.quality || "", rate: d.rate, prices: d.prices || {}, compatibleModels: d.compatibleModels || [],
    images: (d.images || []).map((im) => ({ id: im.id, url: im.url, name: im.name || "", width: im.width || null, height: im.height || null })),
    createdAt: d.createdAt, createdBy: d.createdBy || null,
  };
}

// The draft's photos, read back from S3 for the Zoho upload (re-encoded JPEGs).
async function readDraftImages(images) {
  const out = { files: [], errors: [] };
  for (const im of images) {
    try {
      const r = await axios.get(im.url, { responseType: "arraybuffer", timeout: 30000 });
      out.files.push({ buffer: Buffer.from(r.data), originalname: im.name || `${im.id}.jpg`, mimetype: "image/jpeg" });
    } catch (e) {
      out.errors.push(im.id);
    }
  }
  return out;
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
