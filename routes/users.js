var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../utils/mongodb");
const { hashPassword } = require("../utils/authToken");
const { requirePermission } = require("../middleware/auth");
const {
  ROLES,
  ROLE_LABELS,
  isValidRole,
  isShopScopedRole,
} = require("../constants/roles");

const COLLECTION = "users";

// Only Admin (the *:*:* wildcard) holds this permission.
const requireUserAdmin = requirePermission("system:user:manage");

// Never leak the password hash to the client.
const PUBLIC_PROJECTION = { passwordHash: 0 };

function normalizeShopIds(shopIds) {
  if (!Array.isArray(shopIds)) return [];
  return shopIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
}

// Roles available for assignment (for the role dropdown)
router.get("/roles", requireUserAdmin, function (req, res) {
  const data = Object.values(ROLES).map((value) => ({
    value,
    label: ROLE_LABELS[value] || value,
    shopScoped: isShopScopedRole(value),
  }));
  return res.json({ success: true, data });
});

router.get("/list", requireUserAdmin, async function (req, res, next) {
  try {
    const { role, search, active } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const query = {};
    if (role) query.role = role;
    if (active !== undefined && active !== "") {
      query.active = active === "true" || active === true;
    }
    if (search) {
      const re = { $regex: String(search), $options: "i" };
      query.$or = [{ username: re }, { email: re }];
    }

    const totalDocs = await collection.countDocuments(query);
    const data = await collection
      .find(query, { projection: PUBLIC_PROJECTION })
      .sort({ createdAt: -1 })
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
    console.error("List users error:", error);
    return res.status(500).json({ success: false, message: "Failed to list users" });
  }
});

router.get("/detail/:id", requireUserAdmin, async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }
    const db = await connectToDatabase();
    const data = await db
      .collection(COLLECTION)
      .findOne({ _id: new ObjectId(id) }, { projection: PUBLIC_PROJECTION });
    if (!data) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Get user error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }
});

router.post("/create", requireUserAdmin, async function (req, res, next) {
  try {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    const role = req.body.role;

    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "username, email and password are required" });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const dup = await collection.findOne({ $or: [{ username }, { email }] });
    if (dup) {
      return res
        .status(409)
        .json({ success: false, message: "Username or email already in use" });
    }

    const now = new Date();
    const doc = {
      username,
      email,
      passwordHash: await hashPassword(password),
      role,
      // Shop list only matters for shop-scoped roles
      shopIds: isShopScopedRole(role) ? normalizeShopIds(req.body.shopIds) : [],
      active: req.body.active === undefined ? true : !!req.body.active,
      createdAt: now,
      updatedAt: now,
    };

    const result = await collection.insertOne(doc);
    delete doc.passwordHash;
    return res
      .status(201)
      .json({ success: true, message: "User created", data: { _id: result.insertedId, ...doc } });
  } catch (error) {
    console.error("Create user error:", error);
    return res.status(500).json({ success: false, message: "Failed to create user" });
  }
});

router.put("/update/:id", requireUserAdmin, async function (req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const existing = await collection.findOne({ _id: new ObjectId(id) });
    if (!existing) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const update = { updatedAt: new Date() };

    if (req.body.username !== undefined) update.username = String(req.body.username).trim();
    if (req.body.email !== undefined) update.email = String(req.body.email).trim().toLowerCase();
    if (req.body.active !== undefined) update.active = !!req.body.active;

    let effectiveRole = existing.role;
    if (req.body.role !== undefined) {
      if (!isValidRole(req.body.role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
      }
      update.role = req.body.role;
      effectiveRole = req.body.role;
    }

    // Keep shopIds consistent with the (effective) role
    if (req.body.shopIds !== undefined || req.body.role !== undefined) {
      update.shopIds = isShopScopedRole(effectiveRole)
        ? normalizeShopIds(req.body.shopIds !== undefined ? req.body.shopIds : existing.shopIds)
        : [];
    }

    // Uniqueness checks when username/email changed
    const orClauses = [];
    if (update.username) orClauses.push({ username: update.username });
    if (update.email) orClauses.push({ email: update.email });
    if (orClauses.length > 0) {
      const conflict = await collection.findOne({
        $or: orClauses,
        _id: { $ne: new ObjectId(id) },
      });
      if (conflict) {
        return res
          .status(409)
          .json({ success: false, message: "Username or email already in use" });
      }
    }

    // Guard: an admin can't demote or deactivate their own account (avoids
    // accidentally locking the last admin out).
    const isSelf = String(req.user._id) === String(id);
    if (isSelf && (update.role && update.role !== ROLES.ADMIN)) {
      return res
        .status(400)
        .json({ success: false, message: "You cannot change your own role" });
    }
    if (isSelf && update.active === false) {
      return res
        .status(400)
        .json({ success: false, message: "You cannot deactivate your own account" });
    }

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: update });
    const updated = await collection.findOne(
      { _id: new ObjectId(id) },
      { projection: PUBLIC_PROJECTION },
    );
    return res.json({ success: true, message: "User updated", data: updated });
  } catch (error) {
    console.error("Update user error:", error);
    return res.status(500).json({ success: false, message: "Failed to update user" });
  }
});

router.post("/resetPassword", requireUserAdmin, async function (req, res, next) {
  try {
    const { id, password } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }
    if (!password || String(password).length < 6) {
      return res
        .status(400)
        .json({ success: false, message: "Password must be at least 6 characters" });
    }

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).updateOne(
      { _id: new ObjectId(id) },
      { $set: { passwordHash: await hashPassword(password), updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, message: "Password reset" });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ success: false, message: "Failed to reset password" });
  }
});

router.post("/delete", requireUserAdmin, async function (req, res, next) {
  try {
    const { id } = req.body;
    if (!id || !ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }
    if (String(req.user._id) === String(id)) {
      return res
        .status(400)
        .json({ success: false, message: "You cannot delete your own account" });
    }

    const db = await connectToDatabase();
    const result = await db.collection(COLLECTION).deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, message: "User deleted" });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete user" });
  }
});

module.exports = router;
