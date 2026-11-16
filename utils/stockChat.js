// Customer stock chat (2026-11-16) — the shared pieces.
//
// Customers on our enable list get a link (a random token tied to their
// phone number, sent by staff on WhatsApp) to a page where they ask an AI
// about our refurbished stock. What they can see is built here and nowhere
// else:
//
//   · the register's In Stock devices at iMobile or Assigned To Exyon;
//   · minus units Exyon's own database shows sold, being picked, or in a
//     zone that isn't sellable (our register lags behind Exyon's sales);
//   · grouped by Model + Storage + Grade + Colour with a quantity;
//   · priced from our price list (Model + Storage + Grade; a blank storage
//     or grade on a price row covers every storage / grade), else no price
//     ("Contact us").
//
// Never anything else — no cost, supplier, IMEI or location leaves here.

const crypto = require("crypto");
const { connectToDatabase } = require("./mongodb");
const { exQuery } = require("./exDb");

const CUSTOMERS = "refurb_stock_chat_customers";
const PRICES = "refurb_stock_chat_prices";
const SETTINGS = "refurb_stock_chat_settings";
const LOG = "refurb_stock_chat_log";
const DEVICES = "refurb_devices";

const LOCATION_IMOBILE = "iMobile";
const LOCATION_EXYON = "Assigned To Exyon";
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_RETRY_MS = 60 * 1000; // after an Exyon failure, try again sooner
const EX_CHUNK = 500;
// Exyon zones whose units can't be sold right now (closed sale zones,
// stock-take misses, quarantine, units away for fixing).
const EXYON_HIDE_ZONE = /kpay sold|missing|quarantine|fixing/i;

const DEFAULT_SETTINGS = {
  priceNote: "Prices in AUD, ex GST",
  dailyLimit: 40, // questions per customer per day (Melbourne)
};

// ── keys ─────────────────────────────────────────────────────────────
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const modelKey = (v) => clean(v).toLowerCase();
const storageKey = (v) => {
  const s = clean(v).replace(/\s+/g, "").toUpperCase();
  return /^\d+$/.test(s) ? s + "GB" : s; // "128" → "128GB"
};
const gradeKey = (v) => clean(v).toUpperCase();
const colorKey = (v) => clean(v).toLowerCase();

// The date in Melbourne (YYYY-MM-DD) — the daily question cap resets there.
function melbourneDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne" }).format(d);
}

// ── phone numbers / link tokens ─────────────────────────────────────
// Stored as international digits, no "+": "0412 345 678" → "61412345678",
// "+852 9123 4567" → "85291234567", "0061…" → "61…". null when it can't be
// a phone number.
function normalizePhone(raw) {
  const s = String(raw == null ? "" : raw).trim();
  const plus = s.startsWith("+");
  let d = s.replace(/\D/g, "");
  if (!plus) {
    if (d.startsWith("00")) d = d.slice(2);
    else if (/^0[2-9]\d{8}$/.test(d)) d = "61" + d.slice(1); // Australian 0X XXXX XXXX
  }
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

function newToken() {
  return crypto.randomBytes(18).toString("base64url"); // 24 URL-safe chars
}

// ── settings ─────────────────────────────────────────────────────────
async function getSettings(db) {
  const doc = await db.collection(SETTINGS).findOne({ _id: "settings" });
  return { ...DEFAULT_SETTINGS, ...(doc || {}) };
}

// ── Exyon ────────────────────────────────────────────────────────────
// The IMEIs / serials (upper case) Exyon shows as not available: the
// latest stock row for the code has a pick (sold or being picked) or sits
// in a non-sellable zone. Codes Exyon doesn't know stay available — our
// register is the record for those.
async function exyonUnavailable(codes) {
  const out = new Set();
  const list = [...new Set(codes.filter(Boolean))];
  const latest = new Map(); // code → latest stock row
  for (let i = 0; i < list.length; i += EX_CHUNK) {
    const c = list.slice(i, i + EX_CHUNK);
    const rows = await exQuery(
      `SELECT s.id, s.imei, s.serial_number, s.pick_id, z.zone_number, z.location_alias
         FROM exyon.stocks s LEFT JOIN exyon.zone_locations z ON z.id = s.zone_location_id
        WHERE UPPER(s.imei) IN (?) OR UPPER(s.serial_number) IN (?)`,
      [c, c],
    );
    for (const r of rows) {
      for (const code of [r.imei, r.serial_number]) {
        const k = String(code || "").trim().toUpperCase();
        if (!k) continue;
        const prev = latest.get(k);
        if (!prev || Number(r.id) > Number(prev.id)) latest.set(k, r);
      }
    }
  }
  for (const [k, r] of latest) {
    const zone = `${r.zone_number || ""} ${r.location_alias || ""}`;
    if (r.pick_id || EXYON_HIDE_ZONE.test(zone)) out.add(k);
  }
  return out;
}

// ── the stock snapshot (cached, single-flight) ──────────────────────
let cache = null;
let building = null;

async function buildSnapshot() {
  const db = await connectToDatabase();
  const devices = await db
    .collection(DEVICES)
    .find(
      { status: "In Stock", location: { $in: [LOCATION_IMOBILE, LOCATION_EXYON] } },
      { projection: { brand: 1, model: 1, storage: 1, color: 1, grade: 1, imei: 1, serialNumber: 1, location: 1 } },
    )
    .toArray();

  const code = (v) => String(v || "").trim().toUpperCase();
  const atExyon = devices.filter((d) => d.location === LOCATION_EXYON);
  let hidden = new Set();
  let exyonOk = true;
  let exyonError = null;
  try {
    hidden = await exyonUnavailable(atExyon.flatMap((d) => [code(d.imei), code(d.serialNumber)]));
  } catch (e) {
    // Exyon unreachable: the register alone answers (staff see a warning).
    exyonOk = false;
    exyonError = (e && e.message) || String(e);
    console.error("Stock chat: Exyon check failed —", exyonError);
  }

  const available = devices.filter(
    (d) => !(d.location === LOCATION_EXYON && (hidden.has(code(d.imei)) || hidden.has(code(d.serialNumber)))),
  );
  const groups = new Map();
  for (const d of available) {
    const key = [modelKey(d.model), storageKey(d.storage), gradeKey(d.grade), colorKey(d.color)].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        brand: clean(d.brand),
        model: clean(d.model),
        storage: clean(d.storage),
        grade: clean(d.grade),
        color: clean(d.color),
        qty: 0,
      };
      groups.set(key, g);
    }
    g.qty += 1;
  }
  const list = [...groups.values()].sort(
    (a, b) =>
      a.model.localeCompare(b.model, "en", { numeric: true, sensitivity: "base" }) ||
      storageKey(a.storage).localeCompare(storageKey(b.storage), "en", { numeric: true }) ||
      a.grade.localeCompare(b.grade) ||
      a.color.localeCompare(b.color),
  );
  return {
    at: new Date(),
    groups: list,
    units: available.length,
    hiddenAtExyon: devices.length - available.length,
    exyonOk,
    exyonError,
  };
}

async function stockSnapshot({ fresh = false } = {}) {
  const ttl = cache && cache.exyonOk ? SNAPSHOT_TTL_MS : SNAPSHOT_RETRY_MS;
  if (!fresh && cache && Date.now() - cache.at.getTime() < ttl) return cache;
  if (!building) {
    building = buildSnapshot()
      .then((s) => (cache = s))
      .finally(() => { building = null; });
  }
  return building;
}

// ── prices ───────────────────────────────────────────────────────────
async function loadPriceIndex(db) {
  const rows = await db.collection(PRICES).find({}).toArray();
  const idx = new Map();
  for (const r of rows) idx.set([r.modelKey, r.storageKey, r.gradeKey].join("|"), r);
  return idx;
}

// Exact Model + Storage + Grade first, then a row with a blank grade, a
// blank storage, or both.
function priceFor(idx, g) {
  const m = modelKey(g.model);
  const s = storageKey(g.storage);
  const gr = gradeKey(g.grade);
  if (!m) return null;
  for (const k of [[m, s, gr], [m, s, ""], [m, "", gr], [m, "", ""]]) {
    const hit = idx.get(k.join("|"));
    if (hit && hit.price != null) return { price: hit.price, currency: hit.currency || "AUD" };
  }
  return null;
}

// The snapshot's groups with prices — exactly what a customer may see.
async function pricedStock({ fresh = false } = {}) {
  const db = await connectToDatabase();
  const [snap, idx] = await Promise.all([stockSnapshot({ fresh }), loadPriceIndex(db)]);
  const groups = snap.groups.map((g) => {
    const p = priceFor(idx, g);
    return { ...g, price: p ? p.price : null, currency: p ? p.currency : null };
  });
  return { ...snap, groups };
}

module.exports = {
  CUSTOMERS,
  PRICES,
  SETTINGS,
  LOG,
  DEFAULT_SETTINGS,
  clean,
  modelKey,
  storageKey,
  gradeKey,
  colorKey,
  melbourneDay,
  normalizePhone,
  newToken,
  getSettings,
  stockSnapshot,
  pricedStock,
  priceFor,
};
