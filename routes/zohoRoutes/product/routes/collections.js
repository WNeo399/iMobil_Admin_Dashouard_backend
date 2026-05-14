var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../../../utils/mongodb");

router.post("/create", async function (req, res, next) {
  try {
    const { title, type, rules, children, note, status } = req.body;

    // basic validation
    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Title is required",
      });
    }

    const db = await connectToDatabase();

    const collection = db.collection("productCollections");

    const newCollection = {
      title,
      note,
      type: type || "Selection",
      status: status || "draft",
      rules: rules || [],
      children: children || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newCollection);

    return res.status(201).json({
      success: true,
      message: "Collection created successfully",
      data: {
        _id: result.insertedId,
        ...newCollection,
      },
    });
  } catch (error) {
    console.error("Create collection error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create collection",
      error: error.message,
    });
  }
});

router.put("/update/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    const { title, type, rules, children, status, note } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection id",
      });
    }

    const db = await connectToDatabase();

    const collection = db.collection("productCollections");

    const updateData = {
      updatedAt: new Date(),
    };

    // only update provided fields
    if (title !== undefined) updateData.title = title;
    if (note !== undefined) updateData.note = note;
    if (type !== undefined) updateData.type = type;
    if (rules !== undefined) updateData.rules = rules;
    if (children !== undefined) updateData.children = children;
    if (status !== undefined) updateData.children = status;
    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updateData,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Collection not found",
      });
    }

    const updatedCollection = await collection.findOne({
      _id: new ObjectId(id),
    });

    return res.status(200).json({
      success: true,
      message: "Collection updated successfully",
      data: updatedCollection,
    });
  } catch (error) {
    console.error("Update collection error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update collection",
      error: error.message,
    });
  }
});

router.get("/list", async function (req, res, next) {
  try {
    const { title, status } = req.query;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection("productCollections");

    const query = {};

    // title search
    if (title) {
      query.title = {
        $regex: String(title),
        $options: "i",
      };
    }

    // status filter
    if (status) {
      let statusArray = status;

      // support status=a,b,c
      if (typeof status === "string") {
        statusArray = status.split(",");
      }

      // make sure it is array
      if (!Array.isArray(statusArray)) {
        statusArray = [statusArray];
      }

      query.status = {
        $in: statusArray,
      };
    }

    const totalDocs = await collection.countDocuments(query);

    const data = await collection
      .find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    return res.status(200).json({
      success: true,
      totalDocs,
      page,
      pageSize,
      totalPages: Math.ceil(totalDocs / pageSize),
      data,
    });
  } catch (error) {
    console.error("List collections error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collections",
      error: error.message,
    });
  }
});
router.get("/detail/:id", async function (req, res, next) {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection id",
      });
    }

    const db = await connectToDatabase();

    const collection = db.collection("productCollections");

    const data = await collection.findOne({
      _id: new ObjectId(id),
    });

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "Collection not found",
      });
    }

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Get collection detail error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collection detail",
      error: error.message,
    });
  }
});

router.get("/getGroup", async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("productCollectionsGroups");

    const groups = await collection.find({}).toArray();

    return res.json({
      success: true,
      data: groups,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to get groups",
    });
  }
});

router.post("/updateGroup", async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("productCollectionsGroups");

    const data = req.body;

    if (!Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        message: "Request body must be an array",
      });
    }

    // clear all existing records
    await collection.deleteMany({});

    // insert new data
    if (data.length > 0) {
      await collection.insertMany(data);
    }

    return res.json({
      success: true,
      message: "Groups updated successfully",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to update groups",
    });
  }
});

router.post("/delete", async function (req, res, next) {
  try {
    const { id } = req.body;

    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection id",
      });
    }

    const db = await connectToDatabase();

    const collection = db.collection("productCollections");

    const result = await collection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Collection not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Collection deleted successfully",
    });
  } catch (error) {
    console.error("Delete collection error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete collection",
      error: error.message,
    });
  }
});
module.exports = router;
