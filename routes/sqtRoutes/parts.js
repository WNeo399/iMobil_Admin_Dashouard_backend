var express = require("express");
// mergeParams so we can read :modelId from the parent router
var router = express.Router({ mergeParams: true });
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_parts_prices";
const MODELS_COLLECTION = "sqt_models";

async function resolveModel(db, modelId) {
  if (!ObjectId.isValid(modelId)) return null;
  return db.collection(MODELS_COLLECTION).findOne({ _id: new ObjectId(modelId) });
}

function buildPartDoc(body, { model, isUpdate = false } = {}) {
  const doc = {};

  if (model) {
    doc.modelId = model._id;
    doc.modelName = model.name;
  }

  if (body.partName !== undefined) doc.partName = String(body.partName).trim();

  // genuine: true = original/OEM part, false = aftermarket/compatible
  if (body.genuine !== undefined) doc.genuine = !!body.genuine;

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
    const { partName, price } = req.body;

    if (!partName) {
      return res.status(400).json({ success: false, message: "partName is required" });
    }
    if (price === undefined || price === null || price === "") {
      return res.status(400).json({ success: false, message: "price is required" });
    }

    const db = await connectToDatabase();
    const model = await resolveModel(db, modelId);
    if (!model) {
      return res.status(404).json({ success: false, message: "Model not found" });
    }

    const doc = buildPartDoc(req.body, { model, isUpdate: false });
    if (doc.active === undefined) doc.active = true;
    if (doc.genuine === undefined) doc.genuine = false;

    // Enforce uniqueness on (modelId, partName, genuine) — a part can exist as
    // both a genuine and an aftermarket entry, but not duplicated within each.
    const dup = await db.collection(COLLECTION).findOne({
      modelId: model._id,
      partName: doc.partName,
      genuine: doc.genuine,
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: `A ${doc.genuine ? "genuine" : "non-genuine"} "${doc.partName}" already exists for this model`,
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

    const update = buildPartDoc(req.body, { isUpdate: true });

    // Uniqueness re-check if partName or genuine changed
    const effectiveName = update.partName !== undefined ? update.partName : existing.partName;
    const effectiveGenuine =
      update.genuine !== undefined ? update.genuine : !!existing.genuine;

    const dup = await collection.findOne({
      _id: { $ne: new ObjectId(partId) },
      modelId: new ObjectId(modelId),
      partName: effectiveName,
      genuine: effectiveGenuine,
    });
    if (dup) {
      return res.status(409).json({
        success: false,
        message: `Another ${effectiveGenuine ? "genuine" : "non-genuine"} "${effectiveName}" already exists`,
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
