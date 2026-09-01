// Consignment — devices placed with partner shops on consignment.
//
// Devices come from the Refurbished Device stock register (refurb_devices),
// resolved by IMEI / serial — the same pool a sales order draws from.
// Records assigned before that change carry EX_DB stock ids instead of a
// register reference; both shapes coexist in consignment_devices.
//
// Flow: admin assigns devices in batch to a shop (status "in-transit") → the
// shop's own login marks them "received" → marks each "sold" as they sell →
// or initiates a return ("returning") which admin closes out as "returned"
// when the stock arrives back. Weekly, admin raises an invoice per shop for
// the devices sold (all sold-and-uninvoiced up to the end of last week).
//
// Data:
//   consignment_shops    { name, active, createdAt }
//   consignment_devices  { shopId, batchId, model, imei, costPrice,
//                          shopPrice (what invoices bill), retailPrice,
//                          status,
//                          assignedAt/receivedAt/soldAt/returnAt/returnedAt,
//                          invoiceId, statusHistory[] }
//   consignment_invoices { number, shopId, shopName, periodStart, periodEnd,
//                          deviceIds, deviceCount, total, createdAt, createdBy }
//   Shop logins live in the normal `users` collection with
//   role "consignment-shop" + consignShopId.
//
// Consignment-shop users are hard-scoped to their consignShopId on every
// device endpoint; admin (wildcard) sees everything.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { hashPassword } = require("../../utils/authToken");
const { ROLES } = require("../../constants/roles");

const SHOPS = "consignment_shops";
const DEVICES = "consignment_devices";
const INVOICES = "consignment_invoices";

const MANAGE = requirePermission("consign:shop:manage");
const ASSIGN = requirePermission("consign:device:assign");
const DEVICE_VIEW = requirePermission("consign:device:view");
const INSIGHT = requirePermission("consign:insight:view");

const STATUSES = ["in-transit", "received", "sold", "returning", "returned"];

// Allowed transitions: action → { from, to, permission, timestampField }
const TRANSITIONS = {
  receive: { from: ["in-transit"], to: "received", perm: "consign:device:receive", stamp: "receivedAt" },
  sell: { from: ["received"], to: "sold", perm: "consign:device:sell", stamp: "soldAt" },
  return: { from: ["received"], to: "returning", perm: "consign:device:return", stamp: "returnAt" },
  markReturned: { from: ["returning"], to: "returned", perm: "consign:device:markReturned", stamp: "returnedAt" },
};

const { hasPermission } = require("../../constants/roles");
const {
  STATUS_IN_STOCK,
  STATUS_NOT_RECEIVED,
  STATUS_ON_CONSIGNMENT,
  LOCATION_IMOBILE,
} = require("../refurbishedRoutes/stockSource");
// Consigning an unreceived unit proves its shipment arrived, same as
// selling one does.
const { receiveLinesForDevices } = require("../refurbishedRoutes/incoming");
const REFURB_DEVICES = "refurb_devices";

function oid(v) {
  try { return new ObjectId(String(v)); } catch (e) { return null; }
}

function actorOf(req) {
  return (req.user && (req.user.username || req.user.email)) || null;
}

// The Melbourne-local previous week (Mon 00:00 → next Mon 00:00) as real Date
// instants. Uses the wall-clock shift trick — fine at weekly granularity.
function previousMelbourneWeek(now = new Date()) {
  const mel = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" }));
  const offsetMs = now.getTime() - mel.getTime();
  const day = (mel.getDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(mel.getFullYear(), mel.getMonth(), mel.getDate() - day);
  const prevMonday = new Date(thisMonday.getTime() - 7 * 86400000);
  const label = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    start: new Date(prevMonday.getTime() + offsetMs),
    end: new Date(thisMonday.getTime() + offsetMs), // exclusive
    startLabel: label(prevMonday),
    endLabel: label(new Date(thisMonday.getTime() - 86400000)), // inclusive Sunday
  };
}

// Scope filter for the current user: consignment-shop logins only ever see
// their own shop's devices; everyone else (admin) passes through.
function shopScope(req) {
  if (req.user && req.user.role === ROLES.CONSIGNMENT_SHOP) {
    return req.user.consignShopId ? oid(req.user.consignShopId) : oid("000000000000000000000000");
  }
  return null;
}

// ── Shops ───────────────────────────────────────────────────────────

router.get("/shops", MANAGE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const shops = await db.collection(SHOPS).find({}).sort({ name: 1 }).toArray();
    // Device counts by status per shop + uninvoiced sold value.
    const agg = await db.collection(DEVICES).aggregate([
      { $group: {
        _id: { shopId: "$shopId", status: "$status" },
        n: { $sum: 1 },
        value: { $sum: { $ifNull: ["$shopPrice", 0] } },
        uninvoiced: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "sold"] }, { $not: ["$invoiceId"] }] }, 1, 0] } },
        uninvoicedValue: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "sold"] }, { $not: ["$invoiceId"] }] }, { $ifNull: ["$shopPrice", 0] }, 0] } },
      } },
    ]).toArray();
    const byShop = {};
    for (const r of agg) {
      const sid = String(r._id.shopId);
      if (!byShop[sid]) byShop[sid] = { counts: {}, uninvoicedSold: 0, uninvoicedValue: 0 };
      byShop[sid].counts[r._id.status] = r.n;
      byShop[sid].uninvoicedSold += r.uninvoiced;
      byShop[sid].uninvoicedValue += r.uninvoicedValue;
    }
    // Login counts per shop.
    const logins = await db.collection("users").aggregate([
      { $match: { role: ROLES.CONSIGNMENT_SHOP } },
      { $group: { _id: "$consignShopId", n: { $sum: 1 } } },
    ]).toArray();
    const loginCount = {};
    for (const l of logins) loginCount[String(l._id)] = l.n;

    return res.json({
      success: true,
      shops: shops.map((s) => ({
        ...s,
        stats: byShop[String(s._id)] || { counts: {}, uninvoicedSold: 0, uninvoicedValue: 0 },
        loginCount: loginCount[String(s._id)] || 0,
      })),
    });
  } catch (e) {
    console.error("consignment shops error:", e);
    return res.status(500).json({ success: false, message: "Failed to load shops" });
  }
});

router.post("/shops", MANAGE, async function (req, res) {
  try {
    const name = String((req.body && req.body.name) || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Shop name is required." });
    const db = await connectToDatabase();
    const dupe = await db.collection(SHOPS).findOne({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
    if (dupe) return res.status(400).json({ success: false, message: "A shop with that name already exists." });
    const doc = { name, active: true, createdAt: new Date(), createdBy: actorOf(req) };
    const r = await db.collection(SHOPS).insertOne(doc);
    return res.json({ success: true, shop: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("consignment shop create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create shop" });
  }
});

router.put("/shops/:id", MANAGE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const set = { updatedAt: new Date() };
    if (req.body.name != null) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, message: "Shop name cannot be empty." });
      set.name = name;
    }
    if (req.body.active != null) set.active = req.body.active !== false;
    const db = await connectToDatabase();
    const r = await db.collection(SHOPS).updateOne({ _id }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Shop not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("consignment shop update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update shop" });
  }
});

// ── Shop logins (users with role consignment-shop) ──────────────────

router.get("/shops/:id/logins", MANAGE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const logins = await db.collection("users")
      .find({ role: ROLES.CONSIGNMENT_SHOP, consignShopId: String(_id) })
      .project({ passwordHash: 0 })
      .sort({ username: 1 })
      .toArray();
    return res.json({ success: true, logins });
  } catch (e) {
    console.error("consignment logins error:", e);
    return res.status(500).json({ success: false, message: "Failed to load logins" });
  }
});

router.post("/shops/:id/logins", MANAGE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const username = String((req.body && req.body.username) || "").trim();
    const password = String((req.body && req.body.password) || "");
    const name = String((req.body && req.body.name) || "").trim();
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "username and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }
    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ _id });
    if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });
    const dupe = await db.collection("users").findOne({ username });
    if (dupe) return res.status(400).json({ success: false, message: "That username is already taken." });
    const doc = {
      username,
      name: name || shop.name,
      role: ROLES.CONSIGNMENT_SHOP,
      consignShopId: String(_id),
      passwordHash: await hashPassword(password),
      active: true,
      createdAt: new Date(),
      createdBy: actorOf(req),
    };
    const r = await db.collection("users").insertOne(doc);
    delete doc.passwordHash;
    return res.json({ success: true, login: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("consignment login create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create login" });
  }
});

router.post("/logins/:id/resetPassword", MANAGE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const password = String((req.body && req.body.password) || "");
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }
    const db = await connectToDatabase();
    const r = await db.collection("users").updateOne(
      { _id, role: ROLES.CONSIGNMENT_SHOP },
      { $set: { passwordHash: await hashPassword(password), updatedAt: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Login not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("consignment reset error:", e);
    return res.status(500).json({ success: false, message: "Failed to reset password" });
  }
});

// ── Devices ─────────────────────────────────────────────────────────

// List — shop logins are scoped to their own shop; admin filters freely.
router.get("/devices", DEVICE_VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 500);

    const match = {};
    const scope = shopScope(req);
    if (scope) match.shopId = scope;
    else if (req.query.shopId) {
      const sid = oid(req.query.shopId);
      if (sid) match.shopId = sid;
    }
    if (req.query.status && STATUSES.includes(req.query.status)) match.status = req.query.status;
    if (req.query.batchId) match.batchId = String(req.query.batchId);
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      match.$or = [{ productName: rx }, { imei: rx }, { stockId: rx }, { sku: rx }];
    }

    const col = db.collection(DEVICES);
    const total = await col.countDocuments(match);
    // Shop logins never see our internal costs — only the Sales Price
    // (`price`). Enforced here, not just hidden in the UI.
    const projection = scope ? { costPrice: 0, deviceCost: 0, systemPrice: 0 } : {};
    const rows = await col.find(match).project(projection).sort({ assignedAt: -1, _id: -1 })
      .skip((page - 1) * pageSize).limit(pageSize).toArray();

    // Status counts within the current scope (ignoring the status filter) so
    // the page can show tabs/KPIs.
    const countMatch = { ...match };
    delete countMatch.status;
    const counts = {};
    const agg = await col.aggregate([{ $match: countMatch }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
    for (const r of agg) counts[r._id] = r.n;

    // Attach shop names for the admin view.
    const shopIds = [...new Set(rows.map((r) => String(r.shopId)))].map((s) => oid(s)).filter(Boolean);
    const shops = shopIds.length
      ? await db.collection(SHOPS).find({ _id: { $in: shopIds } }).project({ name: 1 }).toArray()
      : [];
    const shopName = {};
    for (const s of shops) shopName[String(s._id)] = s.name;
    return res.json({
      success: true, page, pageSize, total, counts,
      rows: rows.map((r) => ({ ...r, shopName: shopName[String(r.shopId)] || "" })),
    });
  } catch (e) {
    console.error("consignment devices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load devices" });
  }
});

// Resolve IMEIs / serials against the Refurbished Device stock register
// (admin). Consignment draws from the same pool a sales order does: our own
// register, not the ExEngine database — the rule for what may go out is the
// sales-order rule (In Stock or Not Yet Received sells; a unit that is
// Sold, Repairing or With Supplier is not ours to place).
// Body: { codes: [...] } → { devices: [{stockId, imei, productName, grade,
// costPrice, ...}], notFound: [], rejected: [{code, reason}], alreadyOut: [] }
router.post("/devices/lookup", ASSIGN, async function (req, res) {
  try {
    const codes = [
      ...new Set(
        (Array.isArray(req.body && req.body.codes) ? req.body.codes : [])
          .map((c) => String(c || "").replace(/[\s-]/g, "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!codes.length) return res.status(400).json({ success: false, message: "No IMEIs / serials provided." });
    if (codes.length > 500) return res.status(400).json({ success: false, message: "Too many codes (max 500)." });

    const db = await connectToDatabase();
    // The register files serials under `imei` too, but older records may
    // carry a separate serialNumber — match either.
    const rows = await db.collection("refurb_devices")
      .find({ $or: [{ imei: { $in: codes } }, { serialNumber: { $in: codes } }] })
      .toArray();

    const norm = (v) => String(v == null ? "" : v).trim().toUpperCase();
    const byKey = new Map();
    for (const r of rows) {
      if (r.imei) byKey.set(norm(r.imei), r);
      if (r.serialNumber) byKey.set(norm(r.serialNumber), r);
    }

    const found = new Map(); // imei -> register doc
    const notFound = [];
    const rejected = [];
    for (const c of codes) {
      const hit = byKey.get(c);
      if (!hit) {
        notFound.push(c);
        continue;
      }
      const status = hit.status || "In Stock";
      if (status === "Sold" || status === "Repairing" || status === "With Supplier" ||
          status === "Out for Repair" || status === STATUS_ON_CONSIGNMENT) {
        rejected.push({ code: c, reason: `${hit.imei} is ${status} — not available to assign` });
        continue;
      }
      found.set(String(hit.imei), hit);
    }

    // Which of these are already out on consignment (not yet returned)?
    // New records key on the IMEI; older EX_DB-era records carried their
    // own stock ids but also stored the IMEI, so check both fields.
    const keys = [...found.keys()];
    const out = keys.length
      ? await db.collection(DEVICES)
          .find({
            $or: [{ stockId: { $in: keys } }, { imei: { $in: keys } }],
            status: { $nin: ["returned"] },
          })
          .project({ stockId: 1, imei: 1 }).toArray()
      : [];
    const outKeys = new Set(out.flatMap((d) => [d.stockId, d.imei].filter(Boolean).map(norm)));

    const devices = [...found.values()].map((d) => ({
      // The IMEI doubles as the stock id: it is the register's key and
      // what the batch pages display and guard on.
      stockId: String(d.imei),
      imei: String(d.imei),
      refurbDeviceId: String(d._id),
      sku: "",
      productName: [d.model, d.storage, d.color].filter(Boolean).join(" · ") || String(d.imei),
      grade: String(d.grade || "").trim(),
      costPrice: Number.isFinite(Number(d.costPrice)) ? Number(d.costPrice) : null,
      stockStatus: d.status || "In Stock",
      zoneStatus: d.location || "",
      alreadyOut: outKeys.has(norm(d.imei)),
    }));

    return res.json({
      success: true,
      devices,
      notFound,
      rejected,
      alreadyOut: devices.filter((d) => d.alreadyOut).map((d) => d.stockId),
    });
  } catch (e) {
    console.error("consignment lookup error:", e);
    return res.status(502).json({ success: false, message: e.message || "Stock lookup failed" });
  }
});

// Batch assign (admin) — devices resolved via /devices/lookup:
// [{ stockId, imei, refurbDeviceId, sku, productName, grade, costPrice, shopPrice }]
// shopPrice is the shop's cost: what they see and what the weekly invoice
// bills. retailPrice (what the shop charges the customer) starts null and
// is theirs to set later.
router.post("/devices/assign", ASSIGN, async function (req, res) {
  try {
    const shopId = oid(req.body && req.body.shopId);
    const list = Array.isArray(req.body && req.body.devices) ? req.body.devices : [];
    if (!shopId) return res.status(400).json({ success: false, message: "shopId is required" });
    if (!list.length) return res.status(400).json({ success: false, message: "No devices provided." });
    if (list.length > 500) return res.status(400).json({ success: false, message: "Too many devices (max 500 per batch)." });

    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ _id: shopId });
    if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });

    const now = new Date();
    const by = actorOf(req);
    const batchId = new ObjectId().toHexString();
    const docs = [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i] || {};
      const stockId = String(d.stockId || "").trim();
      const productName = String(d.productName || "").trim();
      if (!stockId) return res.status(400).json({ success: false, message: `Device ${i + 1}: stockId is required.` });
      if (!productName) return res.status(400).json({ success: false, message: `Device ${i + 1}: productName is required.` });
      const num = (v) => (v != null && String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
      const shopPrice = num(d.shopPrice);
      if (shopPrice == null || shopPrice < 0) {
        return res.status(400).json({ success: false, message: `Device ${i + 1} (${stockId}): a valid Shop Price is required.` });
      }
      docs.push({
        shopId, batchId,
        stockId,
        imei: String(d.imei || "").trim(),
        // Back-reference to the stock register record the device came
        // from, so a future status sync has something to key on.
        refurbDeviceId: String(d.refurbDeviceId || "").trim() || null,
        sku: String(d.sku || "").trim(),
        productName,
        grade: String(d.grade || "").trim(),
        costPrice: num(d.costPrice),
        // The shop's cost: what they see and what the weekly invoice bills.
        shopPrice,
        // What the shop sells for — theirs to set from their dashboard.
        retailPrice: null,
        status: "in-transit",
        assignedAt: now, assignedBy: by,
        invoiceId: null,
        statusHistory: [{ status: "in-transit", at: now, by }],
      });
    }
    // Guard: any of these devices still out on consignment (not returned)?
    // Checked by stock id AND imei, since register-sourced records key on
    // the IMEI while EX_DB-era ones carried their own stock ids.
    const guardKeys = [...new Set(docs.flatMap((d) => [d.stockId, d.imei].filter(Boolean)))];
    const dupes = await db.collection(DEVICES)
      .find({
        $or: [{ stockId: { $in: guardKeys } }, { imei: { $in: guardKeys } }],
        status: { $nin: ["returned"] },
      })
      .project({ stockId: 1 }).toArray();
    if (dupes.length) {
      return res.status(400).json({
        success: false,
        message: `Already out on consignment: ${[...new Set(dupes.map((d) => d.stockId))].slice(0, 5).join(", ")}`,
      });
    }
    await db.collection(DEVICES).insertMany(docs);

    // The register follows: these units are still ours, but they are on
    // a partner's shelf now — not sellable on a sales order, not
    // assignable twice. Best-effort after the batch is written: a
    // register hiccup must not lose the consignment record.
    let registerUpdated = 0;
    try {
      const refurbIds = docs.map((d) => oid(d.refurbDeviceId)).filter(Boolean);
      if (refurbIds.length) {
        const regDevices = await db.collection(REFURB_DEVICES)
          .find({ _id: { $in: refurbIds } }).toArray();
        const r = await db.collection(REFURB_DEVICES).updateMany(
          // Guarded on still being assignable, so a unit sold in the
          // race window is reported (count mismatch) rather than moved.
          { _id: { $in: refurbIds }, status: { $in: [STATUS_IN_STOCK, STATUS_NOT_RECEIVED, null] } },
          {
            $set: { status: STATUS_ON_CONSIGNMENT, location: shop.name, updatedAt: now },
            $push: {
              history: {
                $each: [{ at: now, by, action: `Assigned to ${shop.name} on consignment` }],
                $slice: -100,
              },
            },
          },
        );
        registerUpdated = r.modifiedCount;
        if (registerUpdated !== refurbIds.length) {
          console.warn(`consignment assign: ${refurbIds.length - registerUpdated} register record(s) not updated (status changed underneath)`);
        }
        // A unit consigned straight off a shipment has evidently arrived.
        const unreceived = regDevices.filter((d) => d.status === STATUS_NOT_RECEIVED);
        if (unreceived.length) {
          await receiveLinesForDevices(db, unreceived, by, `Received by consigning to ${shop.name}`);
        }
      }
    } catch (e) {
      console.error("consignment assign: register update failed:", e && e.message);
    }
    await Promise.all([
      db.collection(DEVICES).createIndex({ shopId: 1, status: 1 }),
      db.collection(DEVICES).createIndex({ batchId: 1 }),
      db.collection(DEVICES).createIndex({ stockId: 1 }),
      db.collection(DEVICES).createIndex({ imei: 1 }),
    ]).catch(() => {});
    return res.json({ success: true, batchId, assigned: docs.length, registerUpdated, shopName: shop.name });
  } catch (e) {
    console.error("consignment assign error:", e);
    return res.status(500).json({ success: false, message: "Failed to assign devices" });
  }
});

// Status transitions — bulk: { action, ids: [] }
router.post("/devices/updateStatus", DEVICE_VIEW, async function (req, res) {
  try {
    const action = String((req.body && req.body.action) || "");
    const t = TRANSITIONS[action];
    if (!t) return res.status(400).json({ success: false, message: "Unknown action." });
    if (!hasPermission(req.user.permissions, t.perm)) {
      return res.status(403).json({ success: false, message: "Not allowed." });
    }
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(oid).filter(Boolean);
    if (!ids.length) return res.status(400).json({ success: false, message: "No devices selected." });

    const db = await connectToDatabase();
    const match = { _id: { $in: ids }, status: { $in: t.from } };
    const scope = shopScope(req);
    if (scope) match.shopId = scope;

    const now = new Date();
    const by = actorOf(req);
    const r = await db.collection(DEVICES).updateMany(match, {
      $set: { status: t.to, [t.stamp]: now, updatedAt: now },
      $push: { statusHistory: { status: t.to, at: now, by } },
    });

    // The register follows the two transitions that end a consignment:
    // sold stays sold, returned comes home. Guarded on the register
    // still saying On Consignment, so nothing else is clobbered.
    if (r.modifiedCount && (action === "sell" || action === "markReturned")) {
      try {
        const moved = await db.collection(DEVICES)
          .find({ _id: { $in: ids }, status: t.to })
          .project({ refurbDeviceId: 1, shopId: 1 }).toArray();
        const refurbIds = moved.map((d) => oid(d.refurbDeviceId)).filter(Boolean);
        if (refurbIds.length) {
          const shopDoc = await db.collection(SHOPS).findOne({ _id: moved[0].shopId });
          const shopName = (shopDoc && shopDoc.name) || "consignment";
          const $set =
            action === "sell"
              ? { status: "Sold", updatedAt: now }
              : { status: STATUS_IN_STOCK, location: LOCATION_IMOBILE, updatedAt: now };
          const note =
            action === "sell"
              ? `Sold on consignment at ${shopName}`
              : `Returned from consignment at ${shopName}`;
          await db.collection(REFURB_DEVICES).updateMany(
            { _id: { $in: refurbIds }, status: STATUS_ON_CONSIGNMENT },
            {
              $set,
              $push: { history: { $each: [{ at: now, by, action: note }], $slice: -100 } },
            },
          );
        }
      } catch (e) {
        console.error("consignment updateStatus: register update failed:", e && e.message);
      }
    }
    return res.json({
      success: true,
      updated: r.modifiedCount,
      skipped: ids.length - r.modifiedCount, // wrong status / other shop
      status: t.to,
    });
  } catch (e) {
    console.error("consignment updateStatus error:", e);
    return res.status(500).json({ success: false, message: "Failed to update devices" });
  }
});

// ── Insights (admin) ────────────────────────────────────────────────

router.get("/insights", INSIGHT, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const col = db.collection(DEVICES);

    const byStatus = {};
    const statusAgg = await col.aggregate([
      { $group: { _id: "$status", n: { $sum: 1 }, value: { $sum: { $ifNull: ["$shopPrice", 0] } } } },
    ]).toArray();
    for (const r of statusAgg) byStatus[r._id] = { count: r.n, value: Math.round(r.value * 100) / 100 };

    const uninvoiced = await col.aggregate([
      { $match: { status: "sold", invoiceId: null } },
      { $group: { _id: null, n: { $sum: 1 }, value: { $sum: { $ifNull: ["$shopPrice", 0] } } } },
    ]).toArray();

    // Per-shop summary.
    const perShopAgg = await col.aggregate([
      { $group: { _id: { shopId: "$shopId", status: "$status" }, n: { $sum: 1 }, value: { $sum: { $ifNull: ["$shopPrice", 0] } } } },
    ]).toArray();
    const shops = await db.collection(SHOPS).find({}).project({ name: 1, active: 1 }).toArray();
    const shopRows = shops.map((s) => {
      const row = { shopId: String(s._id), name: s.name, active: s.active !== false };
      for (const st of STATUSES) row[st] = 0;
      for (const a of perShopAgg) {
        if (String(a._id.shopId) === String(s._id)) row[a._id.status] = a.n;
      }
      return row;
    });

    // Sold per ISO-ish week (last 12 weeks, by soldAt).
    const since = new Date(Date.now() - 12 * 7 * 86400000);
    const weekly = await col.aggregate([
      { $match: { soldAt: { $gte: since } } },
      { $group: {
        _id: { $dateToString: { format: "%G-W%V", date: "$soldAt", timezone: "Australia/Melbourne" } },
        n: { $sum: 1 },
        value: { $sum: { $ifNull: ["$shopPrice", 0] } },
      } },
      { $sort: { _id: 1 } },
    ]).toArray();

    return res.json({
      success: true,
      byStatus,
      uninvoicedSold: uninvoiced[0] ? { count: uninvoiced[0].n, value: Math.round(uninvoiced[0].value * 100) / 100 } : { count: 0, value: 0 },
      shops: shopRows,
      weeklySold: weekly.map((w) => ({ week: w._id, count: w.n, value: Math.round(w.value * 100) / 100 })),
    });
  } catch (e) {
    console.error("consignment insights error:", e);
    return res.status(500).json({ success: false, message: "Failed to load insights" });
  }
});

// ── Invoices (admin) ────────────────────────────────────────────────

// Generate the weekly invoice for a shop: all sold-and-uninvoiced devices up
// to the end of the previous Melbourne week (catches stragglers too).
router.post("/invoices/generate", MANAGE, async function (req, res) {
  try {
    const shopId = oid(req.body && req.body.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "shopId is required" });
    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ _id: shopId });
    if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });

    const week = previousMelbourneWeek();
    const devices = await db.collection(DEVICES)
      .find({ shopId, status: "sold", invoiceId: null, soldAt: { $lt: week.end } })
      .toArray();
    if (!devices.length) {
      return res.json({ success: true, created: false, message: "No uninvoiced sold devices for this shop in that period." });
    }

    const seq = (await db.collection(INVOICES).countDocuments({})) + 1;
    const number = `CI-${week.endLabel.replace(/-/g, "")}-${String(seq).padStart(4, "0")}`;
    const total = Math.round(devices.reduce((s, d) => s + (Number(d.shopPrice) || 0), 0) * 100) / 100;
    const doc = {
      number,
      shopId,
      shopName: shop.name,
      periodStart: week.start,
      periodEnd: week.end,
      periodLabel: `${week.startLabel} – ${week.endLabel}`,
      deviceIds: devices.map((d) => d._id),
      deviceCount: devices.length,
      total,
      createdAt: new Date(),
      createdBy: actorOf(req),
    };
    const r = await db.collection(INVOICES).insertOne(doc);
    await db.collection(DEVICES).updateMany(
      { _id: { $in: doc.deviceIds } },
      { $set: { invoiceId: r.insertedId, updatedAt: new Date() } },
    );
    return res.json({ success: true, created: true, invoice: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("consignment invoice generate error:", e);
    return res.status(500).json({ success: false, message: "Failed to generate invoice" });
  }
});

router.get("/invoices", MANAGE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const match = {};
    if (req.query.shopId) {
      const sid = oid(req.query.shopId);
      if (sid) match.shopId = sid;
    }
    const invoices = await db.collection(INVOICES).find(match).sort({ createdAt: -1 }).limit(200).toArray();
    return res.json({ success: true, invoices });
  } catch (e) {
    console.error("consignment invoices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoices" });
  }
});

router.get("/invoices/:id", MANAGE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const invoice = await db.collection(INVOICES).findOne({ _id });
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    const devices = await db.collection(DEVICES)
      .find({ _id: { $in: invoice.deviceIds || [] } })
      .project({ stockId: 1, productName: 1, sku: 1, grade: 1, imei: 1, shopPrice: 1, soldAt: 1 })
      .toArray();
    return res.json({ success: true, invoice, devices });
  } catch (e) {
    console.error("consignment invoice detail error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoice" });
  }
});

module.exports = router;
