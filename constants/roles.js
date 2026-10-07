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
  // Supplier login — sees the Refurbished Phones market data + the AI Agent
  // (but not the Agent Skills knowledge base).
  PHONE_SUPPLIER: "phone-supplier",
  // Consignment shop login — sees only its own consigned devices; can mark
  // them received / sold and initiate returns.
  CONSIGNMENT_SHOP: "consignment-shop",
  // Purchasing staff — the Purchase Order page + Special Order triage only.
  IMOBILE_PURCHASE: "imobile-purchase",
  // The spare-parts purchase partner (buys from the factories, ships the
  // batches to iMobile) — Spare Parts Purchase only.
  PARTS_SUPPLIER: "parts-supplier",
  IMOBILE_ACCOUNTANT: "imobile-accountant",
  // Warehouse staff — iMobile Spare Parts, Spare Parts Purchase, InFlow and Tools.
  IMOBILE_WAREHOUSE: "imobile-warehouse",
  // Front desk staff — SQT (like TechElite Admin), InFlow, Refurbished Device and Tools.
  IMOBILE_FRONT_DESK: "imobile-front-desk",
};

const ROLE_LABELS = {
  [ROLES.ADMIN]: "Admin",
  [ROLES.IMOBILE_ADMIN]: "iMobile Admin",
  [ROLES.IMOBILE_REPAIR_ADMIN]: "iMobile Repair Admin",
  [ROLES.TECHELITE_ADMIN]: "TechElite Admin",
  [ROLES.SHOP_OWNER]: "Repair Shop Owner",
  [ROLES.REPAIR_SHOP]: "Repair Shop",
  [ROLES.INFLOW_CUSTOMER]: "InFlow Customer",
  [ROLES.PHONE_SUPPLIER]: "Phone Supplier",
  [ROLES.CONSIGNMENT_SHOP]: "Consignment Shop",
  [ROLES.IMOBILE_PURCHASE]: "iMobile Purchase",
  [ROLES.PARTS_SUPPLIER]: "Parts Supplier",
  [ROLES.IMOBILE_ACCOUNTANT]: "iMobile Accountant",
  [ROLES.IMOBILE_WAREHOUSE]: "iMobile Warehouse",
  [ROLES.IMOBILE_FRONT_DESK]: "iMobile Front Desk",
};

// UI grouping for the System → Users role-tree panel. Roles inside the
// same group share a parent node in the tree. Pure presentation — has no
// effect on permission checks.
const ROLE_GROUPS = {
  IMOBILE: "imobile",
  TECHELITE: "techelite",
  INFLOW: "inflow",
  CONSIGNMENT: "consignment",
};

const ROLE_GROUP_LABELS = {
  [ROLE_GROUPS.IMOBILE]: "iMobile",
  [ROLE_GROUPS.TECHELITE]: "TechElite",
  [ROLE_GROUPS.INFLOW]: "InFlow",
  [ROLE_GROUPS.CONSIGNMENT]: "Consignment",
};

const ROLE_GROUP_OF = {
  [ROLES.ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_REPAIR_ADMIN]: ROLE_GROUPS.IMOBILE,
  [ROLES.TECHELITE_ADMIN]: ROLE_GROUPS.TECHELITE,
  [ROLES.SHOP_OWNER]: ROLE_GROUPS.TECHELITE,
  [ROLES.REPAIR_SHOP]: ROLE_GROUPS.TECHELITE,
  [ROLES.INFLOW_CUSTOMER]: ROLE_GROUPS.INFLOW,
  [ROLES.PHONE_SUPPLIER]: ROLE_GROUPS.IMOBILE,
  [ROLES.CONSIGNMENT_SHOP]: ROLE_GROUPS.CONSIGNMENT,
  [ROLES.IMOBILE_PURCHASE]: ROLE_GROUPS.IMOBILE,
  [ROLES.PARTS_SUPPLIER]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_ACCOUNTANT]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_WAREHOUSE]: ROLE_GROUPS.IMOBILE,
  [ROLES.IMOBILE_FRONT_DESK]: ROLE_GROUPS.IMOBILE,
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
  // Upload photo attachments to a case (compressed server-side → S3).
  "sqt:case:attachment",
];

const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: ["*:*:*"],
  // iMobile Admin owns the iMobile-side modules: Zoho Inventory / Tools, the
  // Repair (RepairDesk) page, and the Apple SVP genuine-parts enquiries.
  // InFlow: iMobile Admin can view orders + customers; recording payments is
  // Admin-only (inflow:order:payment, which only "*:*:*" grants).
  // AI assistant ("Ask the Data") is Admin-only for now — deliberately no
  // ai:* grant here, so only the Admin role ("*:*:*") sees the orb / can query.
  // Add "ai:query:use" (or "ai:*:*") here to open it up to iMobile Admin later.
  [ROLES.IMOBILE_ADMIN]: [
    "zoho:*:*", "repair:*:*", "svp:*:*", "po:*:*", "refurb:*:*", "spp:*:*",
    "inflow:order:view", "inflow:customer:view",
    // iMobile Website (banners for the storefront carousel)
    "web:*:*",
  ],
  // iMobile Repair Admin: starts with full Repair access so the role is
  // usable from day one. Other permissions are pending the owner's input.
  [ROLES.IMOBILE_REPAIR_ADMIN]: ["repair:*:*"],
  // TechElite Admin owns the SQT domain. User management (System tab) was
  // revoked 2026-08 — system:user:manage is Admin-only now.
  [ROLES.TECHELITE_ADMIN]: ["sqt:*:*"],
  [ROLES.SHOP_OWNER]: [...SHOP_CASE_PERMISSIONS],
  [ROLES.REPAIR_SHOP]: [...SHOP_CASE_PERMISSIONS],
  // InFlow Customer — a portal login for a customer; sees only their statement.
  [ROLES.INFLOW_CUSTOMER]: ["inflow:statement:view"],
  // Phone Supplier — Refurbished Phones market data + the AI Agent chat.
  // Deliberately NOT ai:skills:manage, so the Agent Skills knowledge base
  // stays hidden from suppliers.
  // Suppliers also hold the Stock page — but devices.js narrows every read
  // and write to the stock source on their user record, so the permission
  // only ever reaches their own shelf.
  [ROLES.PHONE_SUPPLIER]: [
    "refurb:offer:view",
    "ai:query:use",
    "refurb:stock:view",
    "refurb:stock:manage",
    "refurb:supply:view",
    "refurb:supply:manage",
  ],
  // Consignment Shop — scoped to the shop on the user record (consignShopId).
  [ROLES.CONSIGNMENT_SHOP]: [
    "consign:device:view",
    "consign:device:receive",
    "consign:device:sell",
    "consign:device:return",
  ],
  // iMobile Purchase — Spare Parts Purchase (the whole module: the Tencent
  // sheet's Purchase Order page it used was retired 2026-09-23) + Special
  // Order (po:specialOrder:view via the wildcard). Deliberately NOT
  // zoho:salesOrder:create, which would also unlock the Credit Note page.
  [ROLES.IMOBILE_PURCHASE]: ["po:*:*", "spp:*:*"],
  // Parts Supplier — Spare Parts Purchase: sees every order, quotes / places
  // / flags shortages, ships batches. Creating orders and receiving batches
  // stay with iMobile (spp:order:create / spp:order:receive). Since
  // 2026-09-28 also Missing Images: the parts with no image, and uploading
  // images for them (not archiving — that is a stock-edit action).
  [ROLES.PARTS_SUPPLIER]: [
    "spp:order:view",
    "spp:order:supply",
    "spp:batch:view",
    "spp:batch:create",
    "spp:batch:manage",
    "spp:image:view",
    "spp:image:upload",
  ],
  // iMobile Accountant (2026-09-30): the iMobile Accountant menu — what
  // customers owe, from Zoho Inventory. Nobody else holds acct:* (admin
  // sees it through *:*:*). Since 2026-10-05 also InFlow — view orders and
  // customers, and record payments (inflow:order:payment, otherwise
  // Admin-only); no creating orders, no customer portal logins — and the
  // whole Refurbished Device menu: stock, sales, supply batches, repairs
  // (view + manage) and Consignment. Not refurb:offer:view (the ExEngine
  // scraper data) and not refurb:incoming:manage (Incoming Stocks stays
  // Admin / iMobile Admin).
  [ROLES.IMOBILE_ACCOUNTANT]: [
    "acct:*:*",
    "inflow:order:view", "inflow:customer:view", "inflow:order:payment",
    "refurb:stock:view", "refurb:stock:manage",
    "refurb:sale:view", "refurb:sale:manage",
    "refurb:supply:view", "refurb:supply:manage",
    "refurb:repair:view", "refurb:repair:manage",
    "consign:*:*",
  ],
  // iMobile Warehouse (2026-10-05): full access inside four menus —
  // iMobile Spare Parts (stock + price monitoring, collections, catalogue,
  // edits included), Spare Parts Purchase (the whole module), InFlow orders
  // (view + create) and customers, and Tools. Tools' backend needs
  // zoho:salesOrder:create, which also opens iMobile → Credit Note and
  // Special Order (the user agreed). InFlow payments (inflow:order:payment)
  // and customer portal logins (inflow:portal:manage) stay Admin-only. The
  // Tools menu itself is role-gated in the frontend router (meta.roles).
  // zoho:purchaseOrder:create is the Create Purchase Order tool (2026-10-05)
  // — every role with Tools gets it, so no card on that page is a dead end.
  // svp:*:* is Serials Lookup (2026-10-06): the genuine-serial list and the
  // customer enquiries, which moved into the iMobile Spare Parts menu.
  // parts:browse:view is the Browse Items page (2026-10-07) with its price
  // columns — Admin (*:*:*) and iMobile Warehouse only (the user's choice).
  [ROLES.IMOBILE_WAREHOUSE]: [
    "zoho:stock:*", "zoho:collection:*", "zoho:salesOrder:create", "zoho:purchaseOrder:create",
    "svp:*:*",
    "parts:browse:view",
    "spp:*:*",
    "inflow:order:view", "inflow:order:create", "inflow:customer:view",
  ],
  // iMobile Front Desk (2026-10-05): SQT like TechElite Admin (every action,
  // and the admin-side view the frontend / the group filter give by role:
  // SQT_ADMIN_SIDE_ROLES in sqt/cases, GROUP_FILTER_ROLES in sqtRoutes/cases;
  // not the Admin-only Service Report or Shops → Users), InFlow view +
  // create orders + record payments (portal logins stay Admin-only), the
  // whole Refurbished Device menu like iMobile Accountant (not the ExEngine
  // scraper data or Incoming Stocks), and Tools (zoho:salesOrder:create —
  // also opens Credit Note / Special Order; the user agreed). The Tools menu
  // itself is role-gated in the frontend router (meta.roles). Tools also
  // brings zoho:purchaseOrder:create (the Create Purchase Order tool).
  [ROLES.IMOBILE_FRONT_DESK]: [
    "sqt:*:*",
    "inflow:order:view", "inflow:customer:view", "inflow:order:create", "inflow:order:payment",
    "refurb:stock:view", "refurb:stock:manage",
    "refurb:sale:view", "refurb:sale:manage",
    "refurb:supply:view", "refurb:supply:manage",
    "refurb:repair:view", "refurb:repair:manage",
    "consign:*:*",
    "zoho:salesOrder:create", "zoho:purchaseOrder:create",
  ],
};

// Roles whose data is scoped to the shops listed on their user record.
const SHOP_SCOPED_ROLES = [ROLES.SHOP_OWNER, ROLES.REPAIR_SHOP];

// Roles one account may hold TOGETHER (user 2026-10-05): the roles under
// iMobile in the Users page's role tree — Admin, iMobile Admin, iMobile
// Repair Admin, Phone Supplier, iMobile Purchase, Parts Supplier, iMobile
// Accountant, iMobile Warehouse, iMobile Front Desk — with each other. An
// account's roles live in `roles` on the user record, main role first;
// `role` stays as that main role, and a record without `roles` simply
// holds `[role]` — so nothing had to be migrated. The roles of the other
// groups (TechElite, InFlow, Consignment) stay an account's ONLY role: the
// shop / customer ones narrow the account to its own shops or customer, and
// code checks them with `req.user.role === …`.
const COMBINABLE_ROLES = Object.values(ROLES).filter(
  (r) => ROLE_GROUP_OF[r] === ROLE_GROUPS.IMOBILE,
);

function isValidRole(role) {
  return Object.values(ROLES).includes(role);
}

function isCombinableRole(role) {
  return COMBINABLE_ROLES.includes(role);
}

// Why this list of roles can't be saved on one account, or null when it can.
function roleSetError(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return "Invalid role";
  if (!roles.every(isValidRole)) return "Invalid role";
  if (roles.length > 1) {
    const single = roles.filter((r) => !isCombinableRole(r));
    if (single.length) {
      return `${single.map((r) => ROLE_LABELS[r] || r).join(", ")} can't be combined with other roles — only the roles under iMobile can`;
    }
  }
  return null;
}

// The roles a user record holds, main role first. A stored list that breaks
// the iMobile-only rule (it can only get there by hand) falls back to the
// main role alone, so a shop / customer role is never widened.
function rolesOfUser(user) {
  if (!user) return [];
  const extra = Array.isArray(user.roles) ? user.roles : [];
  const all = [...new Set([user.role, ...extra].filter(Boolean))];
  if (all.length > 1 && !all.every(isCombinableRole)) return [all[0]];
  return all;
}

function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : [];
}

// Everything any of the roles allows.
function getPermissionsForRoles(roles) {
  return [...new Set((roles || []).flatMap((r) => ROLE_PERMISSIONS[r] || []))];
}

// Does the user (req.user, or a user record) hold this role — as its main
// role or any other?
function userHasRole(user, role) {
  return rolesOfUser(user).includes(role);
}

// Is the user working as a PHONE SUPPLIER on the Refurbished Device pages —
// narrowed to the stock source on their record, with the supplier's view of
// a device? Yes when they hold that role and none of their OTHER roles opens
// the stock register by itself: an account's roles add up, so a Phone
// Supplier who is also Admin / iMobile Admin / Accountant / Front Desk works
// the whole register like any staff member, while Phone Supplier + Parts
// Supplier (or Purchase, Warehouse…) stays on its own shelf.
function actsAsPhoneSupplier(user) {
  const roles = rolesOfUser(user);
  if (!roles.includes(ROLES.PHONE_SUPPLIER)) return false;
  return !roles.some(
    (r) => r !== ROLES.PHONE_SUPPLIER && hasPermission(ROLE_PERMISSIONS[r] || [], "refurb:stock:view"),
  );
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
  COMBINABLE_ROLES,
  isValidRole,
  isCombinableRole,
  roleSetError,
  rolesOfUser,
  userHasRole,
  actsAsPhoneSupplier,
  getPermissionsForRole,
  getPermissionsForRoles,
  isShopScopedRole,
  permissionMatches,
  hasPermission,
};
