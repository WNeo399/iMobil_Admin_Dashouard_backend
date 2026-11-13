// iMobile Repair — the SHOP PORTAL (2026-11-13, user: "a new role for the
// shops in iMobile Repair … login to the portal to see all their tickets and
// also enable them to create new tickets").
//
// A login with the Repair Customer role is linked to ONE shop group of
// iMobile Repair → Shops (users.repairShopGroupId); every route here is scoped
// to that group's RepairDesk customers ON THE SERVER — a ticket of another
// customer answers 404, like one that doesn't exist. What a shop sees is a
// whitelist: ticket number, dates, and per device the model, IMEI / serial,
// status, due date and the services' names. NO prices (user: "hide prices"),
// no passcode, no staff, no payments.
//
// Notes (user 2026-11-13: "see the note history, and able to leave note"; on
// which: "Shared notes only"): a shop sees RepairDesk's DIAGNOSTIC notes only
// (type 1) — staff's internal notes (type 0) hold prices, passcodes, part
// grades and staff names and never leave the server. No author either: a note
// the shop wrote here is the shop's, any other is "iMobile". A shop's note is
// a diagnostic note headed "[Shop portal] <shop> (<login>):"; on a ticket
// waiting for their reply ("Awaiting reply" / "Waiting on Customer") those
// devices then move to the "Customer Replied" status (user: "a new
// status when customer leaved a note for awaiting reply tickets"). Logged in
// Mongo imb_repair_portal_notes.
// FOR NOW (user 2026-11-13, on 0-35483's internal "password requested" note:
// "enable these message in the portal for now") internal notes are shown too
// — prices and part grades included — until staff write shop-facing notes as
// Diagnostic: NOTE_OPTS.showInternal. Still never shown: the author, and the
// dashboard's own automatic notes (status changes / assignments name staff;
// "Created by the shop login").
//
// Their tickets: RepairDesk's /tickets has no customer filter, but its keyword
// search matches a customer's phone / email across every ticket (all time, not
// the Tickets page's 60-day window) — so each shop's phone (else email) is
// searched — every page of it (≤ 2,000 a key), newest first — and only the
// group's customers' tickets kept; the portal page paginates them. A shop
// with neither falls back to the 60-day window.
//
// New tickets (user: "device + repair services", start status "Pending"):
// brands + models come from RepairDesk's /devices, a model's services from
// /problems/{device} — loaded step by step as the shop picks (2026-11-13: the
// whole-catalogue /repaircategories took 12–15 s). The services are checked
// against /problems again on create; their price / GST are RepairDesk's own
// (all $0 in this account on 2026-11-13) and never shown. An internal note on the new ticket says which shop login made it.
// Logged in Mongo imb_repair_portal_tickets.
//
// Mounted under /repair/portal by routes/repairRoutes/index.js.
//   GET  /me                          the linked group + its shops (linked: false if none)
//   GET  /tickets?shop=               { tickets (all, newest first), complete, notSearchable }
//   GET  /tickets/:id                 one ticket + its shared notes (404 unless it is the group's)
//   POST /tickets/:id/notes { text }  the shop's note → { ticket (fresh), replied, statusFailed }
//   GET  /tickets/:id/label           the 50×40 label's text, one per device (user 2026-11-13:
//                                     "enable print 50*40 label in the portal" — RepairDesk's own
//                                     label: model, repair, IMEI, the fault, Code 128 of the ticket
//                                     number, "Repair Ticket # …", the customer's name + mobile)
//   GET  /catalog/brands              the brands (id, name, models count)
//   GET  /catalog/brands/:id/models   one brand's models (ids, names)
//   GET  /catalog/devices/:id/services  a model's services (ids, names; "Other" last)
//   POST /tickets { shopId, devices: [ONE { deviceId, serviceIds, imei?, serial?, passcode, fault }], dryRun? }

var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const BASE = "https://api.repairdesk.co/api/web/v1";
const VIEW = requirePermission("repair:portal:view");
const CREATE = requirePermission("repair:portal:create");
const NOTE = requirePermission("repair:portal:note");
const GROUPS = "imb_repair_shop_groups";
const CUSTOMER_KEYS = "imb_repair_customer_keys"; // a shop's phone / email, for the search
const LOG = "imb_repair_portal_tickets";
const START_STATUS = "Pending"; // user 2026-11-13
const PAGE_SIZE = 100;
const MAX_DEVICES = 1; // one device per ticket (user 2026-11-13: "one device one ticket")
const FAULT_MAX = 1000;
// "Other" (user 2026-11-13: "always allow Other as a repair needed option"):
// offered for EVERY model, last in the list. RepairDesk keeps an "other" issue
// as a repair line with no service id named "Other Issue: <the fault>" (as
// tickets from its own portal show), so that is what it sends — and the fault
// description is required with it. The catalogue's own "Other" / "Others"
// entries (243 of 1,520 models) are left out: this one stands for them.
const OTHER_ID = "other";
const OTHER_NAME_RE = /^\s*others?\s*$/i;
const OTHER_ITEM_MAX = 250; // the "Other Issue: …" line (the full fault is in staff_comments)
const DAY = 24 * 60 * 60 * 1000;
// notes (2026-11-13)
const NOTES_LOG = "imb_repair_portal_notes";
const NOTE_MAX = 2000;
const SHARED_NOTE = 1; // RepairDesk's "diagnostic" note type — the ones a shop sees
const PORTAL_TAG = "[Shop portal]";
const PORTAL_RE = /^\[Shop portal\] (.+?) \([^()\n]*\):\n/;
const NEEDS_REPLY = ["awaiting reply", "waiting on customer"];
// An OPEN status the user adds in RepairDesk (user 2026-11-13: "New Open
// status"). RepairDesk's API refuses EVERY "On hold" status — its own "Customer
// Reply" and "Waiting on Customer" both answer 400 "Invalid Ticket Status"
// (tried live on the test ticket 0-35896), while Open ones ("In Progress") work.
const REPLIED_STATUS = "Customer Replied";
// re-reading a ticket after its status moved (RepairDesk shows it a moment later)
const REREAD_TRIES = 4;
const REREAD_GAP_MS = 900;
// showInternal: true FOR NOW (user 2026-11-13) — false = "Shared notes only"
// again (diagnostic notes + the shop's own). Tests flip it.
const NOTE_OPTS = { showInternal: true };
router._noteOpts = NOTE_OPTS;
// the dashboard's own automatic notes (routes/repairRoutes/index.js + the
// new-ticket note below): they name staff, and the timeline has the change
const AUTO_NOTE_RE = /^(Status changed (from|to) "|Assigned to |Created by the shop login ")[\s\S]*iMobile dashboard/;
// a new ticket's staff_comments signature ("— <group> / <shop> (<login>, iMobile
// dashboard)"); RepairDesk files staff_comments as an internal note — seen
// live on 0-35896 (2026-11-13) — so that note is the shop's fault, not iMobile's
const CREATE_SIGN_RE = /\n?— [^\n]*? \/ ([^\n]*) \([^()\n]*, iMobile dashboard\)$/;

const str = (v) => String(v == null ? "" : v).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const actor = (req) => (req.user && req.user.username) || "unknown";

function apiKey() {
  const key = process.env.IMB_REPAIRDESK_API_KEY;
  if (!key) { const e = new Error("IMB_REPAIRDESK_API_KEY is not configured"); e.status = 500; throw e; }
  return key;
}
// RepairDesk calls in one place (tests swap these)
const rd = {
  get: (path, params = {}) => axios.get(BASE + path, { params: { api_key: apiKey(), ...params }, timeout: 60000 }).then((r) => r.data),
  post: (path, body) => axios.post(`${BASE}${path}?api_key=${encodeURIComponent(apiKey())}`, body, { timeout: 60000 }).then((r) => r.data),
};
router._rd = rd;

// ── small caches ──
const cache = new Map(); // key → { at, value }
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
router._cache = cache;

// the account's statuses → their type (Open / Closed / On hold / warranty repair / Cancelled)
async function statusTypes() {
  return cached("statuses", 10 * 60 * 1000, async () => {
    const d = await rd.get("/statuses");
    const m = new Map();
    for (const s of (d && d.data) || []) if (s && s.name && !m.has(s.name)) m.set(s.name, s.type || "");
    return m;
  });
}

// RepairDesk's brands + models, from /devices: every model with its brand in
// one quick answer (~0.4 s; 1,640 models / 22 brands on 2026-11-13). The old
// source, /repaircategories, sends every brand, model AND repair at once —
// 5 MB, 12–15 s (user: "the New repair ticket dialog load very slow"; then
// "load the brand first … after select the brand, load the model and then
// load the repair need"). Kept an hour.
const DEVICES_TTL = 60 * 60 * 1000;
// one-model junk brands (user 2026-11-13: "hide Hooli and Nova 3i")
const HIDDEN_BRANDS = /^(hooli|nova 3i)$/i;
async function devicesList() {
  return cached("devices", DEVICES_TTL, async () => {
    const d = await rd.get("/devices");
    const byId = new Map(); // brand id → { id, name, models: [{ id, name }] }
    const models = new Map(); // model id → { id, name, brand, brandId }
    for (const x of (d && d.data) || []) {
      const id = str(x && x.id);
      const name = str(x && x.name);
      const brandId = str(x && x.manufacturer_id);
      const brand = str(x && x.company);
      if (!id || !name || !brandId || HIDDEN_BRANDS.test(brand)) continue;
      if (!byId.has(brandId)) byId.set(brandId, { id: brandId, name: brand || `Brand ${brandId}`, models: [] });
      byId.get(brandId).models.push({ id, name });
      models.set(id, { id, name, brand, brandId });
    }
    for (const b of byId.values()) b.models.sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }));
    const brands = [...byId.values()].sort((a, c) => a.name.localeCompare(c.name));
    return { brands, byId, models };
  });
}

// A model's repairs: RepairDesk's /problems/{model} (~0.3 s) — the same list a
// new ticket is checked and priced against. Names only; the catalogue's own
// "Other" / "Others" left out and ours last. Kept 10 minutes.
async function servicesFor(modelId) {
  return cached(`problems:${modelId}`, 10 * 60 * 1000, async () => {
    const d = await rd.get(`/problems/${encodeURIComponent(modelId)}`);
    const services = [];
    const seen = new Set();
    for (const p of (d && d.data) || []) {
      const name = str(p && p.name);
      if (!p || !p.id || !name || seen.has(name.toLowerCase()) || OTHER_NAME_RE.test(name)) continue;
      seen.add(name.toLowerCase());
      services.push({ id: String(p.id), name });
    }
    services.sort((a, c) => a.name.localeCompare(c.name));
    services.push({ id: OTHER_ID, name: "Other" }); // always offered, last
    return services;
  });
}

// ── the caller's shop group ──
async function myGroup(req) {
  const id = req.user && req.user.repairShopGroupId;
  if (!id || !ObjectId.isValid(String(id))) return null;
  const db = await connectToDatabase();
  const g = await db.collection(GROUPS).findOne({ _id: new ObjectId(String(id)) });
  if (!g) return null;
  const shops = (g.customers || []).map((c) => ({ id: String(c.id), name: str(c.name) || str(c.organization) || `Customer ${c.id}` }));
  return { id: String(g._id), name: g.name || "", shops };
}
// the group, or a 403 answered
async function groupOr403(req, res) {
  const g = await myGroup(req);
  if (!g || !g.shops.length) {
    res.status(403).json({ success: false, message: "This login isn't linked to a shop yet — please ask iMobile to link it" });
    return null;
  }
  return g;
}

// a shop's search key: its mobile, else phone, else email (24 h cache in Mongo)
async function searchKeys(shops) {
  const db = await connectToDatabase();
  const col = db.collection(CUSTOMER_KEYS);
  const ids = shops.map((s) => s.id);
  const have = new Map((await col.find({ _id: { $in: ids } }).toArray()).map((d) => [d._id, d]));
  for (const id of ids) {
    const c = have.get(id);
    if (c && Date.now() - new Date(c.at).getTime() < DAY) continue;
    try {
      await sleep(150); // RepairDesk throttles bursts
      const d = await rd.get(`/customers/${encodeURIComponent(id)}`);
      const x = (d && d.data) || {};
      const doc = { _id: id, mobile: str(x.mobile), phone: str(x.phone), email: str(x.email).toLowerCase(), name: str(x.fullname), at: new Date() };
      await col.updateOne({ _id: id }, { $set: doc }, { upsert: true });
      have.set(id, doc);
    } catch (e) {
      console.error("Repair portal — customer", id, e.message);
    }
  }
  return new Map(ids.map((id) => { const c = have.get(id) || {}; return [id, c.mobile || c.phone || c.email || ""]; }));
}

const customerIdOf = (t) => {
  const c = (t && t.summary && t.summary.customer) || {};
  return String(c.id || c.cid || "");
};
// a device's progress from RepairDesk's status_history (detail only): each
// status it entered and when — no user names, no prices (the free-text
// `hostory` has both and is never read)
function timelineOf(t, deviceId, single) {
  const rows = Array.isArray(t.status_history) ? t.status_history : [];
  return rows
    .filter((h) => h && h.status && h.entered_at && (single || String(h.item_id) === String(deviceId)))
    .map((h) => ({ status: str(h.status), at: Number(h.entered_at) * 1000 }))
    .sort((a, b) => a.at - b.at);
}

// What a shop may see of a ticket — a whitelist (no prices, notes, passcode, staff, payments)
function shopView(t, types, shopName) {
  const s = t.summary || {};
  const single = (t.devices || []).length === 1;
  return {
    id: s.id,
    ticketNumber: String(s.order_id || ""),
    created: s.created_date ? s.created_date * 1000 : null,
    shopId: customerIdOf(t),
    shop: shopName || str(s.customer && (s.customer.fullName || s.customer.fullname)),
    devices: (t.devices || []).map((d) => {
      const status = str(d.status && d.status.name);
      return {
        id: String(d.id || ""),
        name: str((d.device && d.device.name) || d.name),
        imei: str(d.imei),
        serial: str(d.serial),
        status,
        statusType: types.get(status) || "",
        services: (d.repairProdItems || []).map((x) => str(x && x.name)).filter(Boolean),
        dueOn: d.due_on > 0 ? d.due_on * 1000 : null,
        // the detail's progress (the list has no status_history → [])
        timeline: timelineOf(t, d.id, single).map((h) => ({ ...h, type: types.get(h.status) || "" })),
      };
    }),
  };
}

// A note's text as plain text: RepairDesk may hold <br> / entities
function plainText(v) {
  return String(v == null ? "" : v)
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&")
    .trim();
}
// The ticket's notes a shop sees, oldest first: diagnostic notes (+ internal
// ones while NOTE_OPTS.showInternal), never the dashboard's automatic ones;
// no author — a portal note shows its shop, any other is iMobile's (the staff
// page's "— user (iMobile dashboard)" signature line is cut off)
function notesOf(t) {
  const names = new Map((t.devices || []).map((d) => [String(d.id), str((d.device && d.device.name) || d.name)]));
  const many = (t.devices || []).length > 1;
  return (Array.isArray(t.notes) ? t.notes : [])
    .filter((n) => n && (Number(n.type) === SHARED_NOTE || NOTE_OPTS.showInternal))
    .filter((n) => !AUTO_NOTE_RE.test(plainText(n.msg_text)))
    .map((n) => {
      let text = plainText(n.msg_text);
      let shop = "";
      const m = text.match(PORTAL_RE);
      const c = m ? null : text.match(CREATE_SIGN_RE);
      if (m) {
        shop = m[1];
        text = text.slice(m[0].length).trim();
      } else if (c) {
        // the fault typed on the portal's new ticket (RepairDesk files the
        // ticket's staff_comments as an internal note): the shop's own words
        shop = c[1];
        text = text.slice(0, c.index).trim();
      } else {
        text = text.replace(/\n?— [^\n]*\(iMobile dashboard\)$/, "").trim();
      }
      return {
        id: str(n.id),
        at: Number(n.created_on) > 0 ? Number(n.created_on) * 1000 : null,
        from: shop ? "shop" : "imobile",
        shop,
        device: many ? names.get(str(n.deviceId)) || "" : "",
        text,
      };
    })
    .filter((n) => n.text)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}
const detailView = (t, types, shopName) => ({ ...shopView(t, types, shopName), notes: notesOf(t) });

// ── GET /me ──
router.get("/me", VIEW, async function (req, res) {
  try {
    const g = await myGroup(req);
    if (!g) return res.json({ success: true, linked: false });
    return res.json({ success: true, linked: true, group: { id: g.id, name: g.name }, shops: g.shops });
  } catch (error) {
    console.error("Repair portal /me error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to load your shop" });
  }
});

// ── GET /tickets?shop= ── ALL the group's tickets (or one shop's), newest
// first (user 2026-11-13: pagination — the page pages through them, with
// exact counts per filter). Every page of each shop's phone / email search is
// read (≤ MAX_KEY_PAGES × 100 per key, each page cached 3 min); `complete`
// false = a key hit that cap and the oldest tickets are left out.
const MAX_KEY_PAGES = 20;
router.get("/tickets", VIEW, async function (req, res) {
  try {
    const g = await groupOr403(req, res);
    if (!g) return;
    const only = str(req.query.shop);
    const shops = only ? g.shops.filter((s) => s.id === only) : g.shops;
    if (!shops.length) return res.status(404).json({ success: false, message: "Not one of your shops" });
    const wanted = new Map(shops.map((s) => [s.id, s.name]));
    const keys = await searchKeys(shops);
    const types = await statusTypes();
    const distinct = [...new Set([...keys.values()].filter(Boolean))];
    const raw = new Map();
    let complete = true;
    let calls = 0;
    for (const kw of distinct) {
      for (let page = 1; page <= MAX_KEY_PAGES; page++) {
        const key = `kw:${kw}:${page}`;
        const fresh = !cache.has(key) || Date.now() - cache.get(key).at >= 3 * 60 * 1000;
        if (fresh && calls++) await sleep(150); // RepairDesk throttles bursts
        const d = await cached(key, 3 * 60 * 1000, () => rd.get("/tickets", { keyword: kw, pagesize: PAGE_SIZE, page, default_order: 1 }));
        const data = (d && d.data) || {};
        for (const t of data.ticketData || []) if (wanted.has(customerIdOf(t))) raw.set(String(t.summary.id), t);
        if (!(data.pagination && Number(data.pagination.next_page_exist))) break;
        if (page === MAX_KEY_PAGES) complete = false;
      }
    }
    // a shop with no phone / email: the last 60 days
    const keyless = shops.filter((s) => !keys.get(s.id));
    if (keyless.length) {
      const ids = new Set(keyless.map((s) => s.id));
      const d = await cached("window60", 5 * 60 * 1000, () => rd.get("/tickets", { filter: 60, pagesize: 1000, page: 1 }));
      for (const t of ((d && d.data) || {}).ticketData || []) if (ids.has(customerIdOf(t))) raw.set(String(t.summary.id), t);
    }
    const tickets = [...raw.values()]
      .map((t) => shopView(t, types, wanted.get(customerIdOf(t))))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    return res.json({ success: true, tickets, complete, notSearchable: keyless.map((s) => s.name) });
  } catch (error) {
    console.error("Repair portal /tickets error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load your tickets — please try again" });
  }
});

// ── GET /tickets/:id ── one ticket, only if it is the group's
router.get("/tickets/:id", VIEW, async function (req, res) {
  try {
    const g = await groupOr403(req, res);
    if (!g) return;
    const id = str(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return res.status(404).json({ success: false, message: "Ticket not found" });
    const d = await rd.get(`/tickets/${id}`);
    const t = d && d.data;
    const shop = t && t.summary ? g.shops.find((s) => s.id === customerIdOf(t)) : null;
    if (!shop) return res.status(404).json({ success: false, message: "Ticket not found" });
    return res.json({ success: true, ticket: detailView(t, await statusTypes(), shop.name) });
  } catch (error) {
    console.error("Repair portal /tickets/:id error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load the ticket" });
  }
});

// ── GET /tickets/:id/label ── what the 50×40 label prints, per device line.
// Only the label's own fields: the customer line is the shop's own name and
// mobile as RepairDesk holds them. The fault line: the "Other Issue: …" text is
// already in the repair line; otherwise the fault the shop typed in the portal
// (from the create log), if the ticket was made here.
const repairText = (items) =>
  (items || []).map((x) => String((x && x.name) || "")).join(",")
    .replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/^[,\s]+|[,\s]+$/g, "").trim();
function faultFromLog(log, i) {
  const d = log && log.payload && Array.isArray(log.payload.devices) ? log.payload.devices[i] : null;
  const c = String((d && d.staff_comments) || "");
  const cut = c.lastIndexOf("\n— ");
  return (cut >= 0 ? c.slice(0, cut) : c.startsWith("— ") ? "" : c).replace(/\s+/g, " ").trim();
}
router.get("/tickets/:id/label", VIEW, async function (req, res) {
  try {
    const g = await groupOr403(req, res);
    if (!g) return;
    const id = str(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return res.status(404).json({ success: false, message: "Ticket not found" });
    const d = await rd.get(`/tickets/${id}`);
    const t = d && d.data;
    const shop = t && t.summary ? g.shops.find((x) => x.id === customerIdOf(t)) : null;
    if (!shop) return res.status(404).json({ success: false, message: "Ticket not found" });
    const c = t.summary.customer || {};
    const db = await connectToDatabase();
    const log = await db.collection(LOG).findOne({ ticketId: { $in: [Number(id), id] }, ok: true });
    const labels = (t.devices || []).map((x, i) => {
      const make = str(x.manufacturer_name);
      const model = str(x.device_name) || str(x.device && x.device.name);
      const repair = repairText(x.repairProdItems);
      return {
        ticketNumber: String(t.summary.order_id || ""),
        title: make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model || make,
        repair,
        imei: str(x.imei),
        serial: str(x.serial),
        fault: /Other Issue:/i.test(repair) ? "" : faultFromLog(log, i),
        customer: str(c.fullName || c.fullname) || shop.name,
        phone: str(c.mobile) || str(c.phone),
      };
    });
    return res.json({ success: true, labels });
  } catch (error) {
    console.error("Repair portal label error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load the label" });
  }
});

// ── POST /tickets/:id/notes { text } ── the shop's note on one of its tickets
// (a shared note); devices waiting for the shop's reply → "Customer Replied".
// Answers the ticket re-read from RepairDesk.
const noting = new Set(); // logins sending a note right now (a double click sends one)
router.post("/tickets/:id/notes", NOTE, async function (req, res) {
  const bad = (message, code = 400) => res.status(code).json({ success: false, message });
  const who = actor(req);
  const text = plainText(req.body && req.body.text);
  if (!text) return bad("Write a note");
  if (text.length > NOTE_MAX) return bad(`A note is at most ${NOTE_MAX} characters`);
  if (noting.has(who)) return bad("Your note is being sent — please wait", 409);
  noting.add(who);
  try {
    const g = await groupOr403(req, res);
    if (!g) return;
    const id = str(req.params.id);
    if (!/^\d{1,12}$/.test(id)) return bad("Ticket not found", 404);
    const d = await rd.get(`/tickets/${id}`);
    const t = d && d.data;
    const shop = t && t.summary ? g.shops.find((s) => s.id === customerIdOf(t)) : null;
    if (!shop) return bad("Ticket not found", 404);
    let types = await statusTypes();
    const db = await connectToDatabase();
    const log = { at: new Date(), by: who, groupId: g.id, shopId: shop.id, ticketId: id, ticketNumber: String(t.summary.order_id || ""), text };

    // 1. the note — shared, headed so staff (and this page) know it is the shop's
    let r;
    try {
      r = await rd.post("/ticket/addnote", { id: Number(id), type: SHARED_NOTE, is_flag: 0, note: `${PORTAL_TAG} ${shop.name} (${who}):\n${text}` });
    } catch (e) {
      r = { success: false, message: (e.response && e.response.data && e.response.data.message) || e.message };
    }
    if (!r || r.success === false) {
      await db.collection(NOTES_LOG).insertOne({ ...log, ok: false, error: (r && r.message) || "no answer" });
      return bad("RepairDesk didn't take the note — please try again", 502);
    }

    // 2. waiting for the shop's reply → "Customer Replied" (each device line)
    const waiting = (t.devices || []).filter((x) => NEEDS_REPLY.includes(str(x.status && x.status.name).toLowerCase()));
    const replied = [];
    const failed = [];
    // a status added in RepairDesk while the list is cached: read the list again
    if (waiting.length && !types.has(REPLIED_STATUS)) {
      cache.delete("statuses");
      types = await statusTypes();
    }
    if (waiting.length && types.has(REPLIED_STATUS)) {
      for (const x of waiting) {
        const line = { id: String(x.id), from: str(x.status && x.status.name) };
        try {
          const s = await rd.post("/ticket/updateticketstatus", { id: Number(id), ticketInvId: Number(x.id), status: REPLIED_STATUS });
          if (s && s.success) replied.push(line);
          else failed.push({ ...line, message: (s && ((s.data && s.data.message) || s.message)) || "refused" });
        } catch (e) {
          failed.push({ ...line, message: (e.response && e.response.data && e.response.data.message) || e.message });
        }
      }
    } else if (waiting.length) {
      failed.push(...waiting.map((x) => ({ id: String(x.id), message: `RepairDesk has no "${REPLIED_STATUS}" status` })));
    }
    await db.collection(NOTES_LOG).insertOne({ ...log, ok: true, replied, failed });
    // a status moved: the list's cached pages are stale
    if (replied.length) for (const k of [...cache.keys()]) if (k.startsWith("kw:") || k === "window60") cache.delete(k);

    // the ticket as RepairDesk now holds it. RepairDesk applies a status change
    // a moment AFTER answering (seen live on 0-35896, 2026-11-13: the call
    // answered at :07, the ticket showed "Customer Replied" from :09), so with
    // a status moved it is read again until it shows — up to ~3 s — and what is
    // still missing then is filled in from what RepairDesk said it took.
    let fresh = t;
    const statusIn = (tk) => replied.every((x) => (tk.devices || []).some((dv) => String(dv.id) === x.id && str(dv.status && dv.status.name) === REPLIED_STATUS));
    for (let i = 0; i < (replied.length ? REREAD_TRIES : 1); i++) {
      if (i) await sleep(REREAD_GAP_MS);
      try {
        const f = await rd.get(`/tickets/${id}`);
        if (f && f.data && f.data.summary) fresh = f.data;
      } catch (e) {
        // the note is in; the page re-reads later
      }
      if (statusIn(fresh)) break;
    }
    const view = detailView(fresh, types, shop.name);
    const now = Date.now();
    for (const dv of view.devices) {
      if (!replied.some((x) => x.id === dv.id) || dv.status === REPLIED_STATUS) continue;
      dv.status = REPLIED_STATUS;
      dv.statusType = types.get(REPLIED_STATUS) || "";
      dv.timeline = [...dv.timeline, { status: REPLIED_STATUS, at: now, type: dv.statusType }];
    }
    if (!view.notes.some((n) => n.from === "shop" && n.text === text)) {
      view.notes.push({ id: `new-${now}`, at: now, from: "shop", shop: shop.name, device: "", text });
    }
    return res.json({ success: true, ticket: view, replied: replied.length, statusFailed: failed.length > 0 });
  } catch (error) {
    console.error("Repair portal note error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to send the note — please try again" });
  } finally {
    noting.delete(who);
  }
});

// ── GET /catalog/brands ── the new-ticket form's first step
router.get("/catalog/brands", VIEW, async function (req, res) {
  try {
    const c = await devicesList();
    return res.json({ success: true, brands: c.brands.map((b) => ({ id: b.id, name: b.name, models: b.models.length })) });
  } catch (error) {
    console.error("Repair portal brands error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load the brands" });
  }
});

// ── GET /catalog/brands/:id/models ── one brand's models
router.get("/catalog/brands/:id/models", VIEW, async function (req, res) {
  try {
    const b = (await devicesList()).byId.get(str(req.params.id));
    if (!b) return res.status(404).json({ success: false, message: "Unknown brand" });
    return res.json({ success: true, brand: { id: b.id, name: b.name }, models: b.models });
  } catch (error) {
    console.error("Repair portal models error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load the models" });
  }
});

// ── GET /catalog/devices/:id/services ── a model's repairs (names only, "Other" last)
router.get("/catalog/devices/:id/services", VIEW, async function (req, res) {
  try {
    const m = (await devicesList()).models.get(str(req.params.id));
    if (!m) return res.status(404).json({ success: false, message: "Unknown model" });
    const services = await servicesFor(m.id);
    return res.json({ success: true, device: { id: m.id, name: m.name, brand: m.brand }, services });
  } catch (error) {
    console.error("Repair portal services error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to load the services" });
  }
});

// ── POST /tickets ── a new ticket in RepairDesk for one of the group's shops
const creating = new Set(); // logins creating right now (a double click makes one)
router.post("/tickets", CREATE, async function (req, res) {
  const bad = (message, code = 400) => res.status(code).json({ success: false, message });
  const who = actor(req);
  const b = req.body || {};
  const dryRun = !!b.dryRun;
  if (!dryRun && creating.has(who)) return bad("A ticket is being created already — please wait", 409);
  // taken at once: a second click arriving while this one checks the form is refused
  if (!dryRun) creating.add(who);
  try {
    const g = await groupOr403(req, res);
    if (!g) return;
    const shop = g.shops.find((s) => s.id === str(b.shopId));
    if (!shop) return bad("Pick one of your shops");
    const asked = Array.isArray(b.devices) ? b.devices : [];
    if (!asked.length) return bad("Add a device");
    if (asked.length > MAX_DEVICES) return bad("One device per ticket");
    const cat = await devicesList();
    const lines = [];
    for (const x of asked) {
      const model = cat.models.get(str(x && x.deviceId));
      if (!model) return bad("Pick the model from the list");
      const ids = [...new Set((Array.isArray(x.serviceIds) ? x.serviceIds : []).map(str).filter(Boolean))];
      const fault = str(x.fault).slice(0, FAULT_MAX);
      if (!ids.length && !fault) return bad("Pick the repair needed, or describe the fault");
      if (ids.includes(OTHER_ID) && !fault) return bad("Describe the fault for Other");
      const imei = str(x.imei).replace(/\s+/g, "");
      const serial = str(x.serial).replace(/\s+/g, "");
      // both optional (user 2026-11-13); an IMEI given must look like one
      if (imei && !/^[0-9A-Za-z]{6,20}$/.test(imei)) return bad(`"${imei}" doesn't look like an IMEI`);
      if (serial && serial.length > 40) return bad("The serial number is too long");
      lines.push({ model, ids, fault, imei, serial, passcode: str(x.passcode).slice(0, 60) });
    }
    if (!(await statusTypes()).has(START_STATUS)) return bad(`RepairDesk has no "${START_STATUS}" status`, 502);

    // each model's services as RepairDesk prices them now (never shown to the
    // shop) — a service it doesn't list (any more) is refused
    const devices = [];
    for (const l of lines) {
      let priced = [];
      const catIds = l.ids.filter((id) => id !== OTHER_ID);
      if (catIds.length) {
        const d = await rd.get(`/problems/${l.model.id}`);
        const rows = (d && d.data) || [];
        priced = catIds.map((id) => rows.find((r) => String(r.id) === id)).filter(Boolean);
        if (priced.length !== catIds.length) {
          cache.delete(`problems:${l.model.id}`); // the form's list is stale
          return bad(`A service isn't offered for the ${l.model.name} — please pick the repair again`);
        }
        await sleep(120);
      }
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      const taxClass = priced.map((p) => p.tax_class && p.tax_class.id).find(Boolean);
      const sign = `— ${g.name} / ${shop.name} (${who}, iMobile dashboard)`;
      devices.push({
        device: l.model.id,
        status: START_STATUS,
        task_type: 0, // repair
        repairProdItems: [
          ...priced.map((p) => ({ id: String(p.id), name: str(p.name) })),
          // RepairDesk's free-text issue line (no service id, no price)
          ...(l.ids.includes(OTHER_ID) ? [{ id: "", name: `Other Issue: ${l.fault.replace(/\s+/g, " ").slice(0, OTHER_ITEM_MAX)}` }] : []),
        ],
        price: Math.round(priced.reduce((t, p) => t + num(p.price), 0) * 100) / 100,
        gst: Math.round(priced.reduce((t, p) => t + num(p.gst), 0) * 100) / 100,
        tax_inclusive: priced.length && priced.every((p) => String(p.tax_inclusive) === "0") ? "0" : "1",
        ...(taxClass ? { taxclass: Number(taxClass) } : {}),
        imei: l.imei,
        serial: l.serial,
        security_code: l.passcode,
        staff_comments: l.fault ? `${l.fault}\n${sign}` : sign,
      });
    }
    const payload = { summary: { customer_id: shop.id }, devices };
    // a preview of what goes to RepairDesk — without its prices (never shown to a shop)
    if (dryRun) {
      const shown = { ...payload, devices: devices.map(({ price, gst, tax_inclusive, taxclass, ...rest }) => rest) };
      return res.json({ success: true, dryRun: true, payload: shown });
    }

    const db = await connectToDatabase();
    const now = new Date();
    let r;
    try {
      r = await rd.post("/tickets", payload);
    } catch (e) {
      const msg = (e.response && e.response.data && (e.response.data.message || JSON.stringify(e.response.data).slice(0, 200))) || e.message;
      await db.collection(LOG).insertOne({ at: now, by: who, groupId: g.id, shopId: shop.id, payload, ok: false, error: msg });
      return bad(`RepairDesk didn't take the ticket: ${msg}`, 502);
    }
    const data = (r && r.data) || {};
    if (!r || r.success === false || !data.id) {
      const msg = (r && (r.message || (r.data && r.data.message))) || "no ticket came back";
      await db.collection(LOG).insertOne({ at: now, by: who, groupId: g.id, shopId: shop.id, payload, ok: false, error: msg, response: r || null });
      return bad(`RepairDesk didn't take the ticket: ${msg}`, 502);
    }
    // an internal note: which shop login made it (best effort)
    let noted = true;
    try {
      await rd.post("/ticket/addnote", { id: Number(data.id), type: 0, is_flag: 0, note: `Created by the shop login "${who}" (${g.name} / ${shop.name}) on the iMobile dashboard.` });
    } catch (e) {
      noted = false;
    }
    await db.collection(LOG).insertOne({ at: now, by: who, groupId: g.id, shopId: shop.id, payload, ok: true, ticketId: data.id, ticketNumber: String(data.order_id || ""), noted });
    // the list's cached pages are stale now
    for (const k of [...cache.keys()]) if (k.startsWith("kw:") || k === "window60") cache.delete(k);
    return res.json({ success: true, id: data.id, ticketNumber: String(data.order_id || "") });
  } catch (error) {
    console.error("Repair portal create error:", error.message);
    return res.status(502).json({ success: false, message: "Failed to create the ticket — please try again" });
  } finally {
    if (!dryRun) creating.delete(who);
  }
});

module.exports = router;
