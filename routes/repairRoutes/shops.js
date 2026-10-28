// iMobile Repair → Shops (user 2026-10-28): one of our customers can run
// several shops, and each shop is its own customer in RepairDesk. A shop
// group puts those RepairDesk customers under one name, so the Tickets page
// can show every ticket of that customer at once. The groups live only in the
// dashboard (imb_repair_shop_groups) — RepairDesk is only read.
//
// Mounted under /repair/shops by routes/repairRoutes/index.js.
//   GET    /                 the groups, A–Z
//   GET    /customers?q=     RepairDesk customer search, for the picker
//   POST   /                 { name, customers: [{ id, name, organization? }] }
//   PUT    /:id              same body
//   DELETE /:id              the group only (RepairDesk is untouched)

var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";
const GROUPS = "imb_repair_shop_groups";
const VIEW = requirePermission("repair:shop:view");
const MANAGE = requirePermission("repair:shop:manage");
const MAX_CUSTOMERS = 200;

const str = (v) => String(v == null ? "" : v).trim();
const bad = (res, message) => res.status(400).json({ success: false, message });
const actor = (req) => (req.user && req.user.username) || "unknown";
const oid = (v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null);
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function apiKey() {
  const key = process.env.IMB_REPAIRDESK_API_KEY;
  if (!key) throw Object.assign(new Error("IMB_REPAIRDESK_API_KEY is not configured in the backend .env"), { status: 500 });
  return key;
}

const shape = (g) => ({
  id: String(g._id),
  name: g.name,
  customers: g.customers || [],
  createdAt: g.createdAt, createdBy: g.createdBy,
  updatedAt: g.updatedAt || null, updatedBy: g.updatedBy || "",
});

// The body's group, checked: a name not used by another group, and shops
// (RepairDesk customers, by id) that sit in no other group — a shop belongs
// to one customer. → { doc } or { error }
async function readGroup(db, body, selfId) {
  const name = str(body && body.name).replace(/\s+/g, " ");
  if (!name) return { error: "Give the group a name" };
  if (name.length > 100) return { error: "The name is too long (100 characters at most)" };
  const list = Array.isArray(body && body.customers) ? body.customers : [];
  const customers = [];
  const seen = new Set();
  for (const c of list) {
    const id = str(c && c.id);
    if (!/^\d{1,15}$/.test(id)) return { error: "A shop has a bad RepairDesk customer id" };
    if (seen.has(id)) continue;
    seen.add(id);
    customers.push({ id, name: str(c.name).slice(0, 200), organization: str(c.organization).slice(0, 200) });
  }
  if (!customers.length) return { error: "Add at least one shop" };
  if (customers.length > MAX_CUSTOMERS) return { error: `A group holds ${MAX_CUSTOMERS} shops at most` };
  const notSelf = selfId ? { _id: { $ne: selfId } } : {};
  const sameName = await db.collection(GROUPS).findOne({ ...notSelf, name: { $regex: `^${escapeRx(name)}$`, $options: "i" } });
  if (sameName) return { error: `There is a group called "${sameName.name}" already` };
  const taken = await db.collection(GROUPS).find({ ...notSelf, "customers.id": { $in: [...seen] } }, { projection: { name: 1, customers: 1 } }).toArray();
  if (taken.length) {
    const g = taken[0];
    const c = customers.find((x) => (g.customers || []).some((y) => y.id === x.id));
    return { error: `${c.name || c.id} is already in the group "${g.name}"` };
  }
  return { doc: { name, customers } };
}

// ── GET /repair/shops ────────────────────────────────────────────────
router.get("/", VIEW, async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const groups = await db.collection(GROUPS).find({}).collation({ locale: "en" }).sort({ name: 1 }).toArray();
    return res.json({ success: true, data: groups.map(shape) });
  } catch (error) {
    next(error);
  }
});

// ── GET /repair/shops/customers?q= ───────────────────────────────────
// RepairDesk's customer search (name, phone, email, organization …), first
// 25, for the group dialog's shop picker. Each with the group it is in.
router.get("/customers", VIEW, async function (req, res) {
  try {
    const q = str(req.query.q);
    if (q.length < 2) return res.json({ success: true, data: [] });
    const r = await axios.get(
      `${REPAIRDESK_API_BASE}/customers?api_key=${encodeURIComponent(apiKey())}&page=1&pagesize=25&keyword=${encodeURIComponent(q)}`,
      { timeout: 30000 },
    );
    const rows = (r.data && r.data.data && r.data.data.customerData) || [];
    const db = await connectToDatabase();
    const ids = rows.map((c) => String(c.cid));
    const groups = await db.collection(GROUPS).find({ "customers.id": { $in: ids } }, { projection: { name: 1, customers: 1 } }).toArray();
    const groupOf = new Map();
    for (const g of groups) for (const c of g.customers || []) groupOf.set(c.id, { id: String(g._id), name: g.name });
    return res.json({
      success: true,
      data: rows.map((c) => ({
        id: String(c.cid),
        name: str(c.fullName) || [c.first_name, c.last_name].filter(Boolean).join(" "),
        organization: str(c.orgonization || c.organization),
        phone: str(c.mobile || c.phone),
        email: str(c.email),
        tickets: Number(c.tickets_count) || 0,
        group: groupOf.get(String(c.cid)) || null,
      })),
    });
  } catch (error) {
    const status = error.response && error.response.status === 429 ? 429 : error.status || 502;
    console.error("Repair /shops/customers error:", error.message || error);
    return res.status(status).json({ success: false, message: status === 429 ? "RepairDesk is busy — try again in a minute" : `Failed to search RepairDesk customers: ${error.message || error}` });
  }
});

// ── POST /repair/shops ───────────────────────────────────────────────
router.post("/", MANAGE, async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    const { doc, error } = await readGroup(db, req.body);
    if (error) return bad(res, error);
    const now = new Date();
    const full = { ...doc, createdAt: now, createdBy: actor(req) };
    const r = await db.collection(GROUPS).insertOne(full);
    return res.json({ success: true, data: shape({ ...full, _id: r.insertedId }) });
  } catch (error) {
    next(error);
  }
});

// ── PUT /repair/shops/:id ────────────────────────────────────────────
router.put("/:id", MANAGE, async function (req, res, next) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "Bad group id");
    const db = await connectToDatabase();
    const { doc, error } = await readGroup(db, req.body, _id);
    if (error) return bad(res, error);
    const r = await db.collection(GROUPS).findOneAndUpdate(
      { _id },
      { $set: { ...doc, updatedAt: new Date(), updatedBy: actor(req) } },
      { returnDocument: "after" },
    );
    const g = r && r.value !== undefined ? r.value : r;
    if (!g) return res.status(404).json({ success: false, message: "Group not found" });
    return res.json({ success: true, data: shape(g) });
  } catch (error) {
    next(error);
  }
});

// ── DELETE /repair/shops/:id ─────────────────────────────────────────
router.delete("/:id", MANAGE, async function (req, res, next) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return bad(res, "Bad group id");
    const db = await connectToDatabase();
    const r = await db.collection(GROUPS).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Group not found" });
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
