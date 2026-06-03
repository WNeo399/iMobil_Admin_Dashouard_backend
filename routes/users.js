var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../utils/mongodb");
const { hashPassword } = require("../utils/authToken");
const { requirePermission } = require("../middleware/auth");
const {
  ROLES,
  ROLE_LABELS,
  ROLE_GROUPS,
  ROLE_GROUP_LABELS,
  ROLE_GROUP_OF,
  isValidRole,
  isShopScopedRole,
} = require("../constants/roles");

const COLLECTION = "users";

// Admin (*:*:*) and TechElite Admin both hold this permission.
const requireUserAdmin = requirePermission("system:user:manage");

// Never leak the password hash to the client.
const PUBLIC_PROJECTION = { passwordHash: 0 };

function normalizeShopIds(shopIds) {
  if (!Array.isArray(shopIds)) return [];
  return shopIds
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
}

// Role-aware variant: Repair Shop is a single-shop role (one physical
// location, one account), Repair Shop Owner can hold many. Trimming on the
// server side guarantees the invariant even if a client sends extras.
function normalizeShopIdsForRole(shopIds, role) {
  if (!isShopScopedRole(role)) return [];
  const ids = normalizeShopIds(shopIds);
  if (role === ROLES.REPAIR_SHOP) return ids.slice(0, 1);
  return ids;
}

// Roles available for assignment (for the role dropdown) plus UI grouping
// metadata so the Users page can render its left-side role tree without
// duplicating the group map.
router.get("/roles", requireUserAdmin, function (req, res) {
  const data = Object.values(ROLES).map((value) => ({
    value,
    label: ROLE_LABELS[value] || value,
    shopScoped: isShopScopedRole(value),
    group: ROLE_GROUP_OF[value] || null,
  }));
  const groups = Object.values(ROLE_GROUPS).map((value) => ({
    value,
    label: ROLE_GROUP_LABELS[value] || value,
  }));
  return res.json({ success: true, data, groups });
});

router.get("/list", requireUserAdmin, async function (req, res, next) {
  try {
    const { role, search, active, shopId } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize, 10) || 20, 1);

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    const query = {};
    // `role` accepts either a single role string or a comma-separated list
    // so the Users page tree can filter a group node (multiple roles) in
    // one request. Single-role callers (the old dropdown / the shop-edit
    // Users tab) keep working unchanged.
    if (role) {
      const roles = String(role)
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      if (roles.length === 1) {
        query.role = roles[0];
      } else if (roles.length > 1) {
        query.role = { $in: roles };
      }
    }
    if (active !== undefined && active !== "") {
      query.active = active === "true" || active === true;
    }
    if (search) {
      const re = { $regex: String(search), $options: "i" };
      query.$or = [{ username: re }, { email: re }];
    }

    // Used by the Shop edit dialog's Users tab — match any user whose shopIds
    // array contains this shop. When the caller didn't already constrain the
    // role, restrict to the shop-scoped roles so we don't surface, say, an
    // admin user that happens to have a shop linked to them.
    if (shopId && ObjectId.isValid(shopId)) {
      query.shopIds = new ObjectId(shopId);
      if (!query.role) {
        query.role = { $in: [ROLES.SHOP_OWNER, ROLES.REPAIR_SHOP] };
      }
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
    // Email is optional — users can log in with just their username. When
    // provided we still lowercase + uniqueness-check it.
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    const role = req.body.role;

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: "username and password are required" });
    }
    if (!isValidRole(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    // Uniqueness — always check the username, and also the email when one
    // was supplied. We never compare on an empty email (that would collide
    // every other email-less user against each other).
    const dupOr = [{ username }];
    if (email) dupOr.push({ email });
    const dup = await collection.findOne({ $or: dupOr });
    if (dup) {
      return res
        .status(409)
        .json({ success: false, message: "Username or email already in use" });
    }

    const now = new Date();
    const doc = {
      username,
      email: email || null,
      passwordHash: await hashPassword(password),
      role,
      // Shop list only matters for shop-scoped roles. normalizeShopIdsForRole
      // also enforces the max-1 rule for the repair-shop role.
      shopIds: normalizeShopIdsForRole(req.body.shopIds, role),
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
    // Email is optional — treat empty string as "clear it" and store null so
    // the unique-email check below doesn't see one user's "" colliding with
    // another's.
    if (req.body.email !== undefined) {
      const trimmed = String(req.body.email).trim().toLowerCase();
      update.email = trimmed === "" ? null : trimmed;
    }
    if (req.body.active !== undefined) update.active = !!req.body.active;

    let effectiveRole = existing.role;
    if (req.body.role !== undefined) {
      if (!isValidRole(req.body.role)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
      }
      update.role = req.body.role;
      effectiveRole = req.body.role;
    }

    // Keep shopIds consistent with the (effective) role — incl. enforcing
    // the max-1 rule for repair-shop. We use the existing shopIds when the
    // request didn't include them so a pure role-change still gets trimmed
    // (e.g. shop-owner → repair-shop with prior multi-shop list).
    if (req.body.shopIds !== undefined || req.body.role !== undefined) {
      const sourceIds = req.body.shopIds !== undefined ? req.body.shopIds : existing.shopIds;
      update.shopIds = normalizeShopIdsForRole(sourceIds, effectiveRole);
    }

    // Uniqueness checks when username/email changed — skip email when it
    // was cleared (null) so an empty value can be reused across users.
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
