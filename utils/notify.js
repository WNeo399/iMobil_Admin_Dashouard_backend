// In-app user notifications.
//
// One document per recipient in `imb_notifications` — keeps per-user unread
// counts and read state trivial. notifyOnStatusChange() is the single hook
// every SQT status-change site calls; to wire a new notification, add an entry
// to NOTIFY_ON_STATUS — no other code changes needed.

const { SHOP_SCOPED_ROLES, ROLES } = require("../constants/roles");

const NOTIF = "imb_notifications";
const USERS = "users";

// Insert one notification per recipient userId. Returns the number written.
async function notifyUsers(db, userIds, payload) {
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return 0;
  const now = new Date();
  const docs = ids.map((userId) => ({
    userId,
    type: payload.type,
    title: payload.title,
    message: payload.message,
    data: payload.data || {},
    read: false,
    readAt: null,
    createdAt: now,
  }));
  const r = await db.collection(NOTIF).insertMany(docs);
  return r.insertedCount || 0;
}

// Resolve a case's shop users (owner + repair-shop staff for that shop) and
// notify each of them.
async function notifyShopForCase(db, caseDoc, payload) {
  if (!caseDoc || !caseDoc.shopId) return 0;
  const recipients = await db
    .collection(USERS)
    .find(
      {
        shopIds: caseDoc.shopId,
        role: { $in: SHOP_SCOPED_ROLES },
        active: { $ne: false },
      },
      { projection: { _id: 1 } },
    )
    .toArray();
  return notifyUsers(
    db,
    recipients.map((u) => u._id),
    payload,
  );
}

// Resolve all active users holding any of the given roles, and notify them.
async function notifyRoles(db, roles, payload) {
  if (!roles || roles.length === 0) return 0;
  const recipients = await db
    .collection(USERS)
    .find(
      { role: { $in: roles }, active: { $ne: false } },
      { projection: { _id: 1 } },
    )
    .toArray();
  return notifyUsers(
    db,
    recipients.map((u) => u._id),
    payload,
  );
}

const RETURN_TRACKER_ROLES = [ROLES.ADMIN, ROLES.TECHELITE_ADMIN];

// Unrepairable / BER / Cancelled all activate return tracking — tell the people
// who chase returns what needs to come back. No-op if nothing's returnable.
function returnRequiredBuild(label) {
  return (c) => {
    const rt = c.returnTracking;
    if (!rt || !rt.active) return null;
    const hasParts = Array.isArray(rt.parts) && rt.parts.length > 0;
    const hasDevice = !!(rt.device && rt.device.expected);
    if (!hasParts && !hasDevice) return null;
    const bits = [];
    if (hasParts) bits.push(`${rt.parts.length} part${rt.parts.length > 1 ? "s" : ""}`);
    if (hasDevice) bits.push("customer device");
    const shop = c.shopName ? ` (${c.shopName})` : "";
    return {
      type: "sqt_return_required",
      title: "Return to collect",
      message: `Case ${c.caseId || "—"}${shop} — ${label}. ${bits.join(" + ")} to collect back.`,
      data: {
        caseId: c.caseId || null,
        sqtCaseId: String(c._id),
        shopId: c.shopId ? String(c.shopId) : null,
        shopName: c.shopName || null,
        status: c.status || null,
      },
    };
  };
}

// Per-status notifications. Each entry has an `audience` (who receives it) and
// a `build` (the payload, derived from the case). Adding a status here is all
// it takes to wire a new notification. build returning null = emit nothing.
//   audience.kind 'shop'  → the case's shop users (owner + repair-shop staff)
//   audience.kind 'roles' → all active users holding any of audience.roles
// `data.sqtCaseId` is the case _id as a string — the frontend deep-links to
// /sqt/cases?openCase=<sqtCaseId> to pop the case detail.
const NOTIFY_ON_STATUS = {
  "waiting-for-parts": {
    audience: { kind: "shop" },
    build: (c) => {
      const dev =
        c.device && (c.device.modelName || c.device.description)
          ? ` (${c.device.modelName || c.device.description})`
          : "";
      return {
        type: "sqt_waiting_for_parts",
        title: "New case to process",
        message: `Case ${c.caseId || "—"}${dev} — parts dispatched. A new case is on its way, please process it.`,
        data: {
          caseId: c.caseId || null,
          sqtCaseId: String(c._id),
          shopId: c.shopId ? String(c.shopId) : null,
          shopName: c.shopName || null,
          status: "waiting-for-parts",
        },
      };
    },
  },
  // A shop has asked for more parts on an in-progress case — tell the people
  // who dispatch parts (Admin + TechElite Admin), with the requested-parts note.
  "require-extra-parts": {
    audience: { kind: "roles", roles: [ROLES.ADMIN, ROLES.TECHELITE_ADMIN] },
    build: (c) => {
      const last =
        Array.isArray(c.statusHistory) && c.statusHistory.length
          ? c.statusHistory[c.statusHistory.length - 1]
          : null;
      const note = last && last.note ? String(last.note).trim() : "";
      const shop = c.shopName ? ` (${c.shopName})` : "";
      return {
        type: "sqt_require_extra_parts",
        title: "Extra parts requested",
        message: `Case ${c.caseId || "—"}${shop} needs extra parts${note ? `: "${note}"` : ""}. Please review and send.`,
        data: {
          caseId: c.caseId || null,
          sqtCaseId: String(c._id),
          shopId: c.shopId ? String(c.shopId) : null,
          shopName: c.shopName || null,
          status: "require-extra-parts",
        },
      };
    },
  },
  unrepairable: {
    audience: { kind: "roles", roles: RETURN_TRACKER_ROLES },
    build: returnRequiredBuild("Unrepairable"),
  },
  ber: {
    audience: { kind: "roles", roles: RETURN_TRACKER_ROLES },
    build: returnRequiredBuild("BER"),
  },
  cancelled: {
    audience: { kind: "roles", roles: RETURN_TRACKER_ROLES },
    build: returnRequiredBuild("Cancelled"),
  },
};

// The single hook every status-change site calls. Emits only on a real
// transition INTO a notifiable status, so repeated saves / webhook echoes of
// the same status can't double-notify.
async function notifyOnStatusChange(db, caseDoc, prevStatus, newStatus) {
  if (!caseDoc || !newStatus || prevStatus === newStatus) return 0;
  const entry = NOTIFY_ON_STATUS[newStatus];
  if (!entry) return 0;
  const payload = entry.build(caseDoc);
  if (!payload) return 0;
  const audience = entry.audience || { kind: "shop" };
  if (audience.kind === "roles") {
    return notifyRoles(db, audience.roles, payload);
  }
  return notifyShopForCase(db, caseDoc, payload);
}

module.exports = {
  NOTIF,
  notifyUsers,
  notifyShopForCase,
  notifyRoles,
  notifyOnStatusChange,
};
