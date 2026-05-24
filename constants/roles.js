// Role definitions and their permission sets.
//
// Permission strings follow the RuoYi-style "group:resource:action" convention.
// A segment of "*" is a wildcard, so "sqt:*:*" matches any sqt permission and
// "*:*:*" matches everything (super admin).

const ROLES = {
  ADMIN: "admin",
  IMOBILE_ADMIN: "imobile-admin",
  TECHELITE_ADMIN: "techelite-admin",
  SHOP_OWNER: "shop-owner",
  REPAIR_SHOP: "repair-shop",
};

const ROLE_LABELS = {
  [ROLES.ADMIN]: "Admin",
  [ROLES.IMOBILE_ADMIN]: "iMobile Admin",
  [ROLES.TECHELITE_ADMIN]: "TechElite Admin",
  [ROLES.SHOP_OWNER]: "Repair Shop Owner",
  [ROLES.REPAIR_SHOP]: "Repair Shop",
};

// Shop-side case actions shared by both shop roles. The two roles differ only in
// data scope (an owner has many shopIds, a repair shop has one).
const SHOP_CASE_PERMISSIONS = [
  "sqt:case:list",
  "sqt:case:partsReceived",
  "sqt:case:customerNotified",
  "sqt:case:startRepair",
  "sqt:case:markRepaired",
  "sqt:case:markCollected",
  "sqt:case:markUnrepairable",
  "sqt:case:note",
  "sqt:case:editDevice",
];

const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: ["*:*:*"],
  [ROLES.IMOBILE_ADMIN]: ["zoho:*:*"],
  [ROLES.TECHELITE_ADMIN]: ["sqt:*:*"],
  [ROLES.SHOP_OWNER]: [...SHOP_CASE_PERMISSIONS],
  [ROLES.REPAIR_SHOP]: [...SHOP_CASE_PERMISSIONS],
};

// Roles whose data is scoped to the shops listed on their user record.
const SHOP_SCOPED_ROLES = [ROLES.SHOP_OWNER, ROLES.REPAIR_SHOP];

function isValidRole(role) {
  return Object.values(ROLES).includes(role);
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : [];
}

function isShopScopedRole(role) {
  return SHOP_SCOPED_ROLES.includes(role);
}

// Does `granted` (a single permission string, possibly with wildcards) cover
// the `required` permission? Compares segment-by-segment.
function permissionMatches(granted, required) {
  if (granted === required) return true;
  const g = String(granted).split(":");
  const r = String(required).split(":");
  if (g.length !== r.length) return false;
  return g.every((seg, i) => seg === "*" || seg === r[i]);
}

// Does the user's permission list satisfy the required permission?
function hasPermission(userPermissions, required) {
  if (!Array.isArray(userPermissions)) return false;
  if (!required) return true;
  return userPermissions.some((p) => permissionMatches(p, required));
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  SHOP_SCOPED_ROLES,
  isValidRole,
  getPermissionsForRole,
  isShopScopedRole,
  permissionMatches,
  hasPermission,
};
