// Aggregated summary endpoints powering the role-aware Home page.
//
// Three thin endpoints, each gated by the lowest permission a viewer of that
// dashboard would already hold:
//   /sqt   — TechElite Admin / Admin / Shop roles  (sqt:case:list)
//   /shop  — Shop Owner / Repair Shop              (sqt:case:list, shop-scoped)
//   /zoho  — iMobile Admin / Admin                 (zoho:stock:view)
//
// All Mongo queries reuse the same shop-scoping convention as /sqt/cases so
// shop-scoped users automatically see only their own shops.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const CASES_COLLECTION = "sqt_cases";
const SHOPS_COLLECTION = "sqt_shops";
const USERS_COLLECTION = "users";

const VALID_STATUSES = [
  "on-hold",
  "pending",
  "waiting-for-parts",
  "parts-arrived",
  "waiting-for-drop-off",
  "repairing",
  "repaired",
  "repaired-and-collected",
  "waiting-solvup",
  "unrepairable",
  "ber",
  "completed",
  "cancelled",
];

// Statuses where a case is still "open" (not finalized). Admin / TechElite
// see the broader list — including Waiting Solvup which is their queue to
// process. Shop roles see a narrower window: Pending → Repaired only. Cases
// in admin-side states (waiting-solvup, on-hold) are hidden from the shop
// list elsewhere; keeping their "open" KPI consistent with that.
const OPEN_STATUSES = [
  "pending",
  "waiting-for-parts",
  "parts-arrived",
  "waiting-for-drop-off",
  "repairing",
  "repaired",
  "waiting-solvup",
];
const SHOP_OPEN_STATUSES = [
  "pending",
  "waiting-for-parts",
  "parts-arrived",
  "waiting-for-drop-off",
  "repairing",
  "repaired",
];

// Statuses where the shop side is the next actor.
const SHOP_ACTION_STATUSES = ["parts-arrived", "waiting-for-drop-off", "repairing", "repaired"];

function applyShopScope(req, query) {
  const ids = req.user && req.user.accessibleShopIds;
  if (!Array.isArray(ids)) return query;
  query.shopId = { $in: ids };
  return query;
}

// ── /sqt ──────────────────────────────────────────────────────────────────────
// SQT dashboard for Admin / TechElite Admin / Shop roles.
// Returns:
//   totals       counts by status (incl. total + open)
//   recent       latest 10 cases (lightweight projection)
//   aging        cases older than 14 days, not collected (max 10)
//   weekly       newly-created cases per day for last 7 days
router.get("/sqt", requirePermission("sqt:case:list"), async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const col = db.collection(CASES_COLLECTION);

    const scope = applyShopScope(req, {});

    // counts by status
    const countsAgg = await col
      .aggregate([
        ...(Object.keys(scope).length ? [{ $match: scope }] : []),
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ])
      .toArray();

    const byStatus = {};
    for (const s of VALID_STATUSES) byStatus[s] = 0;
    let total = 0;
    for (const row of countsAgg) {
      if (row._id) {
        byStatus[row._id] = row.count;
        total += row.count;
      }
    }
    // Shop-scoped users get the narrower Pending → Repaired definition.
    const openStatusesForUser = Array.isArray(req.user && req.user.accessibleShopIds)
      ? SHOP_OPEN_STATUSES
      : OPEN_STATUSES;
    const open = openStatusesForUser.reduce((sum, s) => sum + (byStatus[s] || 0), 0);

    // recent cases — last 10
    const recent = await col
      .find(scope, {
        projection: {
          serviceRequestId: 1,
          caseId: 1,
          status: 1,
          shopName: 1,
          createdAt: 1,
          "customer.firstName": 1,
          "customer.lastName": 1,
          "device.description": 1,
          "device.modelName": 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    // Historical cases were imported with `createdAt` as an ISO string instead
    // of a BSON Date, so `$gte`/`$lt` against a JS Date silently misses them.
    // We coerce with `$toDate` in the pipeline — it passes Dates through and
    // parses ISO strings — so both insertion paths behave identically.

    // aging — older than 14 days and still open
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const aging = await col
      .aggregate([
        { $match: { ...scope, status: { $in: OPEN_STATUSES } } },
        { $addFields: { _createdAt: { $toDate: "$createdAt" } } },
        { $match: { _createdAt: { $lt: fourteenDaysAgo } } },
        { $sort: { _createdAt: 1 } },
        { $limit: 10 },
        {
          $project: {
            serviceRequestId: 1,
            caseId: 1,
            status: 1,
            shopName: 1,
            createdAt: 1,
            "customer.firstName": 1,
            "customer.lastName": 1,
          },
        },
      ])
      .toArray();

    // weekly — created-count per day for last 7 days
    const sevenDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const weeklyAgg = await col
      .aggregate([
        ...(Object.keys(scope).length ? [{ $match: scope }] : []),
        { $addFields: { _createdAt: { $toDate: "$createdAt" } } },
        { $match: { _createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$_createdAt" } },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const weeklyMap = {};
    for (const row of weeklyAgg) weeklyMap[row._id] = row.count;
    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      weekly.push({ date: key, count: weeklyMap[key] || 0 });
    }

    return res.json({
      success: true,
      data: { totals: { total, open, byStatus }, recent, aging, weekly },
    });
  } catch (error) {
    console.error("Dashboard /sqt error:", error);
    return res.status(500).json({ success: false, message: "Failed to load dashboard" });
  }
});

// ── /shop ─────────────────────────────────────────────────────────────────────
// Per-shop breakdown for Shop Owners. Returns a row per accessible shop with
// open / parts-received / awaiting-collection / repaired-this-month counts.
router.get("/shop", requirePermission("sqt:case:list"), async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const col = db.collection(CASES_COLLECTION);

    const ids = req.user && req.user.accessibleShopIds;

    // Unscoped roles (admin, techelite) get nothing useful from this endpoint;
    // they have the /sqt aggregate already. Return empty rather than scanning.
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.json({ success: true, data: { shops: [], actionQueue: [] } });
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const shopDocs = await db
      .collection(SHOPS_COLLECTION)
      .find({ _id: { $in: ids } }, { projection: { storeName: 1 } })
      .toArray();

    const breakdown = await col
      .aggregate([
        { $match: { shopId: { $in: ids } } },
        {
          $group: {
            _id: "$shopId",
            // Shop view: Pending → Repaired only. Mirrors what /dashboard/sqt
            // returns to shop users so the per-shop breakdown column sums to
            // the same "open" KPI shown at the top of their home.
            open: {
              $sum: {
                $cond: [{ $in: ["$status", SHOP_OPEN_STATUSES] }, 1, 0],
              },
            },
            partsReceived: {
              $sum: { $cond: [{ $eq: ["$status", "parts-arrived"] }, 1, 0] },
            },
            awaitingCollection: {
              $sum: { $cond: [{ $eq: ["$status", "repaired"] }, 1, 0] },
            },
            repairedThisMonth: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$status", ["repaired", "repaired-and-collected"]] },
                      { $gte: ["$updatedAt", startOfMonth] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .toArray();
    const byShop = {};
    for (const row of breakdown) byShop[String(row._id)] = row;

    const shops = shopDocs.map((s) => {
      const r = byShop[String(s._id)] || {};
      return {
        shopId: s._id,
        shopName: s.storeName,
        open: r.open || 0,
        partsReceived: r.partsReceived || 0,
        awaitingCollection: r.awaitingCollection || 0,
        repairedThisMonth: r.repairedThisMonth || 0,
      };
    });

    // Action queue — cases where the shop is the next actor (up to 15)
    const actionQueue = await col
      .find(
        {
          shopId: { $in: ids },
          status: { $in: SHOP_ACTION_STATUSES },
        },
        {
          projection: {
            serviceRequestId: 1,
            caseId: 1,
            status: 1,
            shopName: 1,
            createdAt: 1,
            "customer.firstName": 1,
            "customer.lastName": 1,
            "device.description": 1,
            "device.modelName": 1,
          },
        }
      )
      .sort({ createdAt: 1 })
      .limit(15)
      .toArray();

    return res.json({ success: true, data: { shops, actionQueue } });
  } catch (error) {
    console.error("Dashboard /shop error:", error);
    return res.status(500).json({ success: false, message: "Failed to load shop dashboard" });
  }
});

// ── /admin ────────────────────────────────────────────────────────────────────
// Extra counts only the Admin home wants (shop count, user count). Kept tiny.
router.get("/admin", requirePermission("system:user:manage"), async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const [shopCount, userCount] = await Promise.all([
      db.collection(SHOPS_COLLECTION).countDocuments({}),
      db.collection(USERS_COLLECTION).countDocuments({ active: { $ne: false } }),
    ]);
    return res.json({ success: true, data: { shopCount, userCount } });
  } catch (error) {
    console.error("Dashboard /admin error:", error);
    return res.status(500).json({ success: false, message: "Failed to load admin counts" });
  }
});

module.exports = router;
