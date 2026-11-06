// Embed Ordering — public endpoints of the ordering widget
// (public/widgets/embed-ordering/v1.js), mounted at /widget/embed-ordering OUTSIDE the JWT chain
// (routes/widgetRoutes/index.js, before the shared 10/hour limiter).
//
// A distributor embeds the widget on their own website with their public key
// (embed_ordering_distributors.publicKey, sent as the X-Distributor-Key header). Their customers
// browse the live spare parts (the Listing Widget's catalogue, plus an
// in-stock flag), fill a cart and place orders. Demo build (user,
// 2026-11-06): sign-in by email alone, no prices, orders stay in the
// dashboard (Embed Ordering → Orders).
//
//   GET  /widget/embed-ordering/info                    the distributor's name (for the sign-in screen)
//   GET  /widget/embed-ordering/catalog                 brands → series → models        (signed in)
//   GET  /widget/embed-ordering/parts?brand=&model=     one model's parts (| ?tools=1)  (signed in)
//   GET  /widget/embed-ordering/search?q=&stock=in|out  matching models and parts      (signed in)
//   GET  /widget/embed-ordering/diagram3d?brand=&model= a model's 3D view: parts + linked items (signed in)
//   GET  /widget/embed-ordering/diagram3d/:id/model.glb the 3D file, gzipped           (signed in)
//
// The 3D diagrams are managed on the dashboard (Embed Ordering → 3D Diagrams,
// ./diagrams3d.js); only Published ones are served here.
//
// The parts are shown to signed-in customers only (user, 2026-11-06: "need
// login to see the products") — the catalogue routes refuse without a session.
//   POST /widget/embed-ordering/login   {email}         → { token, customer }   (DEMO: no code)
//   POST /widget/embed-ordering/logout
//   GET  /widget/embed-ordering/me                      the signed-in customer
//   POST /widget/embed-ordering/orders  {clientOrderId, lines, reference, note, deliveryAddress}
//   GET  /widget/embed-ordering/orders                  the signed-in customer's orders
//
// Which websites may use it: CORS lets through an origin listed on ANY active
// distributor (plus the backend's own origin — the dashboard Preview / demo
// page); each handler then requires the origin to be one of THIS key's
// distributor's websites. A refused origin is an error with status 403,
// because app.js's global cors() has already answered "*".

var express = require("express");
var cors = require("cors");
var rateLimit = require("express-rate-limit");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { getCatalog, partsForModel, toolParts, search, orderItem, TYPES, TYPE_LABELS } = require("../../utils/sparePartsCatalog");
const { notifyRoles } = require("../../utils/notify");
const { ROLES } = require("../../constants/roles");
const { str, address } = require("./common");
const { createSession, findSession, deleteSession } = require("./session");
const { ORDERS, ensureOrderIndexes, nextOrderNo, customerView } = require("./orderStore");
const D3 = require("./diagram3dStore");

const DISTRIBUTORS = "embed_ordering_distributors";
const CUSTOMERS = "embed_ordering_customers";
const ITEMS = "imb_stock_items";

const MAX_LINES = 200;
const MAX_QTY = 999;
const DIST_CACHE_MS = 60 * 1000;

// ── distributors (keys + websites), cached a minute ────────────────────
let distCache = null; // { at, byKey: Map(key → dist), origins: Set }
let distLoading = null;
async function distributors() {
  if (distCache && Date.now() - distCache.at < DIST_CACHE_MS) return distCache;
  if (!distLoading) {
    distLoading = (async () => {
      const db = await connectToDatabase();
      const rows = await db
        .collection(DISTRIBUTORS)
        .find({ status: { $ne: "inactive" } }, { projection: { name: 1, publicKey: 1, origins: 1, status: 1 } })
        .toArray();
      const byKey = new Map();
      const origins = new Set();
      for (const d of rows) {
        if (!d.publicKey) continue;
        byKey.set(d.publicKey, d);
        (d.origins || []).forEach((o) => origins.add(o));
      }
      distCache = { at: Date.now(), byKey, origins };
    })().finally(() => { distLoading = null; });
  }
  try {
    await distLoading;
  } catch (e) {
    if (!distCache) throw e;
  }
  return distCache;
}
// ── published 3D diagrams (Embed Ordering → 3D Diagrams), cached a minute ──
let d3Cache = null; // { at, byModel: Map("brand|model" lower-case → diagram) }
let d3Loading = null;
async function diagrams3d() {
  if (d3Cache && Date.now() - d3Cache.at < DIST_CACHE_MS) return d3Cache;
  if (!d3Loading) {
    d3Loading = (async () => {
      const db = await connectToDatabase();
      const rows = await db
        .collection(D3.DIAGRAMS)
        .find({ status: "published", "file.key": { $exists: true } }, { projection: { brand: 1, model: 1, title: 1, parts: 1, file: 1 } })
        .toArray();
      const byModel = new Map(rows.map((d) => [`${d.brand}|${d.model}`.toLowerCase(), d]));
      d3Cache = { at: Date.now(), byModel };
    })().finally(() => { d3Loading = null; });
  }
  try {
    await d3Loading;
  } catch (e) {
    if (!d3Cache) throw e;
  }
  return d3Cache;
}

// Tests reset the caches between cases.
router._resetCache = () => { distCache = null; d3Cache = null; };

// The backend's own pages (the dashboard Preview iframe, the demo page) —
// their requests carry this server's own origin, or none at all.
function isOwnOrigin(req, origin) {
  try {
    return new URL(origin).host === req.get("host");
  } catch (e) {
    return false;
  }
}

const widgetCors = cors((req, callback) => {
  const origin = req.header("Origin");
  const ok = { origin: origin || false, credentials: false, maxAge: 3600 };
  if (!origin || isOwnOrigin(req, origin)) return callback(null, ok);
  distributors()
    .then((c) => {
      if (c.origins.has(origin)) return callback(null, ok);
      const err = new Error(`Origin ${origin} not allowed`);
      err.status = 403;
      return callback(err);
    })
    .catch((e) => {
      console.error("Ordering widget CORS check failed:", e && e.message);
      callback(e);
    });
});

// ── rate limits (per IP) ──────────────────────────────────────────────
const limiter = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message },
    skip: (req) => !!process.env.INTERNAL_SECRET && req.headers["x-internal-secret"] === process.env.INTERNAL_SECRET,
  });
const readLimiter = limiter(15 * 60 * 1000, 1500, "Too many requests. Please try again later.");
const loginLimiter = limiter(15 * 60 * 1000, 20, "Too many sign-in attempts. Please try again later.");
const orderLimiter = limiter(60 * 60 * 1000, 30, "Too many orders from this connection. Please try again later.");

router.use(readLimiter);
router.options("*", widgetCors);
router.use(widgetCors);

const text = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim().slice(0, 64) || null;
const uaOf = (req) => text(req.get("user-agent"), 300) || null;

function fail(res, e, what) {
  console.error(`Ordering widget ${what} error:`, e && e.message);
  return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
}

// ── the key's distributor + the origin check ──────────────────────────
async function withDistributor(req, res, next) {
  try {
    const key = text(req.get("X-Distributor-Key") || req.query.key, 80);
    if (!key) return res.status(400).json({ success: false, message: "This ordering widget has no distributor key." });
    const c = await distributors();
    const dist = c.byKey.get(key);
    if (!dist) return res.status(403).json({ success: false, message: "This ordering widget isn't set up. Please contact the website owner." });
    const origin = req.get("Origin");
    const preview = !origin || isOwnOrigin(req, origin);
    if (!preview && !(dist.origins || []).includes(origin)) {
      return res.status(403).json({ success: false, message: "This website isn't allowed to use this ordering widget." });
    }
    req.eo = { dist, preview, origin: origin || null };
    return next();
  } catch (e) {
    return fail(res, e, "distributor");
  }
}
router.use(withDistributor);

// ── the signed-in customer ────────────────────────────────────────────
const bearer = (req) => {
  const m = String(req.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
};

async function requireCustomer(req, res, next) {
  try {
    const db = await connectToDatabase();
    const session = await findSession(db, bearer(req));
    const signIn = () => res.status(401).json({ success: false, reason: "signin", message: "Please sign in again." });
    if (!session || String(session.distributorId) !== String(req.eo.dist._id)) return signIn();
    const customer = await db.collection(CUSTOMERS).findOne({
      _id: session.customerId,
      distributorId: req.eo.dist._id,
      status: { $ne: "inactive" },
    });
    if (!customer) return signIn();
    req.eo.customer = customer;
    req.eo.db = db;
    return next();
  } catch (e) {
    return fail(res, e, "session");
  }
}

const meView = (c) => ({
  name: c.name || "",
  email: c.email || "",
  phone: c.phone || "",
  address: c.address || null,
});

// ── who the widget belongs to (public: the sign-in screen names them) ──
router.get("/info", (req, res) => {
  return res.json({ success: true, distributor: req.eo.dist.name || "" });
});

// ── catalogue (signed-in customers only) ──────────────────────────────
// Same data as the Listing Widget's feed; each part also says whether it is
// in stock. Cached briefly by the browser (stock is synced hourly anyway).
const cacheFor = (res, secs) => res.set("Cache-Control", `private, max-age=${secs}`);

router.get("/catalog", requireCustomer, async (req, res) => {
  try {
    const [cat, d3] = await Promise.all([getCatalog(), diagrams3d()]);
    cacheFor(res, 120);
    return res.json({
      success: true,
      updatedAt: cat.at,
      distributor: req.eo.dist.name,
      typeLabels: TYPE_LABELS,
      parts: cat.counts.parts,
      tools: cat.counts.tools,
      brands: cat.brands,
      // the models with a 3D view
      diagrams: [...d3.byModel.values()].map((d) => ({ brand: d.brand, model: d.model })),
    });
  } catch (e) {
    return fail(res, e, "catalog");
  }
});

router.get("/parts", requireCustomer, async (req, res) => {
  try {
    const cat = await getCatalog();
    let items;
    if (req.query.tools === "1") items = toolParts(cat, orderItem);
    else {
      const brand = text(req.query.brand, 60);
      const model = text(req.query.model);
      if (!brand || !model) return res.status(400).json({ success: false, message: "Pick a model" });
      items = partsForModel(cat, brand, model, orderItem);
    }
    cacheFor(res, 120);
    return res.json({ success: true, items });
  } catch (e) {
    return fail(res, e, "parts");
  }
});

// ── a model's 3D view ──
// The parts in the file, each with its linked items (in stock / out of
// stock, as everywhere in the widget). Items gone from the store drop out.
const itemIndex = new WeakMap(); // catalogue → Map(id → item)
function itemsById(cat) {
  if (!itemIndex.has(cat)) itemIndex.set(cat, new Map(cat.items.map((i) => [i.id, i])));
  return itemIndex.get(cat);
}

router.get("/diagram3d", requireCustomer, async (req, res) => {
  try {
    const brand = text(req.query.brand, 60);
    const model = text(req.query.model);
    const [cat, d3] = await Promise.all([getCatalog(), diagrams3d()]);
    const d = d3.byModel.get(`${brand}|${model}`.toLowerCase());
    if (!d) return res.status(404).json({ success: false, reason: "none", message: "No 3D view for this model" });
    const byId = itemsById(cat);
    cacheFor(res, 120);
    return res.json({
      success: true,
      diagram: {
        id: String(d._id),
        title: d.title || "",
        v: d.file.version,
        bytes: d.file.bytes,
        parts: (d.parts || []).map((p) => ({
          code: p.code,
          label: p.label,
          face: p.face || "",
          items: (p.items || []).map((id) => byId.get(id)).filter(Boolean).map(orderItem),
        })),
      },
    });
  } catch (e) {
    return fail(res, e, "3D diagram");
  }
});

router.get("/diagram3d/:id/model.glb", requireCustomer, async (req, res) => {
  try {
    const d3 = await diagrams3d();
    const d = [...d3.byModel.values()].find((x) => String(x._id) === req.params.id);
    if (!d) return res.status(404).json({ success: false, message: "No 3D view for this model" });
    return await D3.sendFile(req, res, d);
  } catch (e) {
    return fail(res, e, "3D file");
  }
});

router.get("/search", requireCustomer, async (req, res) => {
  try {
    const q = text(req.query.q, 80);
    if (q.length < 2) return res.json({ success: true, models: [], items: [], total: 0 });
    const stock = text(req.query.stock, 5);
    const keep = stock === "in" ? (i) => i.available > 0 : stock === "out" ? (i) => !(i.available > 0) : null;
    const cat = await getCatalog();
    cacheFor(res, 60);
    return res.json({ success: true, ...search(cat, q, orderItem, keep) });
  } catch (e) {
    return fail(res, e, "search");
  }
});

// ── sign in / out ─────────────────────────────────────────────────────
// DEMO: email only (user, 2026-11-06 — "just use email address to login,
// no OTP or password, for testing"). Anyone who knows a registered
// customer's email can sign in as them until email codes replace this.
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const email = text(req.body && req.body.email, 140).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Enter your email address." });
    }
    const db = await connectToDatabase();
    const customer = await db.collection(CUSTOMERS).findOne({
      distributorId: req.eo.dist._id,
      email,
      status: { $ne: "inactive" },
    });
    if (!customer) {
      // Unknown, inactive and other distributors' customers all read the same.
      return res.status(401).json({
        success: false,
        message: `We couldn't find an account for ${email}. Please ask ${req.eo.dist.name} to set one up.`,
      });
    }
    const token = await createSession(db, {
      customerId: customer._id,
      distributorId: req.eo.dist._id,
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
    return res.json({ success: true, token, customer: meView(customer) });
  } catch (e) {
    return fail(res, e, "login");
  }
});

router.post("/logout", async (req, res) => {
  try {
    const db = await connectToDatabase();
    await deleteSession(db, bearer(req));
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "logout");
  }
});

router.get("/me", requireCustomer, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ success: true, customer: meView(req.eo.customer) });
});

// ── orders ────────────────────────────────────────────────────────────
// The cart's lines, merged by part. Returns { lines } or { error }.
function readLines(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: "Your cart is empty." };
  const qtyById = new Map();
  for (const l of raw) {
    const id = text(l && l.itemId, 40);
    const qty = Number(l && l.qty);
    if (!/^\d{1,30}$/.test(id)) return { error: "Your cart has a part we don't recognise. Please remove it and try again." };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: `Quantities must be whole numbers from 1 to ${MAX_QTY}.` };
    qtyById.set(id, Math.min((qtyById.get(id) || 0) + qty, MAX_QTY));
  }
  if (qtyById.size > MAX_LINES) return { error: `An order can have up to ${MAX_LINES} different parts.` };
  return { lines: [...qtyById.entries()].map(([itemId, qty]) => ({ itemId, qty })) };
}

const isOrderable = (r) =>
  r && r.active === true && r.archived === false && r.scope === "parts" && r.showInStore === true && TYPES.includes(r.classification);

router.post("/orders", orderLimiter, requireCustomer, async (req, res) => {
  try {
    const body = req.body || {};
    const { db, dist, customer } = req.eo;
    const clientOrderId = text(body.clientOrderId, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientOrderId)) {
      return res.status(400).json({ success: false, message: "Please refresh the page and try again." });
    }
    await ensureOrderIndexes(db);
    const orders = db.collection(ORDERS);

    // The same checkout sent twice (double click, retry after a timeout).
    const again = await orders.findOne({ customerId: customer._id, clientOrderId });
    if (again) return res.json({ success: true, duplicate: true, order: customerView(again) });

    const parsed = readLines(body.lines);
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });

    // Stock read fresh from the register, not the 10-minute catalogue.
    const ids = parsed.lines.map((l) => l.itemId);
    const rows = await db
      .collection(ITEMS)
      .find(
        { itemId: { $in: ids } },
        { projection: { _id: 0, itemId: 1, name: 1, sku: 1, quality: 1, imageId: 1, active: 1, archived: 1, scope: 1, showInStore: 1, classification: 1, "metrics.available": 1 } },
      )
      .toArray();
    const byId = new Map(rows.map((r) => [String(r.itemId), r]));
    const unavailable = ids.filter((id) => !isOrderable(byId.get(id)));
    const outOfStock = ids.filter((id) => !unavailable.includes(id) && !(Number(byId.get(id).metrics && byId.get(id).metrics.available) > 0));
    if (unavailable.length || outOfStock.length) {
      return res.status(409).json({
        success: false,
        message:
          (outOfStock.length + unavailable.length === 1 ? "A part in your cart is" : "Some parts in your cart are") +
          " out of stock now. Please remove " + (outOfStock.length + unavailable.length === 1 ? "it" : "them") + " and place the order again.",
        outOfStock: [...outOfStock, ...unavailable],
      });
    }

    const lines = parsed.lines.map(({ itemId, qty }) => {
      const r = byId.get(itemId);
      const available = Number(r.metrics && r.metrics.available) || 0;
      return {
        itemId,
        sku: r.sku || "",
        name: r.name || "",
        quality: r.quality || "",
        imageId: r.imageId || null,
        qty,
        // For staff only: what Zoho had when the order came in (hourly sync).
        availableAtOrder: available,
        shortAtOrder: qty > available,
      };
    });
    const units = lines.reduce((s, l) => s + l.qty, 0);
    const delivery = address(body.deliveryAddress);
    const now = new Date();
    const by = customer.email || customer.name || "customer";
    const doc = {
      distributorId: dist._id,
      distributorName: dist.name || "",
      customerId: customer._id,
      customerName: customer.name || "",
      customerEmail: customer.email || "",
      customerPhone: customer.phone || "",
      deliveryAddress: Object.values(delivery).some(Boolean) ? delivery : customer.address || null,
      reference: text(body.reference, 60),
      note: text(body.note, 1000),
      lines,
      lineCount: lines.length,
      units,
      shortLines: lines.filter((l) => l.shortAtOrder).length,
      status: "new",
      staffNote: "",
      history: [{ at: now, by, action: "placed", note: `${lines.length} line${lines.length === 1 ? "" : "s"}, ${units} unit${units === 1 ? "" : "s"}` }],
      clientOrderId,
      source: { origin: req.eo.origin, ip: ipOf(req), userAgent: uaOf(req), preview: req.eo.preview },
      createdAt: now,
      updatedAt: now,
    };

    // Number the order; two orders racing for a number retry.
    let saved = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const { seq, orderNo } = await nextOrderNo(db);
      try {
        await orders.insertOne({ ...doc, seq, orderNo });
        saved = { ...doc, seq, orderNo };
      } catch (e) {
        if (!(e && e.code === 11000)) throw e;
        // The same checkout won a race with itself — hand back that order.
        const dup = await orders.findOne({ customerId: customer._id, clientOrderId });
        if (dup) return res.json({ success: true, duplicate: true, order: customerView(dup) });
      }
    }
    if (!saved) throw new Error("could not number the order");

    try {
      await notifyRoles(db, [ROLES.ADMIN], {
        type: "embed_order_new",
        title: "New embed order",
        message: `${saved.orderNo} from ${saved.customerName} (${saved.distributorName}): ${units} unit${units === 1 ? "" : "s"}${req.eo.preview ? " — placed from the preview" : ""}.`,
        data: { orderNo: saved.orderNo },
      });
    } catch (notifyErr) {
      console.error("[embed order] notify error:", notifyErr && notifyErr.message);
    }

    return res.json({ success: true, order: customerView(saved) });
  } catch (e) {
    return fail(res, e, "order");
  }
});

router.get("/orders", requireCustomer, async (req, res) => {
  try {
    const { db, dist, customer } = req.eo;
    const rows = await db
      .collection(ORDERS)
      .find({ customerId: customer._id, distributorId: dist._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, orders: rows.map(customerView) });
  } catch (e) {
    return fail(res, e, "orders");
  }
});

module.exports = router;
