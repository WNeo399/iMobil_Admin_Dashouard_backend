// Chat orders (CO-10001+, user 2026-11-25) — refurbished devices ordered
// from the WhatsApp chat bot, kept apart from normal sales orders (RSO-).
//
// A chat order is what the customer saw in the chat: Model + Storage +
// Grade (+ Colour, or any colour) and a quantity — never IMEIs — and it
// never touches the stock register. Staff confirm it, make the sales order
// (picking the IMEIs there) and mark the chat order completed.
//
// Stock: an open order holds its units in the chat's stock view
// (utils/stockChat.js applyHolds), so two customers can't order the same
// last unit — pending for the hold time (settings.orderHoldHours, 24 h),
// confirmed until completed or cancelled.
//
// Statuses: pending → confirmed → completed; cancelled (the customer while
// pending, or staff); expired (pending past its hold — staff re-check it,
// which re-reads stock and prices and makes it pending again).
//
// Confirming needs every unit picked (user 2026-11-25): staff scan each
// device's IMEI / serial; it must be In Stock at iMobile or Assigned To
// Exyon, match its line (model, storage, grade, and colour when the line
// names one) and not be picked for another chat order. The devices are
// recorded on the order (`picked`) and the hold moves to their colours.
//
// Prices always come from our price list at order time; a "Contact us"
// item can be ordered (no price → the order is quoteNeeded).

const { ObjectId } = require("mongodb");
const SC = require("./stockChat");

const ORDERS = SC.ORDERS;
const SALES_ORDERS = "refurb_sales_orders";
const DEVICES = "refurb_devices";
const PICK_LOCATIONS = ["iMobile", "Assigned To Exyon"]; // where the chat's stock is
const STATUSES = ["pending", "confirmed", "completed", "cancelled", "expired"];
const OPEN = ["pending", "confirmed"];
const MAX_LINES = 20;
const MAX_QTY = 500;
const MAX_OPEN = 3; // open orders per customer
const STOCK_MAX_AGE_MS = 60 * 1000; // an order checks stock no older than this
const FIRST_SEQ = 10001;

class OrderError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
const bad = (message, extra) => new OrderError(400, "BAD_REQUEST", message, extra);

// One order write at a time on this server: the stock check and the save
// can't interleave, so the last unit goes to one customer only.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

let indexed = false;
async function ensureOrderIndexes(db) {
  if (indexed) return;
  const c = db.collection(ORDERS);
  await Promise.all([
    c.createIndex({ orderNo: 1 }, { unique: true }),
    c.createIndex({ seq: -1 }),
    c.createIndex({ phone: 1, clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: "string" } } }),
    c.createIndex({ status: 1, holdUntil: 1 }),
    c.createIndex({ phone: 1, createdAt: -1 }),
    c.createIndex({ createdAt: -1 }),
  ]);
  indexed = true;
}

// Pending orders past their hold → expired (before every read and write;
// the stock view already ignores them).
async function expireOrders(db) {
  const now = new Date();
  await db.collection(ORDERS).updateMany({ status: "pending", holdUntil: { $lte: now } }, [
    {
      $set: {
        status: "expired",
        expiredAt: "$holdUntil",
        updatedAt: now,
        history: { $concatArrays: [{ $ifNull: ["$history", []] }, [{ at: "$holdUntil", action: "expired", by: "system" }]] },
      },
    },
  ]);
}

async function nextOrderNo(db) {
  const top = await db.collection(ORDERS).find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
  const seq = Math.max(FIRST_SEQ - 1, Number(top[0] && top[0].seq) || 0) + 1;
  return { seq, orderNo: `CO-${seq}` };
}

// ── items ────────────────────────────────────────────────────────────
const gradeLabel = (g) => g || "Ungraded";
const gradeInputKey = (v) => {
  const k = SC.gradeKey(v);
  return k === "UNGRADED" || k === "NONE" || k === "-" ? "" : k;
};
const round2 = (n) => Math.round(n * 100) / 100;
const optText = (v, max) => (v == null || SC.clean(v) === "" ? null : SC.clean(v).slice(0, max));

// The request's items → { index, model, storage, grade, color, qty,
// expectedPrice }; storage / grade / colour null = not given.
function parseItems(raw) {
  if (!Array.isArray(raw) || !raw.length) throw bad("items must be a non-empty list.");
  if (raw.length > MAX_LINES) throw bad(`At most ${MAX_LINES} items per order.`);
  return raw.map((x, index) => {
    const it = x && typeof x === "object" ? x : {};
    const model = optText(it.model, 120);
    if (!model) throw bad(`items[${index}].model is required.`);
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw bad(`items[${index}].qty must be a whole number from 1 to ${MAX_QTY}.`);
    let expectedPrice = null;
    if (it.expectedPrice != null && it.expectedPrice !== "") {
      expectedPrice = Number(it.expectedPrice);
      if (!Number.isFinite(expectedPrice) || expectedPrice < 0) throw bad(`items[${index}].expectedPrice must be a number.`);
    }
    return { index, model, storage: optText(it.storage, 40), grade: optText(it.grade, 20), color: optText(it.color, 60), qty, expectedPrice };
  });
}

const distinct = (vals) => [...new Set(vals)];

// The items against the stock view's groups (holds already taken off).
// Each item's units come from priced rows first (largest colour first),
// then "Contact us" rows — an item can become two lines. Returns { lines,
// unclear, short, priceChanged }; a line keeps the register's own model /
// storage / grade ("" = ungraded) and `alloc` (colour + kind + qty: where
// its hold sits).
function resolveItems(groups, items) {
  const used = new Map(); // group → units already taken by an earlier item
  const left = (g) => g.qty - (used.get(g) || 0);
  const lines = [];
  const unclear = [];
  const short = [];
  const priceChanged = [];
  for (const it of items) {
    const label = { index: it.index, model: it.model, storage: it.storage, grade: it.grade, color: it.color };
    const none = () => short.push({ ...label, requested: it.qty, available: 0 });
    let cands = groups.filter((g) => SC.modelKey(g.model) === SC.modelKey(it.model));
    if (!cands.length) { none(); continue; }
    if (it.storage != null) cands = cands.filter((g) => SC.storageKey(g.storage) === SC.storageKey(it.storage));
    else {
      const opts = distinct(cands.map((g) => g.storage));
      if (opts.length > 1) { unclear.push({ ...label, field: "storage", options: opts }); continue; }
    }
    if (!cands.length) { none(); continue; }
    if (it.grade != null) cands = cands.filter((g) => SC.gradeKey(g.grade) === gradeInputKey(it.grade));
    else {
      const opts = distinct(cands.map((g) => gradeLabel(g.grade)));
      if (opts.length > 1) { unclear.push({ ...label, field: "grade", options: opts }); continue; }
    }
    if (!cands.length) { none(); continue; }
    if (it.color != null) cands = cands.filter((g) => SC.colorKey(g.color) === SC.colorKey(it.color));
    if (!cands.length) { none(); continue; }

    const available = cands.reduce((s, g) => s + Math.max(0, left(g)), 0);
    if (available < it.qty) { short.push({ ...label, requested: it.qty, available }); continue; }

    const ordered = cands.slice().sort((a, b) => (a.price == null) - (b.price == null) || left(b) - left(a) || a.color.localeCompare(b.color));
    const parts = { priced: { qty: 0, alloc: [], price: null, currency: null }, contact: { qty: 0, alloc: [] } };
    let need = it.qty;
    for (const g of ordered) {
      if (need <= 0) break;
      const take = Math.min(left(g), need);
      if (take <= 0) continue;
      used.set(g, (used.get(g) || 0) + take);
      need -= take;
      const kind = g.price == null ? "contact" : "priced";
      const p = parts[kind];
      p.qty += take;
      const a = p.alloc.find((x) => x.color === g.color);
      if (a) a.qty += take;
      else p.alloc.push({ color: g.color, kind, qty: take });
      if (kind === "priced") { p.price = g.price; p.currency = g.currency || "AUD"; }
    }
    const base = { model: cands[0].model, storage: cands[0].storage, grade: cands[0].grade, color: it.color != null ? cands[0].color : null };
    const pp = parts.priced;
    const pc = parts.contact;
    if (pp.qty) lines.push({ ...base, qty: pp.qty, unitPrice: pp.price, currency: pp.currency, lineTotal: round2(pp.price * pp.qty), alloc: pp.alloc });
    if (pc.qty) lines.push({ ...base, qty: pc.qty, unitPrice: null, currency: null, lineTotal: null, alloc: pc.alloc });
    if (it.expectedPrice != null) {
      const now = pp.qty && !pc.qty ? pp.price : null;
      if (now !== it.expectedPrice) {
        priceChanged.push({ ...label, expectedPrice: it.expectedPrice, price: pp.qty ? pp.price : null, currency: pp.qty ? pp.currency : null, contactUsQty: pc.qty });
      }
    }
  }
  return { lines, unclear, short, priceChanged };
}

// The first problem as an error the caller can act on.
function problemOf(r) {
  if (r.unclear.length) {
    const u = r.unclear[0];
    return new OrderError(400, "ITEM_UNCLEAR", `Say which ${u.field} for ${u.model}: ${u.options.map(gradeLabelOrStorage(u.field)).join(", ")}.`, { items: r.unclear });
  }
  if (r.short.length) {
    return new OrderError(409, "OUT_OF_STOCK", "Not enough stock for: " + r.short.map((s) => `${s.model} ${s.storage || ""} ${s.grade || ""}`.replace(/\s+/g, " ").trim() + ` (asked ${s.requested}, available ${s.available})`).join("; "), { items: r.short });
  }
  if (r.priceChanged.length) {
    return new OrderError(409, "PRICE_CHANGED", "The price has changed for: " + r.priceChanged.map((p) => p.model).join(", ") + ". Show the customer the new price and order again.", { items: r.priceChanged });
  }
  return null;
}
const gradeLabelOrStorage = (field) => (v) => (field === "storage" ? v || "(none)" : v);

function totals(lines) {
  const priced = lines.filter((l) => l.unitPrice != null);
  const currencies = distinct(priced.map((l) => l.currency));
  return {
    // the priced lines only; null when none is priced or currencies mix
    subtotal: priced.length && currencies.length === 1 ? round2(priced.reduce((s, l) => s + l.lineTotal, 0)) : null,
    currency: currencies.length === 1 ? currencies[0] : currencies.length ? null : "AUD",
    quoteNeeded: lines.some((l) => l.unitPrice == null),
  };
}

// ── what the WhatsApp side sees ──────────────────────────────────────
function publicOrder(o) {
  return {
    orderNo: o.orderNo || null,
    status: o.status,
    channel: o.channel,
    customer: { phone: o.phone, name: o.customerName || "" },
    items: (o.items || []).map((l) => ({
      model: l.model, storage: l.storage, grade: gradeLabel(l.grade), color: l.color,
      qty: l.qty, unitPrice: l.unitPrice, currency: l.currency, lineTotal: l.lineTotal,
    })),
    subtotal: o.subtotal,
    currency: o.currency,
    priceNote: o.priceNote || "",
    quoteNeeded: !!o.quoteNeeded,
    note: o.note || "",
    holdUntil: o.status === "pending" || o.status === "preview" ? o.holdUntil : null,
    createdAt: o.createdAt || null,
    confirmedAt: o.confirmedAt || null,
    completedAt: o.completedAt || null,
    cancelledAt: o.cancelledAt || null,
    cancelledBy: o.cancelledBy || null,
    cancelReason: o.status === "cancelled" ? o.cancelReason || "" : null,
    expiredAt: o.expiredAt || null,
  };
}

function holdHours(settings) {
  const h = Number(settings && settings.orderHoldHours);
  return Number.isFinite(h) && h >= 1 && h <= 168 ? h : SC.DEFAULT_SETTINGS.orderHoldHours;
}

// ── place (WhatsApp) ─────────────────────────────────────────────────
// body: { items, note?, clientRef, dryRun? }. dryRun: the same checks, the
// order as it would be — nothing saved, nothing held.
async function placeOrder(db, customer, body, { channel }) {
  const b = body || {};
  const dryRun = b.dryRun === true || b.dryRun === "true";
  const items = parseItems(b.items);
  const note = optText(b.note, 500) || "";
  const clientRef = optText(b.clientRef, 120);
  if (!dryRun && !clientRef) {
    throw bad("clientRef is required to place an order (e.g. the WhatsApp message id) — a retried call with the same clientRef returns the same order.");
  }
  await ensureOrderIndexes(db);
  const col = db.collection(ORDERS);
  const findDup = () => (clientRef && !dryRun ? col.findOne({ phone: customer.phone, clientRef }) : null);
  let dup = await findDup();
  if (dup) return { order: dup, duplicate: true };

  return exclusive(async () => {
    dup = await findDup();
    if (dup) return { order: dup, duplicate: true };
    await expireOrders(db);
    const open = await col.countDocuments({ phone: customer.phone, status: { $in: OPEN } });
    if (open >= MAX_OPEN) {
      throw new OrderError(429, "TOO_MANY_OPEN_ORDERS", `This number already has ${open} open orders — our team will confirm them, or cancel one first.`, { open });
    }
    const settings = await SC.getSettings(db);
    const stock = await SC.pricedStock({ maxAgeMs: dryRun ? null : STOCK_MAX_AGE_MS });
    const r = resolveItems(stock.groups, items);
    const problem = problemOf(r);
    if (problem) throw problem;
    const now = new Date();
    const doc = {
      phone: customer.phone,
      customerId: customer._id,
      customerName: customer.name || "",
      channel,
      status: dryRun ? "preview" : "pending",
      items: r.lines,
      ...totals(r.lines),
      priceNote: settings.priceNote || "",
      note,
      clientRef,
      holdUntil: new Date(now.getTime() + holdHours(settings) * 3600 * 1000),
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, action: "placed", by: "customer", channel }],
    };
    if (dryRun) return { order: doc, dryRun: true };
    const { seq, orderNo } = await nextOrderNo(db);
    doc.seq = seq;
    doc.orderNo = orderNo;
    try {
      await col.insertOne(doc);
    } catch (e) {
      if (e && e.code === 11000) {
        const again = await findDup();
        if (again) return { order: again, duplicate: true };
      }
      throw e;
    }
    return { order: doc };
  });
}

// ── the customer's own orders ────────────────────────────────────────
async function customerOrders(db, phone, { status, limit } = {}) {
  await ensureOrderIndexes(db);
  await expireOrders(db);
  const q = { phone };
  if (status) {
    if (!STATUSES.includes(status)) throw bad(`status must be one of: ${STATUSES.join(", ")}.`);
    q.status = status;
  }
  const n = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  return db.collection(ORDERS).find(q).sort({ createdAt: -1 }).limit(n).toArray();
}

async function customerOrder(db, phone, orderNo) {
  await ensureOrderIndexes(db);
  await expireOrders(db);
  const no = SC.clean(orderNo).toUpperCase();
  const o = no ? await db.collection(ORDERS).findOne({ phone, orderNo: no }) : null;
  if (!o) throw new OrderError(404, "ORDER_NOT_FOUND", "No such order for this number.", { orderNo: no || null });
  return o;
}

// A pending order only; cancelling a cancelled one again is fine (a retry).
async function customerCancel(db, phone, orderNo, reason) {
  return exclusive(async () => {
    const o = await customerOrder(db, phone, orderNo);
    if (o.status === "cancelled") return { order: o, already: true };
    if (o.status !== "pending") {
      const msg = o.status === "confirmed"
        ? "Our team has already confirmed this order — ask them in the chat to change or cancel it."
        : `This order is ${o.status} and can't be cancelled.`;
      throw new OrderError(409, "NOT_CANCELLABLE", msg, { status: o.status });
    }
    const now = new Date();
    const why = optText(reason, 300) || "";
    const r = await db.collection(ORDERS).findOneAndUpdate(
      { _id: o._id, status: "pending" },
      {
        $set: { status: "cancelled", cancelledAt: now, cancelledBy: "customer", cancelReason: why, updatedAt: now },
        $push: { history: { at: now, action: "cancelled", by: "customer", note: why } },
      },
      { returnDocument: "after" },
    );
    const after = r && r.value !== undefined ? r.value : r;
    if (!after) throw new OrderError(409, "NOT_CANCELLABLE", "This order just changed — check its status again.");
    return { order: after };
  });
}

// ── staff ────────────────────────────────────────────────────────────
// An order's lines back into items (colour null = any), for a re-check.
function itemsFromLines(lines) {
  const by = new Map();
  for (const l of lines || []) {
    const k = [SC.modelKey(l.model), SC.storageKey(l.storage), SC.gradeKey(l.grade), l.color == null ? "*" : SC.colorKey(l.color)].join("|");
    const it = by.get(k);
    if (it) it.qty += l.qty;
    else by.set(k, { index: by.size, model: l.model, storage: l.storage || "", grade: gradeLabel(l.grade), color: l.color == null ? null : l.color, qty: l.qty, expectedPrice: null });
  }
  return [...by.values()];
}

const who = (user) => (user && user.username) || "staff";

async function staffOrder(db, id) {
  await ensureOrderIndexes(db);
  await expireOrders(db);
  const o = await db.collection(ORDERS).findOne({ _id: id });
  if (!o) throw new OrderError(404, "ORDER_NOT_FOUND", "Chat order not found");
  return o;
}

async function setStatus(db, o, from, set, entry) {
  const now = new Date();
  const r = await db.collection(ORDERS).findOneAndUpdate(
    { _id: o._id, status: from },
    { $set: { ...set, updatedAt: now }, $push: { history: { at: now, ...entry } } },
    { returnDocument: "after" },
  );
  const after = r && r.value !== undefined ? r.value : r;
  if (!after) throw new OrderError(409, "CHANGED", "This order just changed — reload it.");
  return after;
}

// expired → pending again after a fresh stock check: its lines re-read at
// today's stock and prices, a new hold. Then it is picked and confirmed.
async function staffReopen(db, id, user) {
  return exclusive(async () => {
    const o = await staffOrder(db, id);
    if (o.status !== "expired") throw new OrderError(409, "NOT_EXPIRED", `Only an expired order is re-checked — this one is ${o.status}.`);
    const stock = await SC.pricedStock({ maxAgeMs: STOCK_MAX_AGE_MS, excludeOrderId: o._id });
    const r = resolveItems(stock.groups, itemsFromLines(o.items));
    const problem = problemOf(r);
    if (problem) throw problem;
    const settings = await SC.getSettings(db);
    const holdUntil = new Date(Date.now() + holdHours(settings) * 3600 * 1000);
    return setStatus(db, o, "expired", { status: "pending", holdUntil, expiredAt: null, items: r.lines, ...totals(r.lines) },
      { action: "reopened", by: who(user), note: "stock checked again, prices re-read" });
  });
}

// ── picking: the devices scanned for an order ───────────────────────
const normalizeCode = (v) => String(v == null ? "" : v).replace(/[\s-]/g, "").trim().toUpperCase();
const lineText = (l) => [l.model, l.storage, gradeLabel(l.grade), l.color || "any colour"].filter(Boolean).join(" · ");

// does this device fit this order line?
function lineMatches(line, d) {
  return SC.modelKey(line.model) === SC.modelKey(d.model) &&
    SC.storageKey(line.storage) === SC.storageKey(d.storage) &&
    SC.gradeKey(line.grade) === SC.gradeKey(d.grade) &&
    (line.color == null || SC.colorKey(line.color) === SC.colorKey(d.color));
}

function deviceRecord(d) {
  return {
    deviceId: d._id, imei: d.imei || "", serialNumber: d.serialNumber || "",
    model: d.model || "", storage: d.storage || "", grade: d.grade || "", color: d.color || "", location: d.location || "",
  };
}

// The scan list the page holds: [{ deviceId, lineIndex }].
function parsePicks(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw bad("picks must be a list.");
  return raw.map((p, i) => {
    const id = p && p.deviceId;
    const lineIndex = Number(p && p.lineIndex);
    if (!ObjectId.isValid(String(id || ""))) throw bad(`picks[${i}].deviceId is not valid.`);
    if (!Number.isInteger(lineIndex) || lineIndex < 0) throw bad(`picks[${i}].lineIndex is not valid.`);
    return { deviceId: new ObjectId(String(id)), lineIndex };
  });
}

// device id (string) → the chat order it is already picked for
async function pickedElsewhere(db, deviceIds, orderId) {
  if (!deviceIds.length) return new Map();
  const docs = await db.collection(ORDERS).find(
    { _id: { $ne: orderId }, status: { $in: ["confirmed", "completed"] }, "picked.deviceId": { $in: deviceIds } },
    { projection: { orderNo: 1, picked: 1 } },
  ).toArray();
  const out = new Map();
  const want = new Set(deviceIds.map(String));
  for (const o of docs) for (const p of o.picked || []) if (want.has(String(p.deviceId))) out.set(String(p.deviceId), o.orderNo);
  return out;
}

// Why this device can't be sold from a chat order, or null.
function deviceProblem(d) {
  const code = d.imei || d.serialNumber;
  if (d.status !== "In Stock") return `${code} is ${d.status || "not in stock"} — it can't be sold.`;
  if (!PICK_LOCATIONS.includes(d.location)) return `${code} is at ${d.location || "an unknown location"}, not iMobile or Exyon.`;
  return null;
}

// The line a scanned device goes on: one that fits and still needs units,
// a line asking for its colour before an any-colour line.
function lineFor(order, d, counts) {
  const fits = (order.items || []).map((l, i) => ({ l, i })).filter(({ l }) => lineMatches(l, d));
  if (!fits.length) return { error: `${d.imei || d.serialNumber} (${[d.model, d.storage, gradeLabel(d.grade), d.color].filter(Boolean).join(" · ")}) isn't on this order.` };
  fits.sort((a, b) => (a.l.color == null) - (b.l.color == null) || a.i - b.i);
  const open = fits.find(({ l, i }) => (counts[i] || 0) < l.qty);
  if (!open) return { error: `All ${fits.reduce((s, f) => s + f.l.qty, 0)} of ${lineText(fits[0].l)} are already scanned.` };
  return { lineIndex: open.i };
}

// One scan while picking (nothing saved): the device and the line it goes on.
async function staffScan(db, id, code, rawPicks) {
  const o = await staffOrder(db, id);
  if (o.status !== "pending") {
    throw new OrderError(409, "NOT_PICKABLE", o.status === "expired" ? "This order expired — re-check it first." : `This order is ${o.status}.`);
  }
  const c = normalizeCode(code);
  if (c.length < 6) throw bad("Scan or type the IMEI or serial number.");
  const picks = parsePicks(rawPicks);
  const d = await db.collection(DEVICES).findOne({ $or: [{ imei: c }, { serialNumber: c }] });
  if (!d) throw new OrderError(404, "DEVICE_NOT_FOUND", `${c} isn't in the stock register.`);
  if (picks.some((p) => String(p.deviceId) === String(d._id))) throw new OrderError(409, "ALREADY_SCANNED", `${c} is already scanned for this order.`);
  const p1 = deviceProblem(d);
  if (p1) throw new OrderError(409, "NOT_SELLABLE", p1);
  const elsewhere = await pickedElsewhere(db, [d._id], o._id);
  if (elsewhere.size) throw new OrderError(409, "PICKED_ELSEWHERE", `${c} is already picked for ${elsewhere.get(String(d._id))}.`);
  const counts = {};
  for (const p of picks) counts[p.lineIndex] = (counts[p.lineIndex] || 0) + 1;
  const where = lineFor(o, d, counts);
  if (where.error) throw new OrderError(409, "NOT_ON_ORDER", where.error);
  return { device: deviceRecord(d), lineIndex: where.lineIndex };
}

// pending → confirmed, with every unit picked: picks = [{ deviceId,
// lineIndex }], one per unit; all re-checked here. The devices are saved
// on the order and each line's hold moves to the picked devices' colours.
async function staffConfirm(db, id, user, note, rawPicks) {
  return exclusive(async () => {
    const o = await staffOrder(db, id);
    if (o.status === "expired") throw new OrderError(409, "EXPIRED", "This order expired — re-check it, then scan its devices.");
    if (o.status !== "pending") throw new OrderError(409, "NOT_CONFIRMABLE", `This order is ${o.status}.`);
    const picks = parsePicks(rawPicks);
    const need = (o.items || []).reduce((s, l) => s + l.qty, 0);
    if (picks.length !== need) throw new OrderError(400, "NOT_ALL_PICKED", `Scan all ${need} devices first (${picks.length} scanned).`, { need, scanned: picks.length });
    const ids = picks.map((p) => p.deviceId);
    if (new Set(ids.map(String)).size !== ids.length) throw bad("A device is scanned twice.");
    const devices = await db.collection(DEVICES).find({ _id: { $in: ids } }).toArray();
    const byId = new Map(devices.map((d) => [String(d._id), d]));
    const elsewhere = await pickedElsewhere(db, ids, o._id);
    const counts = {};
    const problems = [];
    for (const p of picks) {
      const d = byId.get(String(p.deviceId));
      const line = o.items[p.lineIndex];
      if (!d) { problems.push(`A scanned device is no longer in the register (${p.deviceId}).`); continue; }
      const code = d.imei || d.serialNumber;
      if (!line) { problems.push(`${code}: no line ${p.lineIndex + 1} on this order.`); continue; }
      const p1 = deviceProblem(d);
      if (p1) { problems.push(p1); continue; }
      if (elsewhere.has(String(d._id))) { problems.push(`${code} is already picked for ${elsewhere.get(String(d._id))}.`); continue; }
      if (!lineMatches(line, d)) { problems.push(`${code} doesn't fit ${lineText(line)}.`); continue; }
      counts[p.lineIndex] = (counts[p.lineIndex] || 0) + 1;
    }
    o.items.forEach((l, i) => {
      if (!problems.length && (counts[i] || 0) !== l.qty) problems.push(`${lineText(l)}: ${counts[i] || 0} of ${l.qty} scanned.`);
    });
    if (problems.length) throw new OrderError(409, "PICK_PROBLEM", problems.join(" "), { problems });

    const by = who(user);
    const now = new Date();
    const picked = picks.map((p) => ({ ...deviceRecord(byId.get(String(p.deviceId))), lineIndex: p.lineIndex, at: now, by }));
    const items = o.items.map((l, i) => {
      const alloc = [];
      for (const p of picked.filter((x) => x.lineIndex === i)) {
        const a = alloc.find((x) => SC.colorKey(x.color) === SC.colorKey(p.color));
        if (a) a.qty += 1;
        else alloc.push({ color: p.color, kind: l.unitPrice == null ? "contact" : "priced", qty: 1 });
      }
      return { ...l, alloc };
    });
    return setStatus(db, o, "pending", { status: "confirmed", confirmedAt: now, confirmedBy: by, picked, items },
      { action: "confirmed", by, note: [optText(note, 300) || "", `${picked.length} device(s) scanned`].filter(Boolean).join(" — ") });
  });
}

// confirmed → completed (the sales order made); the hold ends.
async function staffComplete(db, id, user, salesOrderNo, note) {
  return exclusive(async () => {
    const o = await staffOrder(db, id);
    if (o.status !== "confirmed") throw new OrderError(409, "NOT_COMPLETABLE", `Only a confirmed order can be completed — this one is ${o.status}.`);
    let rso = optText(salesOrderNo, 30);
    if (rso) {
      rso = rso.toUpperCase();
      if (!/^RSO-\d+$/.test(rso)) throw bad("The sales order number looks like RSO-10123.");
      const exists = await db.collection(SALES_ORDERS).findOne({ orderNo: rso }, { projection: { _id: 1 } });
      if (!exists) throw bad(`Sales order ${rso} doesn't exist.`);
    }
    const by = who(user);
    return setStatus(db, o, "confirmed", { status: "completed", completedAt: new Date(), completedBy: by, salesOrderNo: rso || null },
      { action: "completed", by, note: [rso ? `sales order ${rso}` : "", optText(note, 300) || ""].filter(Boolean).join(" — ") });
  });
}

// pending / confirmed / expired → cancelled (a reason required).
async function staffCancel(db, id, user, reason) {
  const why = optText(reason, 300);
  if (!why) throw bad("A reason is required.");
  return exclusive(async () => {
    const o = await staffOrder(db, id);
    if (!["pending", "confirmed", "expired"].includes(o.status)) throw new OrderError(409, "NOT_CANCELLABLE", `This order is ${o.status}.`);
    const by = who(user);
    return setStatus(db, o, o.status, { status: "cancelled", cancelledAt: new Date(), cancelledBy: "staff", cancelledByUser: by, cancelReason: why },
      { action: "cancelled", by, note: why });
  });
}

async function staffNote(db, id, user, text) {
  const o = await staffOrder(db, id);
  const now = new Date();
  await db.collection(ORDERS).updateOne({ _id: o._id }, { $set: { staffNote: optText(text, 1000) || "", staffNoteBy: who(user), staffNoteAt: now, updatedAt: now } });
  return db.collection(ORDERS).findOne({ _id: o._id });
}

module.exports = {
  ORDERS,
  STATUSES,
  MAX_LINES,
  MAX_OPEN,
  OrderError,
  exclusive,
  ensureOrderIndexes,
  expireOrders,
  parseItems,
  resolveItems,
  itemsFromLines,
  totals,
  publicOrder,
  placeOrder,
  customerOrders,
  customerOrder,
  customerCancel,
  staffOrder,
  staffReopen,
  staffScan,
  staffConfirm,
  staffComplete,
  staffCancel,
  staffNote,
};
