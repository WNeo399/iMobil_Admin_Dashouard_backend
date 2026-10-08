// Creating a new spare-part item in Zoho Inventory — shared by Spare Parts
// Purchase → New Products and the Purchase Order page's New Product lines
// (2026-10-08). Moved out of routes/sparePartsPurchaseRoutes/newProducts.js
// unchanged: the item is set up like the team's own stock parts, the next
// free 22xxx SKU is checked in Zoho, photos go up after the item (the first
// becomes its main image), then the four price lists (merge call — only this
// item is touched).

const multer = require("multer");
const FormData = require("form-data");
const axios = require("axios");
const {
  handleZohoInventoryRequest,
  handleZohoInventoryPostRequest,
  handleZohoInventoryMultipartPostRequest,
  handleZohoInventoryPutRequest,
} = require("./zohoRequest");
const { fetchItemDetails } = require("./zohoStock");
const { imageIdOf } = require("./productImage");

const ORG = "746138234";
const ZOHO = "https://www.zohoapis.com/inventory/v1";

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

// The four price lists from a request (an object, or its JSON in a
// multipart form): blank ones are left out. { rates } or { error }.
function parsePriceLists(asked) {
  let v = asked || {};
  if (typeof v === "string") {
    try { v = JSON.parse(v || "{}"); } catch (e) { return { error: "Bad price lists" }; }
  }
  if (typeof v !== "object" || Array.isArray(v)) return { error: "Bad price lists" };
  const rates = {};
  for (const [list, x] of Object.entries(v)) {
    if (!PRICE_LISTS[list]) return { error: `Unknown price list "${list}"` };
    if (x === null || x === undefined || x === "") continue;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) return { error: `${PRICE_LISTS[list].label}: the price must be 0 or more` };
    rates[list] = Math.round(n * 100) / 100;
  }
  return { rates };
}

// The Quality values to offer: every one live items use, most used first
// (the register mirrors Zoho's Quality field — plain text; user 2026-10-08,
// after the Quality clean-up). A new one may be typed in the dialogs.
async function qualityOptions(db) {
  const rows = await db.collection("imb_stock_items").aggregate([
    { $match: { active: { $ne: false }, quality: { $nin: [null, ""] } } },
    { $group: { _id: "$quality", n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
  ]).toArray();
  return rows.map((r) => r._id);
}
// A quality as given (picked or typed): short text, no [ ] — it goes into
// the name as a [tag]. { quality } or { error }.
function cleanQuality(v) {
  const q = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  if (!q) return { quality: "" };
  if (q.length > 60) return { error: "Quality is too long (60 characters at most)" };
  if (/[[\]]/.test(q)) return { error: "Quality can't contain [ or ]" };
  return { quality: q };
}

// Is this SKU already on an item in Zoho?
async function skuTaken(sku) {
  const r = await handleZohoInventoryRequest(`${ZOHO}/items?organization_id=${ORG}&sku=${encodeURIComponent(sku)}`);
  return ((r && r.items) || []).some((it) => String(it.sku).trim() === String(sku));
}

// The next free parts SKU: the highest 22xxx in the register (and in the
// New Products page's own `created` records — the register lags Zoho by a
// day) + 1, each candidate checked in Zoho.
async function nextFreeSku(db) {
  const inRegister = await db.collection("imb_stock_items").find({ sku: /^22\d{3}$/ }, { projection: { _id: 0, sku: 1 } }).toArray();
  const inCreated = await db.collection("imb_spp_new_products").aggregate([{ $unwind: "$created" }, { $project: { _id: 0, sku: "$created.sku" } }]).toArray();
  let n = Math.max(SKU_MIN - 1, ...[...inRegister, ...inCreated].map((x) => Number(x.sku)).filter((x) => Number.isFinite(x) && x >= SKU_MIN && x <= SKU_MAX));
  for (let tries = 0; tries < 20; tries++) {
    n += 1;
    if (n > SKU_MAX) throw new Error("The 22xxx parts SKU range is used up");
    if (!(await skuTaken(n))) return String(n);
  }
  throw new Error("Could not find a free SKU");
}

// Create the item in Zoho. Custom fields go only when set. Returns
// { item } (Zoho's item) or { error } (Zoho's message).
async function createZohoItem({ name, sku, rate, quality, classification, subClassification, deviceBrand, deviceSeries, compatibleModel }) {
  const customFields = [];
  const cf = (api_name, value) => { if (value) customFields.push({ api_name, value }); };
  cf("cf_tags", classification);
  cf("cf_sub_classification", subClassification);
  cf("cf_device_brand", deviceBrand);
  cf("cf_device_series", deviceSeries);
  cf("cf_compatible_model", compatibleModel);
  cf("cf_quality", quality);
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
    return { error: (z && (z.message || (z.error && z.error.message))) || "Zoho did not create the item" };
  }
  return { item: z.item };
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

// Photos stored in S3 (public URLs — a draft's, a purchase line's), read back
// as upload files (re-encoded JPEGs). { files, errors: [ids] }.
async function readImagesFromUrls(images) {
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

module.exports = {
  ORG,
  ZOHO,
  PLACEHOLDER_RATE,
  PRICE_LISTS,
  qualityOptions,
  cleanQuality,
  MAX_IMAGES,
  acceptPhotos,
  parsePriceLists,
  skuTaken,
  nextFreeSku,
  createZohoItem,
  setPriceLists,
  uploadItemPhotos,
  readImagesFromUrls,
};
