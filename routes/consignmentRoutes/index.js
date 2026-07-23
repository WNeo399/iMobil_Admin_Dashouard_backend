// Consignment — devices placed with partner shops on consignment.
//
// Flow: admin assigns devices in batch to a shop (status "in-transit") → the
// shop's own login marks them "received" → marks each "sold" as they sell →
// or initiates a return ("returning") which admin closes out as "returned"
// when the stock arrives back. Weekly, admin raises an invoice per shop for
// the devices sold (all sold-and-uninvoiced up to the end of last week).
//
// Data:
//   consignment_shops    { name, active, createdAt }
//   consignment_devices  { shopId, batchId, model, imei, price, status,
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
const { exQuery } = require("../../utils/exDb");

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
        value: { $sum: { $ifNull: ["$price", 0] } },
        uninvoiced: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "sold"] }, { $not: ["$invoiceId"] }] }, 1, 0] } },
        uninvoicedValue: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "sold"] }, { $not: ["$invoiceId"] }] }, { $ifNull: ["$price", 0] }, 0] } },
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
    const projection = scope ? { deviceCost: 0, systemPrice: 0 } : {};
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

// Resolve Stock IDs / IMEIs against the ExEngine stock database (admin).
// Body: { codes: [...] } → { devices: [{stockId, imei, sku, productName, grade,
// deviceCost, systemPrice, ...}], notFound: [], alreadyOut: [] }
router.post("/devices/lookup", ASSIGN, async function (req, res) {
  try {
    const codes = [
      ...new Set(
        (Array.isArray(req.body && req.body.codes) ? req.body.codes : [])
          .map((c) => String(c || "").trim())
          .filter(Boolean),
      ),
    ];
    if (!codes.length) return res.status(400).json({ success: false, message: "No Stock IDs / IMEIs provided." });
    if (codes.length > 500) return res.status(400).json({ success: false, message: "Too many codes (max 500)." });

    // Stock IDs in EX_DB are zero-padded to 10 digits — also try the padded
    // form of purely numeric inputs so "212353" finds "0000212353".
    const candidates = new Set();
    for (const c of codes) {
      candidates.add(c);
      if (/^\d{1,10}$/.test(c)) candidates.add(c.padStart(10, "0"));
    }
    const list = [...candidates];
    const ph = list.map(() => "?").join(",");
    const rows = await exQuery(
      `SELECT \`Stock ID\` AS stockId, device_identifier AS imei, sku, \`Product Name\` AS productName,
              \`Grade\` AS grade, \`Device Cost\` AS deviceCost, \`System Price\` AS systemPrice,
              \`Stock Status\` AS stockStatus, \`Zone Location Item Status\` AS zoneStatus
       FROM vw_full_stock_details
       WHERE \`Stock ID\` IN (${ph}) OR device_identifier IN (${ph})`,
      [...list, ...list],
    );

    // Map each input code to its matched device (case-insensitive, padded-aware).
    const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
    const byKey = new Map();
    for (const r of rows) {
      byKey.set(norm(r.stockId), r);
      if (r.imei) byKey.set(norm(r.imei), r);
    }
    const found = new Map(); // stockId -> device
    const notFound = [];
    for (const c of codes) {
      const hit = byKey.get(norm(c)) || (/^\d{1,10}$/.test(c) ? byKey.get(norm(c.padStart(10, "0"))) : null);
      if (hit) found.set(String(hit.stockId), hit);
      else notFound.push(c);
    }

    // Which of these are already out on consignment (not yet returned)?
    const db = await connectToDatabase();
    const stockIds = [...found.keys()];
    const out = stockIds.length
      ? await db.collection(DEVICES)
          .find({ stockId: { $in: stockIds }, status: { $nin: ["returned"] } })
          .project({ stockId: 1 }).toArray()
      : [];
    const alreadyOut = [...new Set(out.map((d) => d.stockId))];

    const devices = [...found.values()].map((r) => ({
      stockId: String(r.stockId),
      imei: r.imei != null ? String(r.imei) : "",
      sku: r.sku != null ? String(r.sku) : "",
      productName: r.productName != null ? String(r.productName) : "",
      grade: String(r.grade || "").trim(),
      deviceCost: Number.isFinite(Number(r.deviceCost)) ? Number(r.deviceCost) : null,
      systemPrice: Number.isFinite(Number(r.systemPrice)) ? Number(r.systemPrice) : null,
      stockStatus: r.stockStatus || "",
      zoneStatus: r.zoneStatus || "",
      alreadyOut: alreadyOut.includes(String(r.stockId)),
    }));

    return res.json({ success: true, devices, notFound, alreadyOut });
  } catch (e) {
    console.error("consignment lookup error:", e);
    return res.status(502).json({ success: false, message: e.message || "Stock lookup failed" });
  }
});

// Batch assign (admin) — devices resolved via /devices/lookup:
// [{ stockId, imei, sku, productName, grade, deviceCost, systemPrice, salesPrice }]
// salesPrice (defaulted to systemPrice in the UI, editable) is what the shop
// sees and what the weekly invoice bills.
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
      const systemPrice = num(d.systemPrice);
      const salesPrice = num(d.salesPrice);
      if (salesPrice == null || salesPrice < 0) {
        return res.status(400).json({ success: false, message: `Device ${i + 1} (${stockId}): a valid Sales Price is required.` });
      }
      docs.push({
        shopId, batchId,
        stockId,
        imei: String(d.imei || "").trim(),
        sku: String(d.sku || "").trim(),
        productName,
        grade: String(d.grade || "").trim(),
        deviceCost: num(d.deviceCost),
        systemPrice,
        // `price` = the Sales Price: what the shop sees and what the weekly
        // invoice bills.
        price: salesPrice,
        status: "in-transit",
        assignedAt: now, assignedBy: by,
        invoiceId: null,
        statusHistory: [{ status: "in-transit", at: now, by }],
      });
    }
    // Guard: any of these stock IDs still out on consignment (not returned)?
    const dupes = await db.collection(DEVICES)
      .find({ stockId: { $in: docs.map((d) => d.stockId) }, status: { $nin: ["returned"] } })
      .project({ stockId: 1 }).toArray();
    if (dupes.length) {
      return res.status(400).json({
        success: false,
        message: `Already out on consignment: ${[...new Set(dupes.map((d) => d.stockId))].slice(0, 5).join(", ")}`,
      });
    }
    await db.collection(DEVICES).insertMany(docs);
    await Promise.all([
      db.collection(DEVICES).createIndex({ shopId: 1, status: 1 }),
      db.collection(DEVICES).createIndex({ batchId: 1 }),
      db.collection(DEVICES).createIndex({ stockId: 1 }),
      db.collection(DEVICES).createIndex({ imei: 1 }),
    ]).catch(() => {});
    return res.json({ success: true, batchId, assigned: docs.length, shopName: shop.name });
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
      { $group: { _id: "$status", n: { $sum: 1 }, value: { $sum: { $ifNull: ["$price", 0] } } } },
    ]).toArray();
    for (const r of statusAgg) byStatus[r._id] = { count: r.n, value: Math.round(r.value * 100) / 100 };

    const uninvoiced = await col.aggregate([
      { $match: { status: "sold", invoiceId: null } },
      { $group: { _id: null, n: { $sum: 1 }, value: { $sum: { $ifNull: ["$price", 0] } } } },
    ]).toArray();

    // Per-shop summary.
    const perShopAgg = await col.aggregate([
      { $group: { _id: { shopId: "$shopId", status: "$status" }, n: { $sum: 1 }, value: { $sum: { $ifNull: ["$price", 0] } } } },
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
        value: { $sum: { $ifNull: ["$price", 0] } },
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
    const total = Math.round(devices.reduce((s, d) => s + (Number(d.price) || 0), 0) * 100) / 100;
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
      .project({ stockId: 1, productName: 1, sku: 1, grade: 1, imei: 1, price: 1, soldAt: 1 })
      .toArray();
    return res.json({ success: true, invoice, devices });
  } catch (e) {
    console.error("consignment invoice detail error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoice" });
  }
});

module.exports = router;
