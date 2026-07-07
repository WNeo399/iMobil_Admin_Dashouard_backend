const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../utils/mongodb");
const { verifyToken } = require("../utils/authToken");
const {
  getPermissionsForRole,
  isShopScopedRole,
  hasPermission,
} = require("../constants/roles");

const USERS_COLLECTION = "users";

function extractToken(req) {
  const header = req.headers["authorization"] || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (header.startsWith("Zoho-oauthtoken ")) return null; // not ours
  return header.trim() || null;
}

// Verifies the JWT, loads the fresh user record, and attaches a normalized
// req.user. We re-read the user each request so a deactivated account or a
// changed role/shop list takes effect immediately (no stale-token access).
async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (e) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    if (!decoded || !decoded.userId || !ObjectId.isValid(decoded.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token payload" });
    }

    const db = await connectToDatabase();
    const user = await db
      .collection(USERS_COLLECTION)
      .findOne({ _id: new ObjectId(decoded.userId) });

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }
    if (user.active === false) {
      return res.status(403).json({ success: false, message: "Account is disabled" });
    }

    const shopIds = Array.isArray(user.shopIds) ? user.shopIds : [];

    req.user = {
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      permissions: getPermissionsForRole(user.role),
      shopIds,
      // null = unscoped (sees all). An array = restricted to these shop ids.
      accessibleShopIds: isShopScopedRole(user.role)
        ? shopIds.map((id) => (id instanceof ObjectId ? id : new ObjectId(id)))
        : null,
      // InFlow customer-portal link — scopes the Statement page to one customer.
      inflowCustomerId: user.inflowCustomerId || null,
      inflowCustomerName: user.inflowCustomerName || null,
    };

    next();
  } catch (error) {
    console.error("Authenticate error:", error);
    return res.status(500).json({ success: false, message: "Authentication failed" });
  }
}

// Route guard factory — use after `authenticate`.
function requirePermission(required) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    if (!hasPermission(req.user.permissions, required)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    next();
  };
}

// "Allowed if the user holds ANY of these permissions" — for endpoints shared
// across roles whose permission sets don't overlap on a single string. E.g.
// product search is wanted by both Send Parts (sqt:case:sendParts) and
// Collection editing (zoho:collection:edit).
function requireAnyPermission(...permissions) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const ok = permissions.some((p) => hasPermission(req.user.permissions, p));
    if (!ok) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    next();
  };
}

module.exports = { authenticate, requirePermission, requireAnyPermission };
