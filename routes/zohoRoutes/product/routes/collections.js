var express = require("express");
var axios = require("axios");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../../../utils/mongodb");
// A saved collection re-stamps its members in the stock register at once,
// so the Stock Monitoring list (which reads membership from the register)
// shows the change without waiting for the next refresh.
const { restampCollection } = require("../../../../utils/collectionStamp");
// The rule vocabulary, its validation, the builder's value options and
// the "matches N items" preview all live in one place.
const { sanitizeRows, filterOptions, previewRows, SCOPE_BY_STORE } = require("../../../../utils/collectionFilter");

// This module exports a ROUTER FACTORY rather than a router: the same
// collection-management endpoints serve both the Spare Parts set
// (productCollections) and the Accessories set (accessoryCollections),
// differing only in which Mongo collections they read/write. product/index.js
// mounts one instance per data set.

// Normalize the `products` payload from a Selection-type collection. We accept
// either an array of objects ({ itemId, sku, name, imageUrl }) or a plain
// array of itemId strings (legacy / lightweight callers). Drops anything
// without a usable itemId and de-duplicates so the same item can't appear
// twice in one collection.
function sanitizeProducts(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw) continue;
    const itemId =
      typeof raw === "string" || typeof raw === "number"
        ? String(raw).trim()
        : raw.itemId != null
          ? String(raw.itemId).trim()
          : "";
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({
      itemId,
      sku: raw.sku ? String(raw.sku) : "",
      name: raw.name ? String(raw.name) : "",
      imageUrl: raw.imageUrl ? String(raw.imageUrl) : "",
    });
  }
  return out;
}

// The stored form of a collection's rule: { rows } validated against the
// vocabulary. A bad row is a 400 to the caller, never a stored mystery.
function sanitizeFilter(input) {
  const rows = input && typeof input === "object" ? input.rows : input;
  return { rows: sanitizeRows(Array.isArray(rows) ? rows : []) };
}

function createCollectionsRouter({ collectionsName, groupsName }) {
  const router = express.Router();
  const scope = SCOPE_BY_STORE[collectionsName];

  // ── GET /filter-options ─────────────────────────────────────────
  // What the criteria builder offers: fields, conditions, and the
  // register's current values for the pick lists (this business only).
  router.get("/filter-options", async function (req, res) {
    try {
      const db = await connectToDatabase();
      return res.json({ success: true, data: await filterOptions(db, scope) });
    } catch (error) {
      console.error("Filter options error:", error);
      return res.status(500).json({ success: false, message: "Failed to load the filter options" });
    }
  });

  // ── POST /filter-preview  { rows } ──────────────────────────────
  // How many register items the rule catches, with a few names.
  router.post("/filter-preview", async function (req, res) {
    try {
      let rows;
      try {
        rows = sanitizeRows((req.body && req.body.rows) || []);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
      const db = await connectToDatabase();
      return res.json({ success: true, data: await previewRows(db, rows, scope) });
    } catch (error) {
      console.error("Filter preview error:", error);
      return res.status(500).json({ success: false, message: "Failed to preview the filter" });
    }
  });

router.post("/create", async function (req, res, next) {
  try {
    const { title, type, filter, children, note, status, products } = req.body;

    // basic validation
    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Title is required",
      });
    }
    let cleanFilter;
    try {
      cleanFilter = sanitizeFilter(filter);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const db = await connectToDatabase();

    const collection = db.collection(collectionsName);

    const newCollection = {
      title,
      note,
      type: type || "Selection",
      status: status || "draft",
      // The rule: rows over the stock register (utils/collectionFilter).
      filter: cleanFilter,
      children: children || [],
      // Selection-type collections store the picked products inline. Each
      // entry carries the Zoho Inventory item_id (the source of truth for
      // downstream lookups) plus light display metadata so the edit dialog
      // can render without re-hitting Commerce/Inventory.
      products: sanitizeProducts(products),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await collection.insertOne(newCollection);
    await restampCollection(collectionsName, { _id: result.insertedId, ...newCollection });

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

// ── POST /copy/:id ──────────────────────────────────────────────────
// Duplicate a collection wholesale — every field it carries, criteria
// and picked products included — as a new DRAFT named "<title> - Copy"
// (then "<title> - Copy 2", … when that name is already taken).
router.post("/copy/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid collection ID" });
    }
    const db = await connectToDatabase();
    const collection = db.collection(collectionsName);
    const source = await collection.findOne({ _id: new ObjectId(id) });
    if (!source) {
      return res.status(404).json({ success: false, message: "Collection not found" });
    }
    let title = `${source.title} - Copy`;
    for (let n = 2; await collection.findOne({ title }); n++) {
      title = `${source.title} - Copy ${n}`;
    }
    const now = new Date();
    const { _id, ...rest } = source;
    // "Draft" capitalized — the status vocabulary the form dialog and the
    // status tag colouring use.
    const copy = { ...rest, title, status: "Draft", createdAt: now, updatedAt: now };
    const result = await collection.insertOne(copy);
    await restampCollection(collectionsName, { _id: result.insertedId, ...copy });
    return res.status(201).json({
      success: true,
      message: `Copied to "${title}" (draft)`,
      data: { _id: result.insertedId, ...copy },
    });
  } catch (error) {
    console.error("Copy collection error:", error);
    return res.status(500).json({ success: false, message: "Failed to copy the collection" });
  }
});

router.put("/update/:id", async function (req, res, next) {
  try {
    const { id } = req.params;
    const { title, type, filter, children, status, note, products } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection id",
      });
    }
    let cleanFilter;
    if (filter !== undefined) {
      try {
        cleanFilter = sanitizeFilter(filter);
      } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
      }
    }

    const db = await connectToDatabase();

    const collection = db.collection(collectionsName);

    const updateData = {
      updatedAt: new Date(),
    };

    // only update provided fields
    if (title !== undefined) updateData.title = title;
    if (note !== undefined) updateData.note = note;
    if (type !== undefined) updateData.type = type;
    if (cleanFilter !== undefined) updateData.filter = cleanFilter;
    if (children !== undefined) updateData.children = children;
    // Bug fix: this previously wrote `status` into the `children` field,
    // which silently dropped status edits and corrupted the children array.
    if (status !== undefined) updateData.status = status;
    if (products !== undefined) updateData.products = sanitizeProducts(products);
    // The title before this save — a rename must drop the old tag.
    const before = await collection.findOne({ _id: new ObjectId(id) }, { projection: { title: 1 } });
    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: updateData,
        // The pre-2026-09-22 Analytics criteria string, if this document
        // still carried one, is superseded by the filter.
        ...(cleanFilter !== undefined ? { $unset: { rules: "" } } : {}),
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
    await restampCollection(collectionsName, updatedCollection, before && before.title);

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
    const collection = db.collection(collectionsName);

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

    const collection = db.collection(collectionsName);

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
    const collection = db.collection(groupsName);

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
    const collection = db.collection(groupsName);

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

    const collection = db.collection(collectionsName);

    const before = await collection.findOne({ _id: new ObjectId(id) }, { projection: { title: 1 } });
    const result = await collection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Collection not found",
      });
    }
    // Its tag comes off every row now rather than at the next refresh.
    if (before) await restampCollection(collectionsName, null, before.title);

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
  return router;
}

module.exports = createCollectionsRouter;
