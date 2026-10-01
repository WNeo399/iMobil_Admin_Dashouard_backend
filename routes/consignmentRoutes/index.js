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
//                          shopPrice (what invoices bill), retailPrice
//                          (what the shop sold it for / asks), status,
//                          assignedAt/receivedAt/soldAt/returnAt/returnedAt,
//                          invoiceId, statusHistory[] }
//   consignment_invoices { number (CI-10001…), seq, shopId, shopName,
//                          periodLabel (first – last sold), deviceIds,
//                          deviceCount, lines[] (snapshot), subTotal,
//                          gstRate, gstAmount, total, paymentStatus
//                          (unpaid | paid | void), paidAt, paidBy,
//                          inflowRecordedAt, inflowRecordedBy,
//                          createdAt, createdBy, source }
//   Shops used to run on one Google Sheet each, invoiced from AirTable
//   (INV-A… numbers; total only, no GST split); those histories were
//   imported (source "sheet-import" on devices, "airtable" on invoices).
//   From 2026-10-01 the dashboard raises its own invoices (user ask): one
//   per shop whenever it suits (Consignment → Invoices), for every sold
//   device not yet on an invoice, Shop Price + 10% GST.
//
// A received device has CONSIGN_DAYS to sell before it's due back (the
// sheets' "Expired On" = Date Received + 90 days).
//
//   Shop logins live in the normal `users` collection with
//   role "consignment-shop" + consignShopId.
//
// Consignment-shop users are hard-scoped to their consignShopId on every
// device endpoint; admin (wildcard) sees everything.

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission, requireAnyPermission } = require("../../middleware/auth");
const { hashPassword } = require("../../utils/authToken");
const { ROLES } = require("../../constants/roles");

const SHOPS = "consignment_shops";
const DEVICES = "consignment_devices";
const INVOICES = "consignment_invoices";

const MANAGE = requirePermission("consign:shop:manage");
const ASSIGN = requirePermission("consign:device:assign");
const DEVICE_VIEW = requirePermission("consign:device:view");
const INSIGHT = requirePermission("consign:insight:view");
// Invoicing the shops: admin on Consignment → Invoices, and the iMobile
// Accountant (acct:*) from her Dashboard — sold-not-invoiced, raising
// invoices, unpaid invoices (user ask 2026-10-01).
const INVOICE = requireAnyPermission("consign:invoice:manage", "acct:consign:invoice");
// What every invoice raised here carries (user: "GST is fixed to 10%"),
// added on top of the shop prices — the sales-order convention.
const GST_RATE = 0.1;

const STATUSES = ["in-transit", "received", "sold", "returning", "returned"];
const CONSIGN_DAYS = 90;
const DAY_MS = 86400000;
const overdueCutoff = () => new Date(Date.now() - CONSIGN_DAYS * DAY_MS);

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

// YYYY-MM-DD of an instant, Melbourne time.
function melYmd(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });
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
    // "overdue": received and past the consignment window, still unsold.
    else if (req.query.status === "overdue") Object.assign(match, { status: "received", receivedAt: { $lt: overdueCutoff() } });
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
    delete countMatch.receivedAt;
    const counts = {};
    const agg = await col.aggregate([{ $match: countMatch }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray();
    for (const r of agg) counts[r._id] = r.n;
    counts.overdue = await col.countDocuments({ ...countMatch, status: "received", receivedAt: { $lt: overdueCutoff() } });

    // Attach shop names for the admin view.
    const shopIds = [...new Set(rows.map((r) => String(r.shopId)))].map((s) => oid(s)).filter(Boolean);
    const shops = shopIds.length
      ? await db.collection(SHOPS).find({ _id: { $in: shopIds } }).project({ name: 1 }).toArray()
      : [];
    const shopName = {};
    for (const s of shops) shopName[String(s._id)] = s.name;
    // The invoice a sold device was billed on: its number and whether it's
    // paid (a shop login sees the same — it's their bill).
    const invIds = [...new Set(rows.map((r) => r.invoiceId && String(r.invoiceId)).filter(Boolean))].map(oid).filter(Boolean);
    const invs = invIds.length
      ? await db.collection(INVOICES).find({ _id: { $in: invIds } }).project({ number: 1, paymentStatus: 1 }).toArray()
      : [];
    const invById = new Map(invs.map((i) => [String(i._id), i]));
    return res.json({
      success: true, page, pageSize, total, counts, consignDays: CONSIGN_DAYS,
      rows: rows.map((r) => {
        const inv = r.invoiceId ? invById.get(String(r.invoiceId)) : null;
        return {
          ...r,
          shopName: shopName[String(r.shopId)] || "",
          invoiceNo: inv ? inv.number : null,
          paymentStatus: inv ? inv.paymentStatus || "unpaid" : null,
        };
      }),
    });
  } catch (e) {
    console.error("consignment devices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load devices" });
  }
});

// ── GET /consignment/devices/batches ────────────────────────────────
// The assignment batches: every Assign stamps one batchId across the
// devices sent together, so a batch IS a send to a shop. Newest first;
// shop logins see only their own. EX_DB-era rows without a batchId are
// simply not listed.
router.get("/devices/batches", DEVICE_VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const match = { batchId: { $nin: [null, ""] } };
    const scope = shopScope(req);
    if (scope) match.shopId = scope;
    else if (req.query.shopId) {
      const sid = oid(req.query.shopId);
      if (sid) match.shopId = sid;
    }
    const rows = await db
      .collection(DEVICES)
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: "$batchId",
            batchNo: { $first: "$batchNo" },
            shopId: { $first: "$shopId" },
            count: { $sum: 1 },
            assignedAt: { $min: "$assignedAt" },
            assignedBy: { $first: "$assignedBy" },
          },
        },
        { $sort: { assignedAt: -1 } },
        { $limit: 300 },
      ])
      .toArray();
    const shopIds = [...new Set(rows.map((r) => String(r.shopId)))].map((s) => oid(s)).filter(Boolean);
    const shops = shopIds.length
      ? await db.collection(SHOPS).find({ _id: { $in: shopIds } }).project({ name: 1 }).toArray()
      : [];
    const shopName = {};
    for (const s of shops) shopName[String(s._id)] = s.name;
    return res.json({
      success: true,
      batches: rows.map((r) => ({
        batchId: r._id,
        batchNo: r.batchNo || "",
        shopId: String(r.shopId),
        shopName: shopName[String(r.shopId)] || "",
        count: r.count,
        assignedAt: r.assignedAt,
        assignedBy: r.assignedBy || "",
      })),
    });
  } catch (e) {
    console.error("consignment batches error:", e);
    return res.status(500).json({ success: false, message: "Failed to load batches" });
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
    // A human-friendly batch number (CS-10001+), same scheme as supply
    // batches. Denormalized onto every device doc — batches have no
    // collection of their own.
    const lastNo = await db
      .collection(DEVICES)
      .find({ batchSeq: { $gt: 0 } })
      .sort({ batchSeq: -1 })
      .limit(1)
      .toArray();
    const batchSeq = Math.max((lastNo[0] && lastNo[0].batchSeq) || 0, 10000) + 1;
    const batchNo = `CS-${batchSeq}`;
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
        shopId, batchId, batchSeq, batchNo,
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

    // Selling can carry what each one went for: { prices: { id: amount } }
    // (optional, per device — the shop's sale price, not what we bill).
    if (action === "sell" && r.modifiedCount && req.body && req.body.prices && typeof req.body.prices === "object") {
      for (const [id, v] of Object.entries(req.body.prices)) {
        const _id = oid(id);
        const price = Number(v);
        if (!_id || v === "" || v == null || !Number.isFinite(price) || price < 0) continue;
        await db.collection(DEVICES).updateOne(
          { _id, status: "sold", ...(scope ? { shopId: scope } : {}) },
          { $set: { retailPrice: Math.round(price * 100) / 100 } },
        );
      }
    }

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

// The shop's price for one device — what it sold for, or what they're
// asking while it's on the shelf. { retailPrice: number | null }. The shop
// sets its own; admin can correct any. Never touches what we bill.
router.post("/devices/:id/retailPrice", DEVICE_VIEW, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const raw = req.body && req.body.retailPrice;
    const price = raw === "" || raw == null ? null : Number(raw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) {
      return res.status(400).json({ success: false, message: "Enter a valid price." });
    }
    const db = await connectToDatabase();
    const scope = shopScope(req);
    const r = await db.collection(DEVICES).updateOne(
      { _id, status: { $ne: "returned" }, ...(scope ? { shopId: scope } : {}) },
      { $set: { retailPrice: price === null ? null : Math.round(price * 100) / 100, updatedAt: new Date() } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Device not found" });
    return res.json({ success: true, retailPrice: price === null ? null : Math.round(price * 100) / 100 });
  } catch (e) {
    console.error("consignment retail price error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the price" });
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

// ── Invoices (Consignment → Invoices) ──────────────────────────────
// The dashboard raises its own invoices (user ask 2026-10-01 — before that
// AirTable did, INV-A…; those were imported with their paid status). No
// weekly cut-off: the page shows how many sold devices aren't on an
// invoice yet and raises one per shop whenever it suits — it bills every
// sold-and-uninvoiced device that shop has at that moment, at the Shop
// Price plus GST (GST_RATE, added on top).
//
//   GET  /consignment/invoices/preview[?shopId]  what an invoice raised now would bill, per shop
//   POST /consignment/invoices/generate { shopId }
//   POST /consignment/invoices/generate-batch { shopIds? }   one per shop, in one go
//   GET  /consignment/invoices[?shopId&paymentStatus]
//   GET  /consignment/invoices/:id                with its lines
//   POST /consignment/invoices/:id/payment { paid } mark paid / unpaid (only once in inFlow)
//   POST /consignment/invoices/:id/inflow { recorded }  entered in inFlow (label)
//   POST /consignment/invoices/:id/void            unpaid dashboard invoices only;
//                                                  its devices go back to "to invoice"

// What an invoice line shows — a snapshot, so a later edit to the device
// can't change a bill that's already gone out.
function invoiceLine(d) {
  return {
    deviceId: d._id,
    imei: d.imei || d.stockId || "",
    productName: d.productName || "",
    grade: d.grade || "",
    soldAt: d.soldAt || null,
    shopPrice: Number(d.shopPrice) || 0,
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
function invoiceTotals(lines) {
  const subTotal = r2(lines.reduce((s, l) => s + (Number(l.shopPrice) || 0), 0));
  const gstAmount = r2(subTotal * GST_RATE);
  return { subTotal, gstRate: GST_RATE, gstAmount, total: r2(subTotal + gstAmount) };
}
// "first sold – last sold" of the lines, Melbourne dates
function soldSpan(lines) {
  const days = lines.map((l) => l.soldAt).filter(Boolean).map(melYmd).sort();
  return days.length ? { from: days[0], to: days[days.length - 1] } : null;
}

router.get("/invoices/preview", INVOICE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const match = { status: "sold", invoiceId: null };
    const sid = req.query.shopId ? oid(req.query.shopId) : null;
    if (sid) match.shopId = sid;
    const devices = await db.collection(DEVICES).find(match).sort({ soldAt: 1 }).toArray();
    const shops = await db.collection(SHOPS).find({}).project({ name: 1 }).toArray();
    const name = new Map(shops.map((s) => [String(s._id), s.name]));
    const byShop = new Map();
    for (const d of devices) {
      const k = String(d.shopId);
      if (!byShop.has(k)) byShop.set(k, { shopId: k, shopName: name.get(k) || "", lines: [] });
      byShop.get(k).lines.push(invoiceLine(d));
    }
    const rows = [...byShop.values()]
      .map((g) => ({ ...g, count: g.lines.length, ...invoiceTotals(g.lines), sold: soldSpan(g.lines) }))
      .sort((a, b) => a.shopName.localeCompare(b.shopName));
    return res.json({
      success: true,
      gstRate: GST_RATE,
      shops: rows,
      count: devices.length,
      total: r2(rows.reduce((t, g) => t + g.total, 0)),
    });
  } catch (e) {
    console.error("consignment invoice preview error:", e);
    return res.status(500).json({ success: false, message: "Failed to work out what to invoice" });
  }
});

// The invoice indexes, made once per process (each createIndex is a round
// trip — a batch across many shops shouldn't pay it per shop). The unique
// seq index makes two invoices raised at once retry with the next number.
let invoiceIndexes = null;
function ensureInvoiceIndexes(db) {
  if (!invoiceIndexes) {
    invoiceIndexes = Promise.all([
      db.collection(INVOICES).createIndex({ seq: 1 }, { unique: true, partialFilterExpression: { seq: { $gt: 0 } } }),
      db.collection(INVOICES).createIndex({ shopId: 1, createdAt: -1 }),
    ]).catch((e) => {
      invoiceIndexes = null; // try again next time
      console.error('consignment invoice indexes:', e.message);
    });
  }
  return invoiceIndexes;
}

// Raise one invoice for a shop: every device it sold that isn't on an
// invoice yet. Returns { created: false } when there's nothing to bill.
async function raiseInvoiceForShop(db, shop, by) {
  const devices = await db.collection(DEVICES)
    .find({ shopId: shop._id, status: "sold", invoiceId: null })
    .sort({ soldAt: 1 })
    .toArray();
  if (!devices.length) return { created: false };

  // CI-10001, CI-10002 … — our own running number (imported AirTable
  // invoices carry no seq); a clash retries with the next number.
  await ensureInvoiceIndexes(db);
  const lines = devices.map(invoiceLine);
  const span = soldSpan(lines);
  let doc;
  let insertedId;
  for (let attempt = 0; attempt < 5 && !insertedId; attempt++) {
    const last = await db.collection(INVOICES).find({ seq: { $gt: 0 } }).sort({ seq: -1 }).limit(1).toArray();
    const seq = Math.max((last[0] && last[0].seq) || 0, 10000) + 1;
    doc = {
      number: `CI-${seq}`,
      seq,
      shopId: shop._id,
      shopName: shop.name,
      // the dates the billed devices sold between (information only)
      periodLabel: span ? `${span.from} – ${span.to}` : "",
      deviceIds: devices.map((d) => d._id),
      deviceCount: devices.length,
      lines,
      ...invoiceTotals(lines),
      paymentStatus: "unpaid",
      paidAt: null,
      paidBy: null,
      source: "dashboard",
      createdAt: new Date(),
      createdBy: by,
    };
    try {
      insertedId = (await db.collection(INVOICES).insertOne(doc)).insertedId;
    } catch (e) {
      if (e && e.code === 11000) continue; // that number was just taken
      throw e;
    }
  }
  if (!insertedId) throw new Error("Could not get an invoice number");

  // Claimed only while still uninvoiced, so two clicks can't bill a
  // device twice; a device that slipped away is dropped from the bill.
  const claim = await db.collection(DEVICES).updateMany(
    { _id: { $in: doc.deviceIds }, invoiceId: null },
    { $set: { invoiceId: insertedId, updatedAt: new Date() } },
  );
  if (claim.modifiedCount !== doc.deviceIds.length) {
    const mine = await db.collection(DEVICES).find({ invoiceId: insertedId }).sort({ soldAt: 1 }).toArray();
    if (!mine.length) {
      await db.collection(INVOICES).deleteOne({ _id: insertedId });
      return { created: false, raced: true };
    }
    const keep = mine.map(invoiceLine);
    const s2 = soldSpan(keep);
    const fix = {
      deviceIds: mine.map((d) => d._id),
      deviceCount: mine.length,
      lines: keep,
      periodLabel: s2 ? `${s2.from} – ${s2.to}` : "",
      ...invoiceTotals(keep),
    };
    await db.collection(INVOICES).updateOne({ _id: insertedId }, { $set: fix });
    Object.assign(doc, fix);
  }
  return { created: true, invoice: { _id: insertedId, ...doc } };
}

router.post("/invoices/generate", INVOICE, async function (req, res) {
  try {
    const shopId = oid(req.body && req.body.shopId);
    if (!shopId) return res.status(400).json({ success: false, message: "shopId is required" });
    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ _id: shopId });
    if (!shop) return res.status(404).json({ success: false, message: "Shop not found" });
    const r = await raiseInvoiceForShop(db, shop, actorOf(req));
    if (r.raced) return res.status(409).json({ success: false, message: "Those devices were just invoiced — refresh the page." });
    if (!r.created) {
      return res.json({ success: true, created: false, message: "Nothing to invoice — every device this shop sold is already on an invoice." });
    }
    return res.json({ success: true, created: true, invoice: r.invoice });
  } catch (e) {
    console.error("consignment invoice generate error:", e);
    return res.status(500).json({ success: false, message: "Failed to raise the invoice" });
  }
});

// Raise invoices in one go — one per shop, each billing everything that
// shop has sold and not been invoiced for. { shopIds: [...] } picks the
// shops; without it, every shop with something to bill.
router.post("/invoices/generate-batch", INVOICE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const wanted = Array.isArray(req.body && req.body.shopIds) ? req.body.shopIds.map(oid).filter(Boolean) : null;
    const pending = await db.collection(DEVICES).aggregate([
      { $match: { status: "sold", invoiceId: null, ...(wanted ? { shopId: { $in: wanted } } : {}) } },
      { $group: { _id: "$shopId" } },
    ]).toArray();
    const shops = pending.length
      ? await db.collection(SHOPS).find({ _id: { $in: pending.map((p) => p._id) } }).sort({ name: 1 }).toArray()
      : [];
    const by = actorOf(req);
    const invoices = [];
    const failed = [];
    for (const shop of shops) {
      try {
        const r = await raiseInvoiceForShop(db, shop, by);
        if (r.created) invoices.push(r.invoice);
      } catch (e) {
        console.error(`consignment batch invoice error (${shop.name}):`, e.message);
        failed.push(shop.name);
      }
    }
    return res.json({
      success: true,
      created: invoices.length,
      invoices: invoices.map(({ lines, deviceIds, ...rest }) => rest),
      total: r2(invoices.reduce((t, i) => t + i.total, 0)),
      failed,
    });
  } catch (e) {
    console.error("consignment batch invoice error:", e);
    return res.status(500).json({ success: false, message: "Failed to raise the invoices" });
  }
});

router.get("/invoices", INVOICE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const match = {};
    if (req.query.shopId) {
      const sid = oid(req.query.shopId);
      if (sid) match.shopId = sid;
    }
    const all = { ...match };
    if (["paid", "unpaid", "void"].includes(req.query.paymentStatus)) {
      match.paymentStatus = req.query.paymentStatus === "unpaid" ? { $in: ["unpaid", null] } : req.query.paymentStatus;
    }
    const invoices = await db.collection(INVOICES)
      .find(match, { projection: { lines: 0, deviceIds: 0 } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    const sums = await db.collection(INVOICES).aggregate([
      { $match: all },
      { $group: { _id: { $ifNull: ["$paymentStatus", "unpaid"] }, n: { $sum: 1 }, total: { $sum: "$total" } } },
    ]).toArray();
    const totals = {};
    for (const s of sums) totals[s._id] = { count: s.n, total: r2(s.total) };
    // the shop filter's options (so the page needn't read the Shops list)
    const shops = await db.collection(SHOPS).find({}).project({ name: 1 }).sort({ name: 1 }).toArray();
    return res.json({ success: true, invoices, totals, shops });
  } catch (e) {
    console.error("consignment invoices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoices" });
  }
});

router.get("/invoices/:id", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const invoice = await db.collection(INVOICES).findOne({ _id });
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    // Lines come from the snapshot; invoices from before snapshots read
    // their devices.
    let lines = invoice.lines;
    if (!Array.isArray(lines) || !lines.length) {
      const devices = await db.collection(DEVICES).find({ _id: { $in: invoice.deviceIds || [] } }).sort({ soldAt: 1 }).toArray();
      lines = devices.map(invoiceLine);
    }
    const { lines: _l, ...rest } = invoice;
    return res.json({ success: true, invoice: rest, lines });
  } catch (e) {
    console.error("consignment invoice detail error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoice" });
  }
});

router.post("/invoices/:id/payment", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const paid = !!(req.body && req.body.paid);
    const db = await connectToDatabase();
    const now = new Date();
    // An invoice is recorded in inFlow before it can be paid (user rule
    // 2026-10-01). Guarded in the update itself, so the order holds even
    // if two people click at once.
    const r = await db.collection(INVOICES).updateOne(
      { _id, paymentStatus: { $ne: "void" }, ...(paid ? { inflowRecordedAt: { $ne: null } } : {}) },
      { $set: paid ? { paymentStatus: "paid", paidAt: now, paidBy: actorOf(req) } : { paymentStatus: "unpaid", paidAt: null, paidBy: null } },
    );
    if (!r.matchedCount) {
      const inv = await db.collection(INVOICES).findOne({ _id }, { projection: { paymentStatus: 1, inflowRecordedAt: 1 } });
      if (inv && paid && inv.paymentStatus !== "void" && !inv.inflowRecordedAt) {
        return res.status(400).json({ success: false, message: "Record it in inFlow first — an invoice is entered in inFlow before it's marked paid." });
      }
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }
    return res.json({ success: true, paymentStatus: paid ? "paid" : "unpaid", paidAt: paid ? now : null });
  } catch (e) {
    console.error("consignment invoice payment error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the invoice" });
  }
});

// Whether the invoice has been entered into inFlow (the accounts are kept
// there) — { recorded: true | false }. Marks who and when; a label shows
// on the invoice lists (user ask 2026-10-01).
router.post("/invoices/:id/inflow", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const recorded = !!(req.body && req.body.recorded);
    const db = await connectToDatabase();
    const now = new Date();
    const by = actorOf(req);
    // Taking the mark off a paid invoice would break the inFlow-before-paid
    // order, so that's refused (mark it unpaid first).
    const r = await db.collection(INVOICES).updateOne(
      { _id, paymentStatus: recorded ? { $ne: "void" } : { $nin: ["void", "paid"] } },
      { $set: recorded ? { inflowRecordedAt: now, inflowRecordedBy: by } : { inflowRecordedAt: null, inflowRecordedBy: null } },
    );
    if (!r.matchedCount) {
      const inv = await db.collection(INVOICES).findOne({ _id }, { projection: { paymentStatus: 1 } });
      if (inv && !recorded && inv.paymentStatus === "paid") {
        return res.status(400).json({ success: false, message: "It's marked paid — mark it unpaid before taking the inFlow mark off." });
      }
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }
    return res.json({ success: true, inflowRecordedAt: recorded ? now : null, inflowRecordedBy: recorded ? by : null });
  } catch (e) {
    console.error("consignment invoice inflow error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the invoice" });
  }
});

router.post("/invoices/:id/void", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const inv = await db.collection(INVOICES).findOne({ _id });
    if (!inv) return res.status(404).json({ success: false, message: "Invoice not found" });
    if (inv.source !== "dashboard") return res.status(400).json({ success: false, message: "Only invoices raised here can be voided." });
    if (inv.paymentStatus === "paid") return res.status(400).json({ success: false, message: "It's marked paid — mark it unpaid first." });
    if (inv.paymentStatus === "void") return res.json({ success: true });
    const now = new Date();
    await db.collection(INVOICES).updateOne({ _id }, { $set: { paymentStatus: "void", voidedAt: now, voidedBy: actorOf(req) } });
    const r = await db.collection(DEVICES).updateMany({ invoiceId: _id }, { $set: { invoiceId: null, updatedAt: now } });
    return res.json({ success: true, released: r.modifiedCount });
  } catch (e) {
    console.error("consignment invoice void error:", e);
    return res.status(500).json({ success: false, message: "Failed to void the invoice" });
  }
});

module.exports = router;
