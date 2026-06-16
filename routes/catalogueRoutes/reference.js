// Catalogue reference-data CRUD: brands, categories, models, qualities.
//
// These four collections drive the dropdowns on the Products page and
// scope qualities to categories. Category is a FIXED set (see schema
// §2) so it's read-only here — list only, no create/update/delete.
//
// Renames cascade: brand/category/quality/model display names are
// denormalized onto imb_products, so renaming one fires an updateMany
// to refresh the copies (schema §6). _id (the slug / business key) is
// immutable once created — renaming changes `name`, never `_id`.

var express = require("express");
var router = express.Router();
const { requireAnyPermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const { brandSlug, modelSlug, qualitySlug } = require("../../utils/catalogueSlug");

const BRAND = "imb_products_brand";
const CATEGORY = "imb_products_category";
const MODEL = "imb_products_model";
const QUALITY = "imb_products_quality";
const PRODUCTS = "imb_products";

// Reuse the collection permissions — iMobile Admin already holds these
// and the catalogue is conceptually the same "manage iMobile product
// data" surface as the existing Collections page.
const VIEW = requireAnyPermission("zoho:collection:view", "zoho:collection:edit");
const EDIT = requireAnyPermission("zoho:collection:edit");

// ── Brands ──────────────────────────────────────────────────────────
router.get("/brands", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const data = await db.collection(BRAND).find({}).sort({ name: 1 }).toArray();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("List brands error:", e);
    return res.status(500).json({ success: false, message: "Failed to list brands" });
  }
});

router.post("/brands", EDIT, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "name is required" });
    const _id = brandSlug(name);
    if (!_id) return res.status(400).json({ success: false, message: "name produced an empty slug" });
    const db = await connectToDatabase();
    try {
      await db.collection(BRAND).insertOne({ _id, name });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: `Brand "${_id}" already exists` });
      }
      throw err;
    }
    return res.json({ success: true, data: { _id, name } });
  } catch (e) {
    console.error("Create brand error:", e);
    return res.status(500).json({ success: false, message: "Failed to create brand" });
  }
});

router.put("/brands/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "name is required" });
    const db = await connectToDatabase();
    const result = await db.collection(BRAND).updateOne({ _id: id }, { $set: { name } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }
    // Cascade the rename to denormalized copies on products.
    await db.collection(PRODUCTS).updateMany(
      { "brand.id": id },
      { $set: { "brand.name": name } },
    );
    return res.json({ success: true, data: { _id: id, name } });
  } catch (e) {
    console.error("Update brand error:", e);
    return res.status(500).json({ success: false, message: "Failed to update brand" });
  }
});

router.delete("/brands/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectToDatabase();
    // Block deletion while products or models still reference the brand —
    // orphaning denormalized rows would be worse than a clear error.
    const modelCount = await db.collection(MODEL).countDocuments({ brand_id: id });
    const productCount = await db.collection(PRODUCTS).countDocuments({ "brand.id": id });
    if (modelCount > 0 || productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${modelCount} model(s) and ${productCount} product(s) still use this brand.`,
      });
    }
    const result = await db.collection(BRAND).deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Brand not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("Delete brand error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete brand" });
  }
});

// ── Categories (read-only — fixed set) ──────────────────────────────
router.get("/categories", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const data = await db.collection(CATEGORY).find({}).sort({ name: 1 }).toArray();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("List categories error:", e);
    return res.status(500).json({ success: false, message: "Failed to list categories" });
  }
});

// ── Models ──────────────────────────────────────────────────────────
// Optional ?brand_id filter for the brand-scoped dropdown.
router.get("/models", VIEW, async (req, res) => {
  try {
    const filter = {};
    if (req.query.brand_id) filter.brand_id = String(req.query.brand_id);
    const db = await connectToDatabase();
    const data = await db.collection(MODEL).find(filter).sort({ name: 1 }).toArray();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("List models error:", e);
    return res.status(500).json({ success: false, message: "Failed to list models" });
  }
});

router.post("/models", EDIT, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    const brand_id = String((req.body && req.body.brand_id) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "name is required" });
    if (!brand_id) return res.status(400).json({ success: false, message: "brand_id is required" });
    const db = await connectToDatabase();
    // Referential check — the brand must exist.
    const brand = await db.collection(BRAND).findOne({ _id: brand_id });
    if (!brand) return res.status(400).json({ success: false, message: `Unknown brand "${brand_id}"` });
    const _id = modelSlug(name);
    if (!_id) return res.status(400).json({ success: false, message: "name produced an empty slug" });
    const doc = { _id, brand_id, name };
    try {
      await db.collection(MODEL).insertOne(doc);
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: `Model "${_id}" already exists` });
      }
      throw err;
    }
    return res.json({ success: true, data: doc });
  } catch (e) {
    console.error("Create model error:", e);
    return res.status(500).json({ success: false, message: "Failed to create model" });
  }
});

router.put("/models/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const update = {};
    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const name = String(body.name || "").trim();
      if (!name) return res.status(400).json({ success: false, message: "name cannot be empty" });
      update.name = name;
    }
    if (Object.prototype.hasOwnProperty.call(body, "brand_id")) {
      update.brand_id = String(body.brand_id || "").trim();
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update" });
    }
    const db = await connectToDatabase();
    if (update.brand_id) {
      const brand = await db.collection(BRAND).findOne({ _id: update.brand_id });
      if (!brand) return res.status(400).json({ success: false, message: `Unknown brand "${update.brand_id}"` });
    }
    const result = await db.collection(MODEL).updateOne({ _id: id }, { $set: update });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }
    // Cascade name rename to the compatible_models array on products.
    // Positional $[elem] filtered update touches only the matching
    // array entries.
    if (update.name) {
      await db.collection(PRODUCTS).updateMany(
        { "compatible_models.id": id },
        { $set: { "compatible_models.$[elem].name": update.name } },
        { arrayFilters: [{ "elem.id": id }] },
      );
    }
    const data = await db.collection(MODEL).findOne({ _id: id });
    return res.json({ success: true, data });
  } catch (e) {
    console.error("Update model error:", e);
    return res.status(500).json({ success: false, message: "Failed to update model" });
  }
});

router.delete("/models/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectToDatabase();
    const productCount = await db.collection(PRODUCTS).countDocuments({ "compatible_models.id": id });
    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${productCount} product(s) list this model as compatible.`,
      });
    }
    const result = await db.collection(MODEL).deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("Delete model error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete model" });
  }
});

// ── Qualities ───────────────────────────────────────────────────────
// Optional ?category_id filter for the category-scoped dropdown.
router.get("/qualities", VIEW, async (req, res) => {
  try {
    const filter = {};
    if (req.query.category_id) filter.category_id = String(req.query.category_id);
    const db = await connectToDatabase();
    const data = await db.collection(QUALITY).find(filter).sort({ name: 1 }).toArray();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("List qualities error:", e);
    return res.status(500).json({ success: false, message: "Failed to list qualities" });
  }
});

router.post("/qualities", EDIT, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    const category_id = String((req.body && req.body.category_id) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "name is required" });
    if (!category_id) return res.status(400).json({ success: false, message: "category_id is required" });
    const db = await connectToDatabase();
    const category = await db.collection(CATEGORY).findOne({ _id: category_id });
    if (!category) return res.status(400).json({ success: false, message: `Unknown category "${category_id}"` });
    const _id = qualitySlug(category_id, name);
    const doc = { _id, category_id, name };
    try {
      await db.collection(QUALITY).insertOne(doc);
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: `Quality "${_id}" already exists` });
      }
      throw err;
    }
    return res.json({ success: true, data: doc });
  } catch (e) {
    console.error("Create quality error:", e);
    return res.status(500).json({ success: false, message: "Failed to create quality" });
  }
});

router.put("/qualities/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "name is required" });
    const db = await connectToDatabase();
    const result = await db.collection(QUALITY).updateOne({ _id: id }, { $set: { name } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Quality not found" });
    }
    // Cascade rename to the denormalized quality.name on products.
    await db.collection(PRODUCTS).updateMany(
      { "quality.id": id },
      { $set: { "quality.name": name } },
    );
    const data = await db.collection(QUALITY).findOne({ _id: id });
    return res.json({ success: true, data });
  } catch (e) {
    console.error("Update quality error:", e);
    return res.status(500).json({ success: false, message: "Failed to update quality" });
  }
});

router.delete("/qualities/:id", EDIT, async (req, res) => {
  try {
    const { id } = req.params;
    const db = await connectToDatabase();
    const productCount = await db.collection(PRODUCTS).countDocuments({ "quality.id": id });
    if (productCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Can't delete — ${productCount} product(s) use this quality.`,
      });
    }
    const result = await db.collection(QUALITY).deleteOne({ _id: id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Quality not found" });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error("Delete quality error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete quality" });
  }
});

module.exports = router;
