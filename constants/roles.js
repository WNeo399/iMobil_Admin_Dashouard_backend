// Role definitions and their permission sets.
//
// Permission strings follow the RuoYi-style "group:resource:action" convention.
// A segment of "*" is a wildcard, so "sqt:*:*" matches any sqt permission and
// "*:*:*" matches everything (super admin).

const ROLES = {
  ADMIN: "admin",
  IMOBILE_ADMIN: "imobile-admin",
  IMOBILE_REPAIR_ADMIN: "imobile-repair-admin",
  TECHELITE_ADMIN: "techelite-admin",
  SHOP_OWNER: "shop-owner",
  REPAIR_SHOP: "repair-shop",
  // Portal login for an InFlow customer — sees only their own statement.
  INFLOW_CUSTOMER: "inflow-customer",
};

const ROLE_LABELS = {
  [ROLES.ADMIN]: "Admin",
  [ROLES.IMOBILE_ADMIN]: "iMobile Admin",
  [ROLES.IMOBILE_REPAIR_ADMIN]: "iMobile Repair Admin",
  [ROLES.TECHELITE_ADMIN]: "TechElite Admin",
  [ROLES.SHOP_OWNER]: "Repair Shop Owner",
  [ROLES.REPAIR_SHOP]: "Repair Shop",
  [ROLES.INFLOW_CUSTOMER]: "InFlow Customer",
};

// UI grouping for the System → Users role-tree panel. Roles inside the
// same group share a parent node in the tree. Pure presentation — has no
// effect on permission checks.
const ROLE_GROUPS = {
  IMOBILE: "imobile",
  TECHELITE: "techelite",
  INFLOW: "inflow",
};

const ROLE_GROUP_LABELS = {
  [ROLE_GROUPS.IMOBILE]: "iMobile",
  [ROLE_GROUPS.TECHELITE]: "TechElite",
  [ROLE_GROUPS.INFLOW]: "InFlow",
};

const ROLE_GROUP_OF = {
  [ROLES.ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_REPAIR_ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.TECHELITE_ADMIN]: ROLE_GROUPS.TECHELITE,
  [ROLES.SHOP_OWNER]: ROLE_GROUPS.TECHELITE,
  [ROLES.REPAIR_SHOP]: ROLE_GROUPS.TECHELITE,
  [ROLES.INFLOW_CUSTOMER]: ROLE_GROUPS.INFLOW,
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
  // Raise a request for more parts on an in-progress case.
  "sqt:case:requireExtraParts",
  "sqt:case:note",
  "sqt:case:editDevice",
];

const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: ["*:*:*"],
  // iMobile Admin owns the iMobile-side modules: Zoho Inventory / Tools, the
  // Repair (RepairDesk) page, and the Apple SVP genuine-parts enquiries.
  // InFlow: iMobile Admin can view orders + customers; recording payments is
  // Admin-only (inflow:order:payment, which only "*:*:*" grants).
  [ROLES.IMOBILE_ADMIN]: [
    "zoho:*:*", "repair:*:*", "svp:*:*", "po:*:*", "refurb:*:*",
    "inflow:order:view", "inflow:customer:view",
  ],
  // iMobile Repair Admin: starts with full Repair access so the role is
  // usable from day one. Other permissions are pending the owner's input.
  [ROLES.IMOBILE_REPAIR_ADMIN]: ["repair:*:*"],
  // TechElite Admin owns the SQT domain and also manages users (read/create/
  // edit/delete + password reset) via the System → Users page.
  [ROLES.TECHELITE_ADMIN]: ["sqt:*:*", "system:user:manage"],
  [ROLES.SHOP_OWNER]: [...SHOP_CASE_PERMISSIONS],
  [ROLES.REPAIR_SHOP]: [...SHOP_CASE_PERMISSIONS],
  // InFlow Customer — a portal login for a customer; sees only their statement.
  [ROLES.INFLOW_CUSTOMER]: ["inflow:statement:view"],
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
  ROLE_GROUPS,
  ROLE_GROUP_LABELS,
  ROLE_GROUP_OF,
  ROLE_PERMISSIONS,
  SHOP_SCOPED_ROLES,
  isValidRole,
  getPermissionsForRole,
  isShopScopedRole,
  permissionMatches,
  hasPermission,
};
