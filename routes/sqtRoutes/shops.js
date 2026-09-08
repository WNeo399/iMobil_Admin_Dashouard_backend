var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const COLLECTION = "sqt_shops";
// Shop groups — shops that belong together (one franchise, one owner's
// stores). Membership lives on the shop doc as `groupId`, so a shop only
// ever sits in one group. No page of their own: the Shops page switches
// between a Shops view and a Groups view.
const GROUPS = "sqt_shop_groups";
const USERS = "users";

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

// ── Shop Groups ─────────────────────────────────────────────────────
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace a group's membership in one move: listed shops point at the
// group (pulling them out of any other group — one group per shop), and
// members no longer listed are released.
async function setGroupMembers(db, groupId, shopIds) {
  const ids = (Array.isArray(shopIds) ? shopIds : [])
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  const now = new Date();
  await db.collection(COLLECTION).updateMany(
    { groupId, _id: { $nin: ids } },
    { $set: { groupId: null, updatedAt: now } },
  );
  if (ids.length) {
    await db.collection(COLLECTION).updateMany(
      { _id: { $in: ids } },
      { $set: { groupId, updatedAt: now } },
    );
  }
  return ids.length;
}

// Groups with their member shops joined in — the register is small
// enough that two queries cover the whole view.
router.get("/groups/list", async function (req, res) {
  try {
    const db = await connectToDatabase();
    const groups = await db.collection(GROUPS).find({}).sort({ name: 1 }).toArray();
    const shops = await db
      .collection(COLLECTION)
      .find({ groupId: { $ne: null } }, { projection: { storeName: 1, status: 1, groupId: 1 } })
      .sort({ storeName: 1 })
      .toArray();
    const byGroup = new Map();
    for (const s of shops) {
      const k = String(s.groupId);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push({ _id: s._id, storeName: s.storeName, status: s.status });
    }
    return res.json({
      success: true,
      data: groups.map((g) => ({ ...g, shops: byGroup.get(String(g._id)) || [] })),
    });
  } catch (error) {
    console.error("List shop groups error:", error);
    return res.status(500).json({ success: false, message: "Failed to list groups" });
  }
});

router.post("/groups/create", async function (req, res) {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Group name is required" });

    const db = await connectToDatabase();
    const clash = await db
      .collection(GROUPS)
      .findOne({ name: { $regex: `^${escapeRegex(name)}$`, $options: "i" } });
    if (clash) {
      return res.status(409).json({ success: false, message: "A group with this name already exists" });
    }

    const now = new Date();
    const doc = {
      name,
      // Who to talk to about the group (the franchise's head office
      // contact, typically) — plain fields, all optional.
      contactName: String((req.body && req.body.contactName) || "").trim().slice(0, 120) || null,
      contactPhone: String((req.body && req.body.contactPhone) || "").trim().slice(0, 60) || null,
      contactEmail:
        String((req.body && req.body.contactEmail) || "").trim().toLowerCase().slice(0, 140) || null,
      notes: String((req.body && req.body.notes) || "").trim().slice(0, 500) || null,
      createdAt: now,
      updatedAt: now,
    };
    const r = await db.collection(GROUPS).insertOne(doc);
    const members = await setGroupMembers(db, r.insertedId, req.body && req.body.shopIds);
    return res.status(201).json({
      success: true,
      message: `Group created with ${members} shop(s)`,
      data: { _id: r.insertedId, ...doc },
    });
  } catch (error) {
    console.error("Create shop group error:", error);
    return res.status(500).json({ success: false, message: "Failed to create the group" });
  }
});

router.put("/groups/update/:id", async function (req, res) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid group id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(id);
    const group = await db.collection(GROUPS).findOne({ _id });
    if (!group) return res.status(404).json({ success: false, message: "Group not found" });

    const update = { updatedAt: new Date() };
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: "Group name is required" });
      const clash = await db.collection(GROUPS).findOne({
        name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
        _id: { $ne: _id },
      });
      if (clash) {
        return res.status(409).json({ success: false, message: "A group with this name already exists" });
      }
      update.name = name;
    }
    if (req.body.contactName !== undefined) {
      update.contactName = String(req.body.contactName || "").trim().slice(0, 120) || null;
    }
    if (req.body.contactPhone !== undefined) {
      update.contactPhone = String(req.body.contactPhone || "").trim().slice(0, 60) || null;
    }
    if (req.body.contactEmail !== undefined) {
      update.contactEmail =
        String(req.body.contactEmail || "").trim().toLowerCase().slice(0, 140) || null;
    }
    if (req.body.notes !== undefined) {
      update.notes = String(req.body.notes || "").trim().slice(0, 500) || null;
    }
    await db.collection(GROUPS).updateOne({ _id }, { $set: update });
    if (req.body.shopIds !== undefined) {
      await setGroupMembers(db, _id, req.body.shopIds);
    }
    return res.json({ success: true, message: "Group updated" });
  } catch (error) {
    console.error("Update shop group error:", error);
    return res.status(500).json({ success: false, message: "Failed to update the group" });
  }
});

// Deleting a group releases its shops — the shops themselves stay.
router.post("/groups/delete", async function (req, res) {
  try {
    const { id } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid group id" });
    }
    const db = await connectToDatabase();
    const _id = new ObjectId(id);
    const released = await db.collection(COLLECTION).updateMany(
      { groupId: _id },
      { $set: { groupId: null, updatedAt: new Date() } },
    );
    const r = await db.collection(GROUPS).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Group not found" });
    return res.json({
      success: true,
      message: `Group deleted — ${released.modifiedCount} shop(s) released`,
    });
  } catch (error) {
    console.error("Delete shop group error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete the group" });
  }
});

// Link a Repair Shop Owner to the group: every shop in it joins the
// owner's shop list (existing links kept, duplicates skipped). Running
// it again after the group grows adds just the new shops. Touches user
// records, so it needs the user-management permission on top of the
// shop one the mount applies.
router.post(
  "/groups/:id/link-owner",
  requirePermission("system:user:manage"),
  async function (req, res) {
    try {
      const { id } = req.params;
      const userId = req.body && req.body.userId;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid group id" });
      }
      if (!userId || !ObjectId.isValid(userId)) {
        return res.status(400).json({ success: false, message: "Invalid user id" });
      }
      const db = await connectToDatabase();
      const group = await db.collection(GROUPS).findOne({ _id: new ObjectId(id) });
      if (!group) return res.status(404).json({ success: false, message: "Group not found" });
      const user = await db
        .collection(USERS)
        .findOne({ _id: new ObjectId(userId) }, { projection: { username: 1, role: 1, shopIds: 1 } });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });
      if (user.role !== "shop-owner") {
        return res.status(400).json({
          success: false,
          message: "Only a Repair Shop Owner account can be linked to a group",
        });
      }
      const members = await db
        .collection(COLLECTION)
        .find({ groupId: group._id }, { projection: { _id: 1 } })
        .toArray();
      if (!members.length) {
        return res.status(400).json({ success: false, message: "This group has no shops yet" });
      }
      const have = new Set((user.shopIds || []).map(String));
      const add = members.map((m) => m._id).filter((sid) => !have.has(String(sid)));
      if (add.length) {
        await db.collection(USERS).updateOne(
          { _id: user._id },
          { $addToSet: { shopIds: { $each: add } }, $set: { updatedAt: new Date() } },
        );
      }
      return res.json({
        success: true,
        added: add.length,
        total: members.length,
        message: add.length
          ? `${add.length} shop(s) added to ${user.username}`
          : `${user.username} already has every shop in ${group.name}`,
      });
    } catch (error) {
      console.error("Link group owner error:", error);
      return res.status(500).json({ success: false, message: "Failed to link the owner" });
    }
  },
);

module.exports = router;
