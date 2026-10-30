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
const { storeProductOf, uploadProductImages } = require("./zohoCommerce");
const { ZOHO_CLASSIFICATIONS } = require("./listingQualities");

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
// A product with variants (Listing's Create, 2026-10-30) sends its own photos
// and each variant's in one request: up to 10 each, 40 in all — the route
// checks the 10s.
const MAX_REQUEST_IMAGES = 40;
const manyPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024, files: MAX_REQUEST_IMAGES },
  fileFilter: (req, file, cb) =>
    IMAGE_MIME.test(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error(`${file.originalname}: only gif, png, jpeg, bmp or webp images`), { badType: true })),
}).array("images", MAX_REQUEST_IMAGES);
const photoUploadHandler = (upload, max) => function (req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    const message = err.badType ? err.message
      : err.code === "LIMIT_FILE_SIZE" ? "Each photo must be 7 MB or smaller"
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Up to ${max} photos`
          : "Could not read the photos";
    return res.status(400).json({ success: false, message });
  });
};
const acceptPhotos = photoUploadHandler(photoUpload, MAX_IMAGES);
const acceptManyPhotos = photoUploadHandler(manyPhotoUpload, MAX_REQUEST_IMAGES);

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
    { $match: { active: { $ne: false }, scope: { $ne: "te" }, quality: { $nin: [null, ""] } } },
    { $group: { _id: "$quality", n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
  ]).toArray();
  return rows.map((r) => r._id);
}
// Zoho's classifications for parts, each with the sub classifications live
// items use (most used first), every one listed even when no part uses it
// yet — the register also holds stray values ("Phones", "-") and those are
// left out. [{ value, count, subs: [{ value, count }] }], most used first.
// Shared by "Create in Zoho" on the Purchase Order page and New Products.
async function classificationOptions(db) {
  const rows = await db.collection("imb_stock_items").aggregate([
    { $match: { active: { $ne: false }, scope: "parts", classification: { $in: ZOHO_CLASSIFICATIONS } } },
    { $group: { _id: { c: "$classification", s: { $ifNull: ["$subClassification", ""] } }, n: { $sum: 1 } } },
  ]).toArray();
  const byClass = new Map(ZOHO_CLASSIFICATIONS.map((c) => [c, { value: c, count: 0, subs: [] }]));
  for (const x of rows) {
    const c = byClass.get(x._id.c);
    if (!c) continue;
    c.count += x.n;
    if (x._id.s) c.subs.push({ value: x._id.s, count: x.n });
  }
  const out = [...byClass.values()].sort((a, b) => b.count - a.count);
  out.forEach((c) => c.subs.sort((a, b) => b.count - a.count));
  return out;
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

// The cost price as typed (2026-10-16; optional since 2026-10-20 — it goes to Zoho
// as the purchase rate): { cost } (null when blank) or { error }.
function readCost(v) {
  if (v === undefined || v === null || v === "") return { cost: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000000) return { error: "The cost price must be more than 0" };
  return { cost: Math.round(n * 100) / 100 };
}

// Is this SKU already on an item in Zoho?
async function skuTaken(sku) {
  const r = await handleZohoInventoryRequest(`${ZOHO}/items?organization_id=${ORG}&sku=${encodeURIComponent(sku)}`);
  return ((r && r.items) || []).some((it) => String(it.sku).trim() === String(sku));
}

// Is this number taken — as a SKU, or as the base of a product with variants
// ("22450-Black")? The plain SKU, then a search for the variant ones.
async function baseSkuTaken(base) {
  if (await skuTaken(base)) return true;
  const r = await handleZohoInventoryRequest(`${ZOHO}/items?organization_id=${ORG}&search_text=${encodeURIComponent(`${base}-`)}`);
  return ((r && r.items) || []).some((it) => String(it.sku).trim().startsWith(`${base}-`));
}

// The next free parts SKU: the highest 22xxx in the register (and in the
// New Products page's own `created` records — the register lags Zoho by a
// day) + 1, each candidate checked in Zoho. A variant's SKU (22450-Black)
// uses its number too.
async function nextFreeSku(db) {
  const inRegister = await db.collection("imb_stock_items").find({ sku: /^22\d{3}(-|$)/ }, { projection: { _id: 0, sku: 1 } }).toArray();
  const inCreated = await db.collection("imb_spp_new_products").aggregate([{ $unwind: "$created" }, { $project: { _id: 0, sku: "$created.sku" } }]).toArray();
  const numberOf = (sku) => { const m = /^(\d+)(-|$)/.exec(String(sku || "")); return m ? Number(m[1]) : NaN; };
  let n = Math.max(SKU_MIN - 1, ...[...inRegister, ...inCreated].map((x) => numberOf(x.sku)).filter((x) => Number.isFinite(x) && x >= SKU_MIN && x <= SKU_MAX));
  for (let tries = 0; tries < 20; tries++) {
    n += 1;
    if (n > SKU_MAX) throw new Error("The 22xxx parts SKU range is used up");
    if (!(await baseSkuTaken(n))) return String(n);
  }
  throw new Error("Could not find a free SKU");
}

// Create the item in Zoho. Custom fields go only when set; `purchaseRate`
// is the cost price (0 when not given) and `categoryId` files it under a
// store category (Inventory and Commerce share one tree — New Products,
// 2026-10-16). Returns { item } (Zoho's item) or { error } (Zoho's message).
async function createZohoItem({ name, sku, rate, purchaseRate, categoryId, quality, classification, subClassification, deviceBrand, deviceSeries, compatibleModel }) {
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
    purchase_rate: purchaseRate || 0,
    account_id: SALES_ACCOUNT,
    purchase_account_id: PURCHASE_ACCOUNT,
    inventory_account_id: INVENTORY_ACCOUNT,
    custom_fields: customFields,
  };
  if (categoryId) body.category_id = String(categoryId);
  const z = await handleZohoInventoryPostRequest(`${ZOHO}/items?organization_id=${ORG}`, body);
  if (!z || z.code !== 0 || !z.item) {
    return { error: (z && (z.message || (z.error && z.error.message))) || "Zoho did not create the item" };
  }
  return { item: z.item };
}

// A product with variants (Listing's Create, user 2026-10-30, after the TEST
// group 2591985000371483763): a Zoho item GROUP with one attribute — one
// item per variant, named "<name> [<variant>]", SKU "<base>-<variant>",
// which the store shows as ONE product with a picker (Commerce product_id =
// group_id). The attribute is "Option" — a variant can be anything (user
// 2026-10-30), and the store's older groups use that name too. Set up like
// createZohoItem's item. Zoho's group create drops the items' custom fields
// (seen on the test), so each item gets them in a PUT after.
// variants: [{ name, sku, rate }].
// → { groupId, groupName, items: [{ itemId, sku, name, variant, rate, categoryId }], fieldErrors: { sku: message } } or { error }.
async function createZohoGroup({ name, attribute = "Option", variants, purchaseRate, categoryId, quality, classification, subClassification, deviceBrand, deviceSeries, compatibleModel }) {
  const customFields = [];
  const cf = (api_name, value) => { if (value) customFields.push({ api_name, value }); };
  cf("cf_tags", classification);
  cf("cf_sub_classification", subClassification);
  cf("cf_device_brand", deviceBrand);
  cf("cf_device_series", deviceSeries);
  cf("cf_compatible_model", compatibleModel);
  cf("cf_quality", quality);
  const body = {
    group_name: name,
    unit: "qty",
    product_type: "goods",
    item_type: "inventory",
    attribute_name1: attribute,
    attributes: [{ name: attribute, options: variants.map((c) => ({ name: c.name })) }],
    items: variants.map((c) => ({
      name: `${name} [${c.name}]`,
      sku: c.sku,
      attribute_option_name1: c.name,
      rate: c.rate,
      purchase_rate: purchaseRate || 0,
      item_type: "inventory",
      account_id: SALES_ACCOUNT,
      purchase_account_id: PURCHASE_ACCOUNT,
      inventory_account_id: INVENTORY_ACCOUNT,
      custom_fields: customFields,
    })),
  };
  if (categoryId) body.category_id = String(categoryId);
  const z = await handleZohoInventoryPostRequest(`${ZOHO}/itemgroups?organization_id=${ORG}`, body);
  const g = z && (z.item_group || z);
  if (!z || z.code !== 0 || !g || !g.group_id) {
    return { error: (z && (z.message || (z.error && z.error.message))) || "Zoho did not create the product" };
  }
  const made = Array.isArray(g.items) ? g.items : g.items ? [g.items] : [];
  const items = variants.map((c) => {
    const it = made.find((x) => String(x.sku) === c.sku) || {};
    return { itemId: it.item_id ? String(it.item_id) : "", sku: c.sku, name: it.name || `${name} [${c.name}]`, variant: c.name, rate: c.rate, categoryId: String(it.category_id || g.category_id || "") };
  });
  const fieldErrors = {};
  if (customFields.length) {
    for (const it of items) {
      if (!it.itemId) { fieldErrors[it.sku] = "Zoho did not return this variant"; continue; }
      try {
        const r = await handleZohoInventoryPutRequest(`${ZOHO}/items/${encodeURIComponent(it.itemId)}?organization_id=${ORG}`, { custom_fields: customFields });
        if (!r || r.code !== 0) fieldErrors[it.sku] = (r && (r.message || (r.error && r.error.message))) || "Zoho did not save the fields";
      } catch (e) {
        fieldErrors[it.sku] = (e && e.message) || "Zoho did not save the fields";
      }
    }
  }
  return { groupId: String(g.group_id), groupName: g.group_name || name, items, fieldErrors };
}

// One more variant into a product that exists (Listing's Add variant, user
// 2026-10-30): POST /items with the group_id and the option — tested on
// VARTEST2, 2026-10-30, the item joins the group and the store product
// gains it. Set up like the item it is copied from (`from`: rate,
// purchase_rate, unit, accounts, category). The group create drops custom
// fields, so they are checked on the reply and PUT when missing.
// → { item, fieldsError? } or { error }.
async function addZohoGroupItem({ groupId, attribute, variant, name, sku, from, customFields }) {
  const body = {
    group_id: String(groupId),
    name,
    sku,
    unit: from.unit || "qty",
    item_type: "inventory",
    product_type: "goods",
    rate: from.rate,
    purchase_rate: from.purchase_rate || 0,
    attribute_name1: attribute,
    attribute_option_name1: variant,
    account_id: from.account_id || SALES_ACCOUNT,
    purchase_account_id: from.purchase_account_id || PURCHASE_ACCOUNT,
    inventory_account_id: from.inventory_account_id || INVENTORY_ACCOUNT,
    custom_fields: customFields,
  };
  if (from.category_id) body.category_id = String(from.category_id);
  const z = await handleZohoInventoryPostRequest(`${ZOHO}/items?organization_id=${ORG}`, body);
  if (!z || z.code !== 0 || !z.item) return { error: (z && (z.message || (z.error && z.error.message))) || "Zoho did not add the variant" };
  if (String(z.item.group_id || "") !== String(groupId)) return { error: "Zoho made the item outside the product", item: z.item };
  const kept = new Set((z.item.custom_fields || []).filter((c) => c.value).map((c) => c.api_name));
  let fieldsError;
  if (customFields.some((c) => !kept.has(c.api_name))) {
    try {
      const r = await handleZohoInventoryPutRequest(`${ZOHO}/items/${encodeURIComponent(z.item.item_id)}?organization_id=${ORG}`, { custom_fields: customFields });
      if (!r || r.code !== 0) fieldsError = (r && (r.message || (r.error && r.error.message))) || "Zoho did not save the fields";
    } catch (e) {
      fieldsError = (e && e.message) || "Zoho did not save the fields";
    }
  }
  return { item: z.item, fieldsError };
}

// File a new item under a store category when the create call didn't keep
// it — only ever the item just made. { categoryId, categoryName } or { error }.
async function setItemCategory(itemId, categoryId) {
  try {
    const r = await handleZohoInventoryPutRequest(`${ZOHO}/items/${encodeURIComponent(itemId)}?organization_id=${ORG}`, { category_id: String(categoryId) });
    if (r && r.code === 0 && r.item && String(r.item.category_id) === String(categoryId)) {
      return { categoryId: String(r.item.category_id), categoryName: r.item.category_name || "" };
    }
    return { error: (r && (r.message || (r.error && r.error.message))) || "Zoho did not keep the category" };
  } catch (e) {
    return { error: (e && e.message) || "Zoho did not keep the category" };
  }
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

// Upload photos to a Zoho item (the first becomes its main image — unless
// primary is false: photos added to an existing item keep its main one) and
// read back the main image id. Errors come back as a message, not a throw.
//
// Through the STORE when the item is a one-variant store product (user
// 2026-10-28, SKU 21847): Zoho Commerce files each photo as one document shared
// by the product, its variant and the Inventory item, so it is the product's
// image — what the storefront's listing and search pages show. Sent straight
// to the Inventory item (how every upload went before) a photo lands on the
// variant only: the product page shows it, the listings show "no image".
// Inventory stays the route for a multi-variant product, an item the store
// doesn't have, or a store that refuses.
// → { uploaded, imageId, zohoImageId, via: "store" | "inventory" } or { uploaded: 0, error }
//   imageId: the main image; zohoImageId: what Zoho's bulk record says (it can lag)
async function uploadItemPhotos(itemId, files, { primary = true, sku = "", inventoryOnly = false } = {}) {
  try {
    let via = "inventory";
    let product = null;
    // a variant of a product with variants: its photos are its own (the variant's)
    if (!inventoryOnly) {
      try {
        product = await storeProductOf(itemId, sku);
      } catch (e) {
        console.warn(`[photos] no store product for ${itemId}: ${e.message}`);
      }
    }
    if (product && product.variants === 1) {
      const r = await uploadProductImages(product.productId, files);
      if (r && r.code === 0) via = "store";
      else console.warn(`[photos] the store refused ${itemId}'s photos (${(r && r.message) || "no answer"}) — sending them to the Inventory item`);
    }
    if (via === "inventory") {
      const url = `${ZOHO}/items/${encodeURIComponent(itemId)}/images?organization_id=${ORG}&update_primary_image=${primary ? "true" : "false"}`;
      const buildForm = () => {
        const form = new FormData();
        for (const f of files) form.append("image", f.buffer, { filename: f.originalname || "image.jpg", contentType: f.mimetype });
        return form;
      };
      const r = await handleZohoInventoryMultipartPostRequest(url, buildForm);
      if (!r || r.code !== 0) return { uploaded: 0, error: (r && r.message) || "Zoho did not accept the photos" };
    }
    const [detail] = await fetchItemDetails([itemId]).catch(() => []);
    const zohoImageId = imageIdOf(detail);
    let imageId = zohoImageId;
    // the store route doesn't choose the item's main image: an item that had
    // none puts its photos in upload order (Zoho's item image follows the first)
    if (via === "store" && primary && !imageId) {
      const it = await handleZohoInventoryRequest(`${ZOHO}/items/${encodeURIComponent(itemId)}?organization_id=${ORG}`).catch(() => null);
      const docs = ((it && it.item && it.item.documents) || []).filter((d) => d && d.document_id)
        .sort((a, b) => (Number(a.attachment_order) || 0) - (Number(b.attachment_order) || 0));
      const rank = (d) => { const i = files.findIndex((f) => (f.originalname || "image.jpg") === d.file_name); return i < 0 ? files.length : i; };
      const ids = docs.slice().sort((a, b) => rank(a) - rank(b)).map((d) => String(d.document_id));
      if (ids.length) {
        await reorderItemPhotos(itemId, ids);
        imageId = ids[0];
      }
    }
    return { uploaded: files.length, imageId, zohoImageId, via };
  } catch (e) {
    return { uploaded: 0, error: (e && e.message) || "Could not upload the photos" };
  }
}

// Put an item's photos in this order (document ids, every one the item
// has). Zoho's item image follows the first (tested 2026-10-20 — the
// "image_name" moves at once). { ok } or { error }.
async function reorderItemPhotos(itemId, documentIds) {
  try {
    const r = await handleZohoInventoryPostRequest(
      `${ZOHO}/items/${encodeURIComponent(itemId)}/images/reorder?organization_id=${ORG}`,
      { documents: documentIds.map((document_id, i) => ({ document_id: String(document_id), order: i + 1 })) },
    );
    if (r && r.code === 0) return { ok: true };
    return { error: (r && (r.message || (r.error && r.error.message))) || "Zoho did not reorder the photos" };
  } catch (e) {
    return { error: (e && e.message) || "Zoho did not reorder the photos" };
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
  classificationOptions,
  cleanQuality,
  readCost,
  MAX_IMAGES,
  MAX_REQUEST_IMAGES,
  acceptPhotos,
  acceptManyPhotos,
  parsePriceLists,
  skuTaken,
  baseSkuTaken,
  nextFreeSku,
  createZohoItem,
  createZohoGroup,
  addZohoGroupItem,
  setItemCategory,
  setPriceLists,
  uploadItemPhotos,
  reorderItemPhotos,
  readImagesFromUrls,
};
