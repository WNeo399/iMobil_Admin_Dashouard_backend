// Customer stock chat (2026-11-16) — the shared pieces.
//
// Customers on our enable list get a link (a random token tied to their
// phone number, sent by staff on WhatsApp) to a page where they ask an AI
// about our refurbished stock. What they can see is built here and nowhere
// else:
//
//   · the register's In Stock devices at iMobile or Assigned To Exyon;
//   · minus units at Assigned To Exyon that Exyon's own database shows sold,
//     being picked, or in a zone that isn't sellable (our register lags
//     behind Exyon). Units Exyon hasn't received yet (no stock row: in
//     transit, or on a receiving list not counted in) ARE shown (user
//     2026-11-17) — staff see how many in the preview;
//   · graded the chat's way (user 2026-11-27, chatGrade below): Exyon's
//     grade for a unit at Assigned To Exyon (ours when Exyon has none yet),
//     grouped into A+ 100% Battery / A / B / C (D, E as they are);
//   · grouped by Model + Storage + that Grade + Colour with a quantity;
//   · priced from our price list (Model + Storage + Grade; a blank storage
//     or grade on a price row covers every storage / grade; a grade group is
//     priced at its own grade, A+ 100% Battery at A+), else no price
//     ("Contact us");
//   · minus what open chat orders hold (2026-11-25, utils/stockChatOrders):
//     a pending order for its hold time, a confirmed one until it's
//     completed or cancelled — so two customers can't order the last unit.
//     The register itself is never touched by a chat order.
//
// Never anything else — no cost, supplier, IMEI or location leaves here.

const crypto = require("crypto");
const { connectToDatabase } = require("./mongodb");
const { exQuery } = require("./exDb");

const CUSTOMERS = "refurb_stock_chat_customers";
const PRICES = "refurb_stock_chat_prices";
const SETTINGS = "refurb_stock_chat_settings";
const LOG = "refurb_stock_chat_log";
const ORDERS = "refurb_chat_orders"; // chat orders (CO-), utils/stockChatOrders.js
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
  // questions per customer per day (Melbourne); 0 = no limit — the default
  // while the chat is in internal testing (user 2026-11-16)
  dailyLimit: 0,
  // models customers never see (user 2026-11-16), matched on the whole name
  hiddenModels: ["17 pro max service pack", "给ADT"],
  // a unit's cost in AUD for the below-cost check: 1 HKD / 1 CNY = this many
  // AUD (CNY at 4.7 per AUD, as the AI Agent's margin rule)
  fxToAud: { HKD: 0.19, CNY: 0.2128 },
  // a pending chat order holds its stock this long (user 2026-11-25: 24 h)
  orderHoldHours: 24,
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
// one Model + Storage + Grade + Colour (what a chat order's hold points at)
const unitKey = (g) => [modelKey(g.model), storageKey(g.storage), gradeKey(g.grade), colorKey(g.color)].join("|");

// ── the chat's grade (user 2026-11-27) ──────────────────────────────
// Source: a unit at Assigned To Exyon takes Exyon's grade (its variant
// name, "… Grade B+"; a few names end in the grade word without "Grade"),
// ours when Exyon has none (not received yet). Its battery is Exyon's
// reading then (ours when Exyon has none), else ours. Groups:
//   A+ or A++ with 100% battery → "A+ 100% Battery" (priced at A+);
//   A / A+ / A++ → "A", B / B+ → "B", C / C+ → "C"; D, E as they are;
//   no grade → "" (Ungraded).
// AirPods / watches / Pencils never make the battery group — Exyon books a
// blanket 100 per batch for them, not a reading.
const GRADE_100 = "A+ 100% Battery";
const GRADE_WORD = /^(A\+\+|A\+|A|B\+|B|C\+|C|D|E)$/i;
const NO_BATTERY_GRADE = /airpods|耳机|pencil|watch|^pro \d+(st|nd|rd|th) gen/i;

function exyonGradeOf(variantName) {
  const n = clean(variantName);
  if (!n) return "";
  const i = n.search(/\bGrade\b/i);
  if (i >= 0) return n.slice(i + 5).trim();
  const last = n.split(" ").pop();
  return GRADE_WORD.test(last) ? last.toUpperCase() : "";
}

function chatGrade(grade, battery, model) {
  const g = gradeKey(grade);
  if (!g || g === "UNGRADED") return "";
  if (g === gradeKey(GRADE_100)) return GRADE_100;
  if ((g === "A+" || g === "A++") && Number(battery) >= 100 && !NO_BATTERY_GRADE.test(clean(model))) return GRADE_100;
  const m = g.match(/^([A-E])\+*$/);
  return m ? m[1] : clean(grade);
}

// A grade as a customer, the AI or an API caller writes it → the chat
// grade's key ("" = ungraded): "A++" / "a+" → "A", "B+" → "B",
// "A+ 100% battery" / "100% battery" → "A+ 100% BATTERY".
function gradeInputKey(v) {
  const s = clean(v).toUpperCase();
  if (!s || s === "UNGRADED" || s === "NONE" || s === "-") return "";
  if (/100/.test(s) && (/BATT|电池/.test(s) || /^A/.test(s))) return gradeKey(GRADE_100);
  const m = s.match(/^([A-E])\s*\+*$/);
  return m ? m[1] : gradeKey(s);
}
// that key written the way the stock shows it ("A+ 100% BATTERY" → "A+ 100% Battery")
const gradeFromKey = (k) => (k === gradeKey(GRADE_100) ? GRADE_100 : k);
// the price-list grade a chat grade is priced at
const priceGrade = (g) => (gradeKey(g) === gradeKey(GRADE_100) ? "A+" : g);

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
// Each IMEI / serial (upper case) Exyon has a stock row for → that latest
// row. A unit at Assigned To Exyon is hidden when that row is gone (a pick:
// sold / being picked; or a non-sellable zone). A unit with no row at all
// hasn't been received by Exyon yet — still shown (user 2026-11-17: "we can
// show stocks that are assigned to Exyon but not yet received in exdb").
async function exyonLatestRows(codes) {
  const list = [...new Set(codes.filter(Boolean))];
  const latest = new Map(); // code → latest stock row
  for (let i = 0; i < list.length; i += EX_CHUNK) {
    const c = list.slice(i, i + EX_CHUNK);
    const rows = await exQuery(
      // the variant name carries Exyon's grade; received_battery_health its battery reading
      `SELECT s.id, s.imei, s.serial_number, s.pick_id, s.received_battery_health, pv.name AS product,
              z.zone_number, z.location_alias
         FROM exyon.stocks s LEFT JOIN exyon.zone_locations z ON z.id = s.zone_location_id
         LEFT JOIN exyon_products.product_variants pv ON pv.id = s.variant_id
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
  return latest;
}

const codeKey = (v) => String(v || "").trim().toUpperCase();
const deviceCodes = (d) => [codeKey(d.imei), codeKey(d.serialNumber)];

// a register device's latest Exyon stock row (under its IMEI or serial), or null
function exyonRowOf(latest, codes) {
  let row = null;
  for (const c of codes) {
    const r = c && latest.get(c);
    if (r && (!row || Number(r.id) > Number(row.id))) row = r;
  }
  return row;
}

// "in-stock" | "gone" (sold, being picked, non-sellable zone) | "unconfirmed"
// (no stock row at Exyon under the unit's IMEI or serial)
function exyonStateOf(row) {
  if (!row) return "unconfirmed";
  const zone = `${row.zone_number || ""} ${row.location_alias || ""}`;
  return row.pick_id || EXYON_HIDE_ZONE.test(zone) ? "gone" : "in-stock";
}

// A register device's chat grade: Exyon's grade + battery for a unit at
// Exyon that Exyon has graded (`latest` null = Exyon unreachable → ours).
function unitChatGrade(d, latest) {
  let grade = d.grade;
  let battery = d.batteryHealth;
  if (latest && d.location === LOCATION_EXYON) {
    const row = exyonRowOf(latest, deviceCodes(d));
    const ex = row ? exyonGradeOf(row.product) : "";
    if (ex) {
      grade = ex;
      if (row.received_battery_health != null && row.received_battery_health !== "") battery = Number(row.received_battery_health);
    }
  }
  return chatGrade(grade, battery, d.model);
}

// Chat grades of a few register devices (a chat order's scan / confirm):
// device id → grade. Exyon unreachable → our grades.
async function deviceChatGrades(devices) {
  const atExyon = devices.filter((d) => d.location === LOCATION_EXYON);
  let latest = null;
  if (atExyon.length) {
    try {
      latest = await exyonLatestRows(atExyon.flatMap(deviceCodes));
    } catch (e) {
      console.error("Stock chat: Exyon grade check failed —", (e && e.message) || e);
    }
  }
  return new Map(devices.map((d) => [String(d._id), unitChatGrade(d, latest)]));
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
      { projection: { brand: 1, model: 1, storage: 1, color: 1, grade: 1, batteryHealth: 1, imei: 1, serialNumber: 1, location: 1, costPrice: 1, currency: 1 } },
    )
    .toArray();

  const atExyon = devices.filter((d) => d.location === LOCATION_EXYON);
  let latest = null;
  let exyonOk = true;
  let exyonError = null;
  try {
    latest = await exyonLatestRows(atExyon.flatMap(deviceCodes));
  } catch (e) {
    // Exyon unreachable: the register alone answers (staff see a warning) —
    // hiding every Exyon unit would empty the chat.
    exyonOk = false;
    exyonError = (e && e.message) || String(e);
    console.error("Stock chat: Exyon check failed —", exyonError);
  }

  let hiddenAtExyon = 0; // sold / being picked / non-sellable zone at Exyon → hidden
  let unconfirmedAtExyon = 0; // not received by Exyon yet (no stock row) → shown, counted for staff
  const available = devices.filter((d) => {
    if (d.location !== LOCATION_EXYON || !latest) return true;
    const st = exyonStateOf(exyonRowOf(latest, deviceCodes(d)));
    if (st === "gone") hiddenAtExyon += 1;
    if (st === "unconfirmed") unconfirmedAtExyon += 1;
    return st !== "gone";
  });
  let gradedByExyon = 0; // shown units graded by Exyon (staff preview)
  const groups = new Map();
  for (const d of available) {
    const grade = unitChatGrade(d, latest);
    if (latest && d.location === LOCATION_EXYON) {
      const row = exyonRowOf(latest, deviceCodes(d));
      if (row && exyonGradeOf(row.product)) gradedByExyon += 1;
    }
    const key = [modelKey(d.model), storageKey(d.storage), gradeKey(grade), colorKey(d.color)].join("|");
    let g = groups.get(key);
    if (!g) {
      g = {
        brand: clean(d.brand),
        model: clean(d.model),
        storage: clean(d.storage),
        grade,
        color: clean(d.color),
        qty: 0,
        // each unit's cost — server-side only, for the below-cost check;
        // stripped before anything leaves pricedStock()
        costs: [],
      };
      groups.set(key, g);
    }
    g.qty += 1;
    g.costs.push(d.costPrice == null || d.costPrice === "" ? null : { amount: Number(d.costPrice), currency: d.currency || "AUD" });
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
    hiddenAtExyon,
    unconfirmedAtExyon,
    gradedByExyon,
    exyonOk,
    exyonError,
  };
}

// maxAgeMs: a tighter limit than the usual 5 min (an order checks stock no
// older than a minute)
async function stockSnapshot({ fresh = false, maxAgeMs = null } = {}) {
  let ttl = cache && cache.exyonOk ? SNAPSHOT_TTL_MS : SNAPSHOT_RETRY_MS;
  if (maxAgeMs != null) ttl = Math.min(ttl, maxAgeMs);
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
// blank storage, or both. A chat grade is priced at its own grade (A at A,
// B at B …) and "A+ 100% Battery" at A+ — the A++ / B+ / C+ rows go unused.
function priceFor(idx, g) {
  const m = modelKey(g.model);
  const s = storageKey(g.storage);
  const gr = gradeKey(priceGrade(g.grade));
  if (!m) return null;
  for (const k of [[m, s, gr], [m, s, ""], [m, "", gr], [m, "", ""]]) {
    const hit = idx.get(k.join("|"));
    if (hit && hit.price != null) return { price: hit.price, currency: hit.currency || "AUD" };
  }
  return null;
}

// A unit's cost in AUD; null when it has none (or no rate for its currency).
function costInAud(c, fx) {
  if (!c || !Number.isFinite(c.amount)) return null;
  const cur = String(c.currency || "AUD").toUpperCase();
  if (cur === "AUD") return c.amount;
  const rate = Number(fx && fx[cur]);
  return Number.isFinite(rate) && rate > 0 ? c.amount * rate : null;
}

// ── chat order holds ────────────────────────────────────────────────
// What open chat orders hold: unitKey + "#" + kind ("priced" | "contact") →
// units. Open = confirmed, or pending inside its hold time. Each order line
// records where its units came from (`alloc`: colour + kind + qty).
async function orderHolds(db, excludeOrderId = null) {
  const q = { $or: [{ status: "confirmed" }, { status: "pending", holdUntil: { $gt: new Date() } }] };
  if (excludeOrderId) q._id = { $ne: excludeOrderId };
  const docs = await db.collection(ORDERS).find(q, { projection: { items: 1 } }).toArray();
  const held = new Map();
  for (const o of docs) {
    for (const it of o.items || []) {
      for (const a of it.alloc || []) {
        // a line keeps the register's own model / storage / grade ("" = ungraded)
        const k = unitKey({ model: it.model, storage: it.storage, grade: it.grade, color: a.color }) + "#" + (a.kind === "contact" ? "contact" : "priced");
        held.set(k, (held.get(k) || 0) + (Number(a.qty) || 0));
      }
    }
  }
  return held;
}

// The groups minus the holds: from the same kind of row first (priced /
// Contact us), then the other (a price may have changed since); rows left
// empty drop out. Returns { groups, heldUnits }.
function applyHolds(groups, held) {
  const out = groups.map((g) => ({ ...g }));
  const slots = new Map();
  for (const g of out) {
    const k = unitKey(g);
    if (!slots.has(k)) slots.set(k, {});
    slots.get(k)[g.price == null ? "contact" : "priced"] = g;
  }
  let heldUnits = 0;
  for (const [hk, qty] of held) {
    const i = hk.lastIndexOf("#");
    const slot = slots.get(hk.slice(0, i));
    if (!slot) continue;
    const kind = hk.slice(i + 1);
    let left = qty;
    for (const g of [slot[kind], slot[kind === "priced" ? "contact" : "priced"]]) {
      if (!g || left <= 0) continue;
      const take = Math.min(g.qty, left);
      g.qty -= take;
      left -= take;
      heldUnits += take;
    }
  }
  return { groups: out.filter((g) => g.qty > 0), heldUnits };
}

// The snapshot's groups with prices — exactly what a customer may see:
//   · hidden models left out;
//   · a listed price only for units it doesn't undercut: a unit whose cost
//     is above the price shows "Contact us" (user 2026-11-16) — so one
//     Model + Storage + Grade + Colour can come back as two rows, the priced
//     units and the `belowCost` ones. A unit with no cost keeps the price;
//   · minus what open chat orders hold (`excludeOrderId`: not that order's
//     own hold — when it is re-checked).
// Costs never leave this function.
async function pricedStock({ fresh = false, maxAgeMs = null, excludeOrderId = null } = {}) {
  const db = await connectToDatabase();
  const [snap, idx, settings, held] = await Promise.all([
    stockSnapshot({ fresh, maxAgeMs }),
    loadPriceIndex(db),
    getSettings(db),
    orderHolds(db, excludeOrderId),
  ]);
  const hidden = new Set((settings.hiddenModels || []).map(modelKey).filter(Boolean));
  const fx = settings.fxToAud || {};
  const groups = [];
  let hiddenUnits = 0;
  let belowCostUnits = 0;
  for (const g of snap.groups) {
    const { costs, ...base } = g;
    if (hidden.has(modelKey(g.model))) {
      hiddenUnits += g.qty;
      continue;
    }
    const p = priceFor(idx, g);
    if (!p) {
      groups.push({ ...base, price: null, currency: null });
      continue;
    }
    const low = (costs || []).filter((c) => {
      const aud = costInAud(c, fx);
      return aud != null && p.currency === "AUD" && aud > p.price;
    }).length;
    if (g.qty - low > 0) groups.push({ ...base, qty: g.qty - low, price: p.price, currency: p.currency });
    if (low > 0) {
      groups.push({ ...base, qty: low, price: null, currency: null, belowCost: true });
      belowCostUnits += low;
    }
  }
  const after = applyHolds(groups, held);
  return {
    ...snap,
    groups: after.groups,
    units: snap.units - hiddenUnits - after.heldUnits,
    hiddenUnits,
    belowCostUnits,
    heldUnits: after.heldUnits,
  };
}

module.exports = {
  CUSTOMERS,
  PRICES,
  SETTINGS,
  LOG,
  ORDERS,
  DEFAULT_SETTINGS,
  clean,
  modelKey,
  storageKey,
  gradeKey,
  colorKey,
  unitKey,
  GRADE_100,
  exyonGradeOf,
  chatGrade,
  gradeInputKey,
  gradeFromKey,
  priceGrade,
  deviceChatGrades,
  applyHolds,
  melbourneDay,
  normalizePhone,
  newToken,
  getSettings,
  stockSnapshot,
  pricedStock,
  priceFor,
};
