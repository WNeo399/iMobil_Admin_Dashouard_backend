var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { comparePassword, hashPassword, signToken } = require("../../utils/authToken");
const { authenticate } = require("../../middleware/auth");
const { ROLE_LABELS } = require("../../constants/roles");

const USERS_COLLECTION = "users";

// POST /auth/login  — accepts username OR email in the `username` field
router.post("/login", async function (req, res, next) {
  try {
    const account = String(
      req.body.username || req.body.account || req.body.email || "",
    ).trim();
    const password = req.body.password;

    if (!account || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Username/email and password are required" });
    }

    const db = await connectToDatabase();
    const users = db.collection(USERS_COLLECTION);

    // Match against username (exact) or email (lowercased)
    const user = await users.findOne({
      $or: [{ username: account }, { email: account.toLowerCase() }],
    });

    // Use a generic message so we don't reveal whether the account exists
    const invalidMsg = "Invalid username/email or password";
    if (!user) {
      return res.status(401).json({ success: false, message: invalidMsg });
    }
    if (user.active === false) {
      return res.status(403).json({ success: false, message: "Account is disabled" });
    }

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) {
      return res.status(401).json({ success: false, message: invalidMsg });
    }

    const token = signToken({ userId: String(user._id) });

    // Touch lastLoginAt (best-effort)
    users
      .updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } })
      .catch(() => {});

    return res.json({ success: true, token });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ success: false, message: "Login failed" });
  }
});

// GET /auth/getInfo — current user profile + role + permissions + shop scope
router.get("/getInfo", authenticate, async function (req, res, next) {
  try {
    const u = req.user;

    let shops = [];
    if (Array.isArray(u.accessibleShopIds) && u.accessibleShopIds.length > 0) {
      const db = await connectToDatabase();
      shops = await db
        .collection("sqt_shops")
        .find({ _id: { $in: u.accessibleShopIds } })
        .project({ storeName: 1, slug: 1 })
        .toArray();
    }

    return res.json({
      success: true,
      user: {
        id: String(u._id),
        username: u.username,
        email: u.email,
        nickName: u.username,
        role: u.role,
        roleLabel: ROLE_LABELS[u.role] || u.role,
      },
      // RuoYi frontend expects arrays here
      roles: [u.role],
      permissions: u.permissions,
      // null = unscoped; array of id strings = restricted to these shops
      accessibleShopIds:
        u.accessibleShopIds === null ? null : u.accessibleShopIds.map(String),
      shops,
    });
  } catch (error) {
    console.error("getInfo error:", error);
    return res.status(500).json({ success: false, message: "Failed to load user info" });
  }
});

// POST /auth/changePassword — the logged-in user changes their own password
router.post("/changePassword", authenticate, async function (req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Current and new password are required" });
    }
    if (String(newPassword).length < 6) {
      return res
        .status(400)
        .json({ success: false, message: "New password must be at least 6 characters" });
    }

    const db = await connectToDatabase();
    const users = db.collection(USERS_COLLECTION);

    const user = await users.findOne({ _id: new ObjectId(req.user._id) });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const ok = await comparePassword(currentPassword, user.passwordHash);
    if (!ok) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect" });
    }

    await users.updateOne(
      { _id: user._id },
      { $set: { passwordHash: await hashPassword(newPassword), updatedAt: new Date() } },
    );

    return res.json({ success: true, message: "Password changed" });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ success: false, message: "Failed to change password" });
  }
});

// POST /auth/logout — JWT is stateless, so logout is mostly a client concern.
// Provided for symmetry / future token-blacklist support.
router.post("/logout", function (req, res) {
  return res.json({ success: true, message: "Logged out" });
});

module.exports = router;
