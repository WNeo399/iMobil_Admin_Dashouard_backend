var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_shops";

const VALID_STATUSES = ["active", "inactive", "pending"];

function buildShopDoc(body, { isUpdate = false } = {}) {
  const doc = {};

  if (body.slug !== undefined) doc.slug = String(body.slug).trim().toLowerCase();
  if (body.storeName !== undefined) doc.storeName = String(body.storeName).trim();
  if (body.googleMapsLink !== undefined) doc.googleMapsLink = body.googleMapsLink || null;
  if (body.notes !== undefined) doc.notes = body.notes || null;

  if (body.status !== undefined) {
    const s = String(body.status).toLowerCase();
    doc.status = VALID_STATUSES.includes(s) ? s : "pending";
  }

  if (body.externalIds !== undefined) {
    doc.externalIds = {
      zohoId: body.externalIds.zohoId ? String(body.externalIds.zohoId) : null,
      repairDeskId:
        body.externalIds.repairDeskId !== null &&
        body.externalIds.repairDeskId !== undefined &&
        body.externalIds.repairDeskId !== ""
          ? Number(body.externalIds.repairDeskId)
          : null,
    };
  }

  if (body.address !== undefined) {
    doc.address = {
      raw: body.address.raw || null,
      street: body.address.street || null,
      suburb: body.address.suburb || null,
      state: body.address.state || null,
      postcode: body.address.postcode ? String(body.address.postcode) : null,
      country: body.address.country || "Australia",
    };
  }

  if (body.emails !== undefined) {
    doc.emails = Array.isArray(body.emails)
      ? body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [];
  }

  if (body.phones !== undefined) {
    doc.phones = Array.isArray(body.phones)
      ? body.phones
          .filter((p) => p && p.number)
          .map((p) => ({
            name: p.name ? String(p.name).trim() : null,
            number: String(p.number).trim(),
          }))
      : [];
  }

  const now = new Date();
  if (!isUpdate) doc.createdAt = now;
  doc.updatedAt = now;

  return doc;
}

router.get("/list", async function (req, res, next) {
  try {
    const { status, search, state } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const query = {};

    if (status) {
      const statusArray =
        typeof status === "string" ? status.split(",") : Array.isArray(status) ? status : [status];
      query.status = { $in: statusArray };
    }

    if (state) {
      query["address.state"] = state;
    }

    if (search) {
      const re = { $regex: String(search), $options: "i" };
      query.$or = [
        { storeName: re },
        { slug: re },
        { "address.raw": re },
        { emails: re },
      ];
    }

    const totalDocs = await collection.countDocuments(query);
    const data = await collection
      .find(query)
      .sort({ storeName: 1 })
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
    console.error("List shops error:", error);
    return res.status(500).json({ success: false, message: "Failed to list shops" });
  }
});

router.get("/detail/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid shop id" });
    }

    const db = await connectToDatabase();
    const data = await db.collection(COLLECTION).findOne({ _id: new ObjectId(id) });

    if (!data) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Get shop detail error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch shop" });
  }
});

router.post("/create", async function (req, res, next) {
  try {
    if (!req.body.storeName) {
      return res.status(400).json({ success: false, message: "storeName is required" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const doc = buildShopDoc(req.body, { isUpdate: false });

    // Slug uniqueness check (slug is optional but if present must be unique)
    if (doc.slug) {
      const existing = await collection.findOne({ slug: doc.slug });
      if (existing) {
        return res.status(409).json({ success: false, message: "Slug already in use" });
      }
    }

    const result = await collection.insertOne(doc);
    return res.status(201).json({
      success: true,
      message: "Shop created",
      data: { _id: result.insertedId, ...doc },
    });
  } catch (error) {
    console.error("Create shop error:", error);
    return res.status(500).json({ success: false, message: "Failed to create shop" });
  }
});

router.put("/update/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid shop id" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const update = buildShopDoc(req.body, { isUpdate: true });

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

    const updated = result.value || result; // driver compatibility
    if (!updated) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }

    return res.json({ success: true, message: "Shop updated", data: updated });
  } catch (error) {
    console.error("Update shop error:", error);
    return res.status(500).json({ success: false, message: "Failed to update shop" });
  }
});

router.post("/delete", async function (req, res, next) {
  try {
    const { id } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid shop id" });
    }

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Shop not found" });
    }

    return res.json({ success: true, message: "Shop deleted" });
  } catch (error) {
    console.error("Delete shop error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete shop" });
  }
});

module.exports = router;
