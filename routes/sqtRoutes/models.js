var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_models";
const PARTS_COLLECTION = "sqt_parts_prices";

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildModelDoc(body, { isUpdate = false } = {}) {
  const doc = {};

  if (body.name !== undefined) doc.name = String(body.name).trim();
  if (body.code !== undefined) doc.code = body.code ? String(body.code).trim() : null;
  if (body.brandName !== undefined) doc.brandName = String(body.brandName).trim();
  if (body.brandId !== undefined) {
    doc.brandId = body.brandId ? slugify(body.brandId) : slugify(body.brandName || "");
  } else if (body.brandName !== undefined) {
    doc.brandId = slugify(body.brandName);
  }
  if (body.slug !== undefined) {
    doc.slug = body.slug ? slugify(body.slug) : slugify(body.name || "");
  } else if (!isUpdate && body.name) {
    doc.slug = slugify(body.name);
  }
  if (body.active !== undefined) doc.active = !!body.active;

  const now = new Date();
  if (!isUpdate) doc.createdAt = now;
  doc.updatedAt = now;

  return doc;
}

router.get("/list", async function (req, res, next) {
  try {
    const { brandId, active, search } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const query = {};

    if (brandId) query.brandId = brandId;

    if (active !== undefined && active !== "") {
      query.active = active === "true" || active === true;
    }

    if (search) {
      const re = { $regex: String(search), $options: "i" };
      query.$or = [{ name: re }, { slug: re }, { code: re }, { brandName: re }];
    }

    const totalDocs = await collection.countDocuments(query);
    const data = await collection
      .find(query)
      .sort({ brandName: 1, name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    return res.json({
      success: true,
      totalDocs,
      page,
      pageSize,
      totalPages: Math.ceil(totalDocs / pageSize),
      data,
    });
  } catch (error) {
    console.error("List models error:", error);
    return res.status(500).json({ success: false, message: "Failed to list models" });
  }
});

// Distinct brands for dropdowns
router.get("/brands", async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const brands = await db
      .collection(COLLECTION)
      .aggregate([
        { $group: { _id: "$brandId", brandName: { $first: "$brandName" } } },
        { $project: { _id: 0, brandId: "$_id", brandName: 1 } },
        { $sort: { brandName: 1 } },
      ])
      .toArray();

    return res.json({ success: true, data: brands });
  } catch (error) {
    console.error("List brands error:", error);
    return res.status(500).json({ success: false, message: "Failed to list brands" });
  }
});

router.get("/detail/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid model id" });
    }

    const db = await connectToDatabase();
    const data = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });

    if (!data) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Get model detail error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch model" });
  }
});

router.post("/create", async function (req, res, next) {
  try {
    if (!req.body.name || !req.body.brandName) {
      return res
        .status(400)
        .json({ success: false, message: "name and brandName are required" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const doc = buildModelDoc(req.body, { isUpdate: false });
    if (doc.active === undefined) doc.active = true;

    if (doc.slug) {
      const existing = await collection.findOne({ slug: doc.slug });
      if (existing) {
        return res.status(409).json({ success: false, message: "Slug already in use" });
      }
    }

    const result = await collection.insertOne(doc);
    return res.status(201).json({
      success: true,
      message: "Model created",
      data: { _id: result.insertedId, ...doc },
    });
  } catch (error) {
    console.error("Create model error:", error);
    return res.status(500).json({ success: false, message: "Failed to create model" });
  }
});

router.put("/update/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid model id" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const update = buildModelDoc(req.body, { isUpdate: true });

    if (update.slug) {
      const conflict = await collection.findOne({
        slug: update.slug,
        _id: { $ne: new ObjectId(id) },
      });
      if (conflict) {
        return res.status(409).json({ success: false, message: "Slug already in use" });
      }
    }

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    if (!updated) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }

    // If model name changed, propagate to denormalized fields on parts
    if (update.name) {
      await db
        .collection(PARTS_COLLECTION)
        .updateMany(
          { modelId: new ObjectId(id) },
          { $set: { modelName: update.name, updatedAt: new Date() } },
        );
    }

    return res.json({ success: true, message: "Model updated", data: updated });
  } catch (error) {
    console.error("Update model error:", error);
    return res.status(500).json({ success: false, message: "Failed to update model" });
  }
});

router.post("/delete", async function (req, res, next) {
  try {
    const { id } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid model id" });
    }

    const db = await connectToDatabase();

    // Block delete if parts exist — caller must clear them first
    const partsCount = await db
      .collection(PARTS_COLLECTION)
      .countDocuments({ modelId: new ObjectId(id) });
    if (partsCount > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete: ${partsCount} part(s) still reference this model`,
      });
    }

    const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }

    return res.json({ success: true, message: "Model deleted" });
  } catch (error) {
    console.error("Delete model error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete model" });
  }
});

module.exports = router;
