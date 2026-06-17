// Main catalogue CRUD: imb_products (one doc per sellable SKU).
//
// The client sends ids only (brandId, categoryId, qualityId, modelIds);
// the backend resolves the display names from the reference collections
// and stores the denormalized { id, name } objects. Doing the
// denormalization server-side keeps it authoritative — the names can't
// drift from what the reference docs actually say, and the id-existence
// checks double as the §6 integrity rules.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requireAnyPermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const PRODUCTS = "imb_products";
const BRAND = "imb_products_brand";
const CATEGORY = "imb_products_category";
const MODEL = "imb_products_model";
const QUALITY = "imb_products_quality";

const VIEW = requireAnyPermission("zoho:collection:view", "zoho:collection:edit");
const EDIT = requireAnyPermission("zoho:collection:edit");

// ── GET /catalogue/products ─────────────────────────────────────────
// Paginated + filterable. Filters: brand, category, quality, model
// (all by id), plus a free-text search across sku + productName.
router.get("/products", VIEW, async (req, res) => {
  try {
    const { brand, category, quality, model, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    // Each filter accepts a single id OR a comma-separated list (the
    // Products page sends multiple ids from the multi-select cascaders).
    // One value → equality; many → $in.
    const multi = (v) =>
      String(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const eqOrIn = (v) => {
      const list = multi(v);
      return list.length > 1 ? { $in: list } : list[0];
    };

    const filter = {};
    if (brand) filter["brand.id"] = eqOrIn(brand);
    if (category) filter["category.id"] = eqOrIn(category);
    if (quality) filter["quality.id"] = eqOrIn(quality);
    if (model) filter["compatible_models.id"] = eqOrIn(model);
    if (search) {
      const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { sku: { $regex: safe, $options: "i" } },
        { productName: { $regex: safe, $options: "i" } },
      ];
    }

    const db = await connectToDatabase();
    const collection = db.collection(PRODUCTS);
    const [data, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ productName: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return res.json({ success: true, data, total, page, pageSize });
  } catch (e) {
    console.error("List products error:", e);
    return res.status(500).json({ success: false, message: "Failed to list products" });
  }
});

router.get("/products/:id", VIEW, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const db = await connectToDatabase();
    const data = await db.collection(PRODUCTS).findOne({ _id: new ObjectId(id) });
    if (!data) return res.status(404).json({ success: false, message: "Product not found" });
    return res.json({ success: true, data });
  } catch (e) {
    console.error("Get product error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch product" });
  }
});

// Resolve + validate the id payload into the denormalized doc shape.
// Returns { doc } on success or { error } (a user-facing string) on
// any integrity failure. Shared by create + update.
async function buildProductDoc(db, body) {
  const sku = String((body && body.sku) || "").trim();
  const productName = String((body && body.productName) || "").trim();
  const brandId = String((body && body.brandId) || "").trim();
  const categoryId = String((body && body.categoryId) || "").trim();
  const qualityId = String((body && body.qualityId) || "").trim();
  const modelIds = Array.isArray(body && body.modelIds)
    ? body.modelIds.map((m) => String(m).trim()).filter(Boolean)
    : [];
  const colorRaw = body && body.color != null ? String(body.color).trim() : "";

  if (!sku) return { error: "sku is required" };
  if (!productName) return { error: "productName is required" };
  if (!brandId) return { error: "brand is required" };
  if (!categoryId) return { error: "category is required" };
  if (!qualityId) return { error: "quality is required" };
  if (modelIds.length === 0) return { error: "at least one compatible model is required" };

  // §6 integrity: quality id must be scoped to its category.
  if (!qualityId.startsWith(categoryId + "-")) {
    return { error: `Quality "${qualityId}" is not scoped to category "${categoryId}".` };
  }

  const [brand, category, quality, models] = await Promise.all([
    db.collection(BRAND).findOne({ _id: brandId }),
    db.collection(CATEGORY).findOne({ _id: categoryId }),
    db.collection(QUALITY).findOne({ _id: qualityId }),
    db.collection(MODEL).find({ _id: { $in: modelIds } }).toArray(),
  ]);

  if (!brand) return { error: `Unknown brand "${brandId}"` };
  if (!category) return { error: `Unknown category "${categoryId}"` };
  if (!quality) return { error: `Unknown quality "${qualityId}"` };
  // Cross-check the quality actually belongs to the chosen category.
  if (quality.category_id !== categoryId) {
    return { error: `Quality "${qualityId}" belongs to category "${quality.category_id}", not "${categoryId}".` };
  }
  // Every requested model must exist.
  const foundIds = new Set(models.map((m) => m._id));
  const missing = modelIds.filter((m) => !foundIds.has(m));
  if (missing.length > 0) {
    return { error: `Unknown model(s): ${missing.join(", ")}` };
  }

  const doc = {
    sku,
    productName,
    brand: { id: brand._id, name: brand.name },
    category: { id: category._id, name: category.name },
    quality: { id: quality._id, name: quality.name },
    // Preserve the order the user picked, mapping each to its current
    // display name.
    compatible_models: modelIds.map((mid) => {
      const m = models.find((x) => x._id === mid);
      return { id: m._id, name: m.name };
    }),
  };
  // color is omitted entirely when blank (schema §: "omit for
  // colourless parts") rather than stored as "".
  if (colorRaw) doc.color = colorRaw;
  return { doc };
}

router.post("/products", EDIT, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { doc, error } = await buildProductDoc(db, req.body || {});
    if (error) return res.status(400).json({ success: false, message: error });
    try {
      const result = await db.collection(PRODUCTS).insertOne(doc);
      return res.json({ success: true, data: { _id: result.insertedId, ...doc } });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: `SKU "${doc.sku}" already exists` });
      }
      throw err;
    }
  } catch (e) {
    console.error("Create product error:", e);
    return res.status(500).json({ success: false, message: "Failed to create product" });
  }
});

router.put("/products/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const db = await connectToDatabase();
    const { doc, error } = await buildProductDoc(db, req.body || {});
    if (error) return res.status(400).json({ success: false, message: error });
    // When color was cleared, $unset it so the field is genuinely
    // absent rather than an empty string (keeps the colourless-part
    // convention intact).
    const update = { $set: doc };
    if (!Object.prototype.hasOwnProperty.call(doc, "color")) {
      update.$unset = { color: "" };
    }
    try {
      const result = await db.collection(PRODUCTS).updateOne({ _id: new ObjectId(id) }, update);
      if (result.matchedCount === 0) {
        return res.status(404).json({ success: false, message: "Product not found" });
      }
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: `SKU "${doc.sku}" already exists` });
      }
      throw err;
    }
    const data = await db.collection(PRODUCTS).findOne({ _id: new ObjectId(id) });
    return res.json({ success: true, data });
  } catch (e) {
    console.error("Update product error:", e);
    return res.status(500).json({ success: false, message: "Failed to update product" });
  }
});

router.delete("/products/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const db = await connectToDatabase();
    const result = await db.collection(PRODUCTS).deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("Delete product error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete product" });
  }
});

module.exports = router;
