var express = require("express");
// mergeParams so we can read :modelId from the parent router
var router = express.Router({ mergeParams: true });
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_parts_prices";
const MODELS_COLLECTION = "sqt_models";
const QUALITIES_COLLECTION = "sqt_qualities";

async function resolveModel(db, modelId) {
  if (!ObjectId.isValid(modelId)) return null;
  return db.collection(MODELS_COLLECTION).findOne({ _id: new ObjectId(modelId) });
}

async function resolveQuality(db, qualityId) {
  if (!ObjectId.isValid(qualityId)) return null;
  return db.collection(QUALITIES_COLLECTION).findOne({ _id: new ObjectId(qualityId) });
}

function buildPartDoc(body, { model, quality, isUpdate = false } = {}) {
  const doc = {};

  if (model) {
    doc.modelId = model._id;
    doc.modelName = model.name;
  }
  if (quality) {
    doc.qualityId = quality._id;
    doc.qualityName = quality.name;
  }

  if (body.partName !== undefined) doc.partName = String(body.partName).trim();

  if (body.identifiers !== undefined) {
    doc.identifiers = {
      partNumber: body.identifiers.partNumber || null,
      sku: body.identifiers.sku ? String(body.identifiers.sku) : null,
      zohoName: body.identifiers.zohoName || null,
    };
  }

  if (body.price !== undefined) {
    const p = Number(body.price);
    doc.price = Number.isFinite(p) ? p : 0;
  }

  if (body.active !== undefined) doc.active = !!body.active;
  if (body.importedFrom !== undefined) doc.importedFrom = body.importedFrom || null;

  const now = new Date();
  if (!isUpdate) doc.createdAt = now;
  doc.updatedAt = now;

  return doc;
}

router.get("/", async function (req, res, next) {
  try {
    const { modelId } = req.params;
    if (!ObjectId.isValid(modelId)) {
      return res.status(400).json({ success: false, message: "Invalid model id" });
    }

    const db = await connectToDatabase();
    const data = await db
      .collection(COLLECTION)
      .find({ modelId: new ObjectId(modelId) })
      .sort({ partName: 1, price: 1 })
      .toArray();

    return res.json({ success: true, data });
  } catch (error) {
    console.error("List parts error:", error);
    return res.status(500).json({ success: false, message: "Failed to list parts" });
  }
});

router.post("/", async function (req, res, next) {
  try {
    const { modelId } = req.params;
    const { qualityId, partName, price } = req.body;

    if (!partName) {
      return res.status(400).json({ success: false, message: "partName is required" });
    }
    if (price === undefined || price === null || price === "") {
      return res.status(400).json({ success: false, message: "price is required" });
    }
    if (!qualityId) {
      return res.status(400).json({ success: false, message: "qualityId is required" });
    }

    const db = await connectToDatabase();
    const model = await resolveModel(db, modelId);
    if (!model) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }
    const quality = await resolveQuality(db, qualityId);
    if (!quality) {
      return res.status(404).json({ success: false, message: "Quality not found" });
    }

    const doc = buildPartDoc(req.body, { model, quality, isUpdate: false });
    if (doc.active === undefined) doc.active = true;

    // Enforce uniqueness on (modelId, partName, qualityId)
    const dup = await db.collection(COLLECTION).findOne({
      modelId: model._id,
      partName: doc.partName,
      qualityId: quality._id,
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: "A part with the same name and quality already exists for this model",
      });
    }

    const result = await db.collection(COLLECTION).insertOne(doc);
    return res.status(201).json({
      success: true,
      message: "Part created",
      data: { _id: result.insertedId, ...doc },
    });
  } catch (error) {
    console.error("Create part error:", error);
    return res.status(500).json({ success: false, message: "Failed to create part" });
  }
});

router.put("/:partId", async function (req, res, next) {
  try {
    const { modelId, partId } = req.params;
    if (!ObjectId.isValid(modelId) || !ObjectId.isValid(partId)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const existing = await collection.findOne({
      _id: new ObjectId(partId),
      modelId: new ObjectId(modelId),
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: "Part not found" });
    }

    // Allow changing quality on update
    let quality = null;
    if (req.body.qualityId && String(req.body.qualityId) !== String(existing.qualityId)) {
      quality = await resolveQuality(db, req.body.qualityId);
      if (!quality) {
        return res.status(404).json({ success: false, message: "Quality not found" });
      }
    }

    const update = buildPartDoc(req.body, { quality, isUpdate: true });

    // Uniqueness re-check if partName or qualityId changed
    const effectiveName = update.partName !== undefined ? update.partName : existing.partName;
    const effectiveQualityId = quality ? quality._id : existing.qualityId;

    const dup = await collection.findOne({
      _id: { $ne: new ObjectId(partId) },
      modelId: new ObjectId(modelId),
      partName: effectiveName,
      qualityId: effectiveQualityId,
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: "Another part with the same name and quality already exists",
      });
    }

    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(partId) },
      { $set: update },
      { returnDocument: "after" },
    );

    const updated = result.value || result;
    return res.json({ success: true, message: "Part updated", data: updated });
  } catch (error) {
    console.error("Update part error:", error);
    return res.status(500).json({ success: false, message: "Failed to update part" });
  }
});

router.delete("/:partId", async function (req, res, next) {
  try {
    const { modelId, partId } = req.params;
    if (!ObjectId.isValid(modelId) || !ObjectId.isValid(partId)) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).deleteOne({
      _id: new ObjectId(partId),
      modelId: new ObjectId(modelId),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Part not found" });
    }

    return res.json({ success: true, message: "Part deleted" });
  } catch (error) {
    console.error("Delete part error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete part" });
  }
});

module.exports = router;
