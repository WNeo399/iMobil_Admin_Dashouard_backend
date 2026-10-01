// iMobile Accountant → My Fone: the My Fone shops (Zoho Inventory
// customers), what each owes, and a statement per shop (user ask
// 2026-09-30). The shop list is curated — 39 shops picked by the user from
// the customers with "MyFone" in their name — and kept in imb_myfone_shops
// { contactId, name, email, phone, sort, addedAt, addedBy, updatedAt }.
//
//   GET    /accountant/myfone/shops[?refresh=1]   the shops + what each owes
//   GET    /accountant/myfone/activity?from=&to=  each shop's invoicing and
//                                                 payments in a period
//   GET    /accountant/myfone/sync                where the history sync is
//   POST   /accountant/myfone/sync                re-read every shop's history
//   GET    /accountant/myfone/shops/:contactId/unpaid    its unpaid invoices (cached list)
//   GET    /accountant/myfone/shops/:contactId/statement[?refresh=1]
//   GET    /accountant/myfone/contacts?q=         Zoho customer search (to add)
//   POST   /accountant/myfone/shops {contactId}   add a shop
//   DELETE /accountant/myfone/shops/:contactId    remove a shop (Zoho untouched)
//
// acct:myfone:view reads, acct:myfone:edit changes the list — admin and the
// iMobile Accountant role (acct:*:*).
//
// Zoho calls are kept low (the daily Inventory cap is shared with
// production): the summary reads the cached list of unpaid invoices
// (utils/accountantInvoices, 10-minute cache), and a statement is ~5
// reads — the shop's invoices, payments, credit notes and credit-note
// refunds, plus the contact — kept 10 minutes per shop. The whole history
// is sent and the period is picked in the browser, so changing the dates
// costs nothing.
//
// The totals for a period (user ask 2026-09-30: "the total view also needs
// a duration") need every shop's history, which is too many calls to read
// live on each view, so each shop's transactions are kept in
// imb_myfone_ledgers { contactId, entries, balance, syncedAt }. A history is
// re-read when the shop's statement is opened, when the page is viewed and
// it is over 12 hours old (so at most twice a day, ~4-5 calls a shop, paced
// under Zoho's per-minute limit), or on "Sync now" (at most every 30
// minutes). The period figures are then worked out from Mongo — picking
// dates never calls Zoho.
//
// Balance = invoices − payments − credit notes − write-offs + refunds
// (payment and credit-note refunds give money back). It is checked against
// Zoho's own figure (outstanding receivable − unused credits) and the
// statement says when the two differ.

const express = require("express");
const router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { handleZohoInventoryRequest } = require("../../utils/zohoRequest");
const { ORGANIZATION_ID } = require("../../utils/zohoStock");
const { getUnpaidInvoices } = require("../../utils/accountantInvoices");

const VIEW = requirePermission("acct:myfone:view");
const EDIT = requirePermission("acct:myfone:edit");
const SHOPS = "imb_myfone_shops";
const LEDGERS = "imb_myfone_ledgers";
const ZOHO = "https://www.zohoapis.com/inventory/v1";

const CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const MAX_PAGES = 25;
const MAX_ATTEMPTS = 3;
const LEDGER_STALE_MS = 12 * 60 * 60 * 1000;
const MIN_SYNC_GAP_MS = 30 * 60 * 1000;
const SYNC_PACE_MS = 700; // between calls while syncing every shop
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;
const who = (req) => (req.user && req.user.username) || null;
const cleanId = (v) => (/^\d{6,25}$/.test(String(v || "")) ? String(v) : null);
const text = (v) => (v == null || v === "null" ? "" : String(v).trim());

// YYYY-MM-DD today in Melbourne — due dates are compared as plain dates.
function todayYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function daysBetween(fromYmd, toYmd) {
  const d = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((d(toYmd) - d(fromYmd)) / 86400000);
}

async function zohoGet(path, key, pace = 0) {
  let lastSeen;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (pace) await sleep(pace);
    const r = await handleZohoInventoryRequest(`${ZOHO}${path}${path.includes("?") ? "&" : "?"}organization_id=${ORGANIZATION_ID}`);
    if (r && r[key] !== undefined) return r;
    lastSeen = r;
    if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  throw new Error(`Zoho ${path.split("?")[0]} failed` + (lastSeen ? `: ${JSON.stringify(lastSeen).slice(0, 160)}` : ""));
}

// Every page of a list for one customer.
async function zohoList(endpoint, key, contactId, pace = 0) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await zohoGet(`/${endpoint}?customer_id=${contactId}&per_page=200&page=${page}`, key, pace);
    if (!Array.isArray(r[key])) throw new Error(`Zoho ${endpoint} gave no list`);
    out.push(...r[key]);
    if (!(r.page_context && r.page_context.has_more_page)) break;
  }
  return out;
}

function addressLines(a) {
  if (!a) return [];
  const cityLine = [text(a.city), text(a.state), text(a.zip || a.zipcode)].filter(Boolean).join(" ");
  return [text(a.attention), text(a.address), text(a.street2), cityLine, text(a.country)].filter(Boolean);
}

// ── the summary: what each shop owes, from the shared unpaid list ───
function summarise(shop, rows, today) {
  const mine = rows.filter((r) => r.customerId === shop.contactId);
  const s = {
    outstanding: 0, overdue: 0, notDue: 0, invoices: mine.length, overdueInvoices: 0, oldestDue: null,
    aging: { current: 0, d30: 0, d60: 0, d90: 0, older: 0 },
    currency: (mine[0] && mine[0].currency) || "AUD",
  };
  for (const r of mine) {
    s.outstanding += r.balance;
    const late = r.dueDate ? daysBetween(r.dueDate, today) : 0; // > 0 = days overdue
    if (late > 0 || r.status === "overdue") {
      s.overdue += r.balance;
      s.overdueInvoices += 1;
      if (r.dueDate && (!s.oldestDue || r.dueDate < s.oldestDue)) s.oldestDue = r.dueDate;
    } else s.notDue += r.balance;
    const bucket = late <= 0 ? "current" : late <= 30 ? "d30" : late <= 60 ? "d60" : late <= 90 ? "d90" : "older";
    s.aging[bucket] += r.balance;
  }
  for (const k of ["outstanding", "overdue", "notDue"]) s[k] = r2(s[k]);
  for (const k of Object.keys(s.aging)) s.aging[k] = r2(s.aging[k]);
  return s;
}

router.get("/shops", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const shops = await db.collection(SHOPS).find({}).sort({ sort: 1, name: 1 }).toArray();
    let list = null;
    try {
      list = await getUnpaidInvoices({ refresh: req.query.refresh === "1" });
    } catch (e) {
      list = null; // the shops still show, without figures
    }
    const today = todayYmd();
    const rows = list ? list.rows : [];
    return res.json({
      success: true,
      fetchedAt: list ? list.at : null,
      ...(list && list.stale ? { stale: true } : {}),
      ...(list ? {} : { unavailable: true }),
      today,
      shops: shops.map((s) => ({
        contactId: s.contactId, name: s.name, email: s.email || "", phone: s.phone || "", sort: s.sort,
        ...summarise(s, rows, today),
      })),
    });
  } catch (e) {
    console.error("My Fone shops error:", e);
    return res.status(500).json({ success: false, message: "Could not load the My Fone shops" });
  }
});

// ── a shop's unpaid invoices ────────────────────────────────────────
// For the Accountant Dashboard's drawer: the shop's invoices still owing,
// straight from the shared unpaid list (10-minute cache) — no extra Zoho
// calls. Oldest due first, with days overdue.
router.get("/shops/:contactId/unpaid", VIEW, async (req, res) => {
  try {
    const contactId = String(req.params.contactId);
    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ contactId });
    if (!shop) return res.status(404).json({ success: false, message: "That shop isn't on the My Fone list" });
    const list = await getUnpaidInvoices({ refresh: req.query.refresh === "1" });
    const today = todayYmd();
    const day = (ymd) => Date.UTC(...String(ymd).split("-").map((n, i) => Number(n) - (i === 1 ? 1 : 0)));
    const rows = list.rows
      .filter((r) => r.customerId === contactId)
      .map((r) => ({
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        orderNumber: r.orderNumber,
        date: r.date,
        dueDate: r.dueDate,
        total: r.total,
        balance: r.balance,
        daysOverdue: r.dueDate && r.dueDate < today ? Math.round((day(today) - day(r.dueDate)) / 86400000) : 0,
      }))
      .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || String(a.date || "").localeCompare(String(b.date || "")));
    return res.json({
      success: true,
      fetchedAt: list.at,
      ...(list.stale ? { stale: true } : {}),
      shop: { contactId, name: shop.name, email: shop.email || "", phone: shop.phone || "" },
      rows,
    });
  } catch (e) {
    console.error("My Fone unpaid invoices error:", e);
    return res.status(502).json({ success: false, message: "Could not read the unpaid invoices from Zoho" });
  }
});

// ── a shop's statement ──────────────────────────────────────────────
const stmtCache = new Map(); // contactId → { at: Date, data }
const stmtInFlight = new Map();

// Every transaction on a shop's account, oldest first.
async function readLedger(contactId, pace = 0) {
  const [invoices, payments, credits, cnRefunds] = [
    await zohoList("invoices", "invoices", contactId, pace),
    await zohoList("customerpayments", "customerpayments", contactId, pace),
    await zohoList("creditnotes", "creditnotes", contactId, pace),
    await zohoList("creditnotes/refunds", "creditnote_refunds", contactId, pace),
  ];

  const entries = [];
  const live = (s) => s !== "draft" && s !== "void";
  for (const i of invoices) {
    if (!live(i.status)) continue;
    entries.push({
      kind: "invoice", id: String(i.invoice_id), number: i.invoice_number || "", date: i.date, dueDate: i.due_date || null,
      reference: text(i.reference_number), debit: num(i.total), credit: 0, balance: num(i.balance), status: i.status, created: i.created_time || "",
    });
    if (num(i.write_off_amount) > 0) {
      entries.push({
        kind: "writeoff", id: `wo-${i.invoice_id}`, number: i.invoice_number || "", date: i.date, reference: "Written off",
        debit: 0, credit: num(i.write_off_amount), created: (i.created_time || "") + "~",
      });
    }
  }
  for (const p of payments) {
    entries.push({
      kind: "payment", id: String(p.payment_id), number: String(p.payment_number || ""), date: p.date,
      reference: text(p.payment_mode_formatted || p.payment_mode), ref: text(p.reference_number),
      detail: text(p.invoice_numbers).split(",").map((x) => x.trim()).filter(Boolean).join(", "),
      debit: 0, credit: num(p.amount), unused: num(p.unused_amount), created: p.created_time || "",
    });
    if (num(p.bcy_refunded_amount) > 0) {
      entries.push({
        kind: "refund", id: `rf-${p.payment_id}`, number: String(p.payment_number || ""), date: p.date, reference: "Payment refunded",
        debit: num(p.bcy_refunded_amount), credit: 0, created: (p.created_time || "") + "~",
      });
    }
  }
  for (const n of credits) {
    if (!live(n.status)) continue;
    entries.push({
      kind: "credit", id: String(n.creditnote_id), number: n.creditnote_number || "", date: n.date,
      reference: text(n.reference_number), debit: 0, credit: num(n.total), balance: num(n.balance), status: n.status, created: n.created_time || "",
    });
  }
  for (const f of cnRefunds) {
    entries.push({
      kind: "cnrefund", id: String(f.creditnote_refund_id), number: f.creditnote_number || "", date: f.date,
      reference: [text(f.refund_mode_formatted), text(f.reference_number)].filter(Boolean).join(" · "),
      debit: num(f.amount_bcy != null ? f.amount_bcy : f.amount), credit: 0, created: f.date || "",
    });
  }
  // by date; within a day what was charged comes before what was paid
  // (a card payment is often recorded before its invoice is raised)
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)) ||
    (b.debit > 0) - (a.debit > 0) || String(a.created).localeCompare(String(b.created)));
  for (const e of entries) delete e.created;
  return entries;
}

async function saveLedger(db, contactId, entries) {
  await db.collection(LEDGERS).replaceOne(
    { contactId },
    { contactId, entries, balance: r2(entries.reduce((t, e) => t + e.debit - e.credit, 0)), syncedAt: new Date() },
    { upsert: true },
  );
}

async function readStatement(contactId) {
  const c = await zohoGet(`/contacts/${contactId}`, "contact");
  const ct = c.contact || {};
  const entries = await readLedger(contactId);

  const ledger = r2(entries.reduce((t, e) => t + e.debit - e.credit, 0));
  const zoho = r2(num(ct.outstanding_receivable_amount) - num(ct.unused_credits_receivable_amount));
  const sym = text(ct.currency_symbol) || "$";
  return {
    contact: {
      contactId,
      name: text(ct.contact_name),
      company: text(ct.company_name),
      email: text(ct.email),
      phone: text(ct.phone) || text(ct.mobile),
      address: addressLines(ct.billing_address),
      paymentTerms: text(ct.payment_terms_label),
      currency: text(ct.currency_code) || "AUD",
      currencySymbol: sym,
      outstanding: num(ct.outstanding_receivable_amount),
      unusedCredits: num(ct.unused_credits_receivable_amount),
    },
    entries,
    check: { ledger, zoho, matches: Math.abs(ledger - zoho) < 0.01 },
  };
}

router.get("/shops/:contactId/statement", VIEW, async (req, res) => {
  const contactId = cleanId(req.params.contactId);
  if (!contactId) return res.status(400).json({ success: false, message: "Invalid shop" });
  try {
    const db = await connectToDatabase();
    const shop = await db.collection(SHOPS).findOne({ contactId });
    if (!shop) return res.status(404).json({ success: false, message: "That shop is not in the My Fone list" });

    const hit = stmtCache.get(contactId);
    const age = hit ? Date.now() - hit.at.getTime() : Infinity;
    const wantRefresh = req.query.refresh === "1" && age >= MIN_REFRESH_MS;
    let stale = false;
    if (!hit || age >= CACHE_MS || wantRefresh) {
      try {
        if (!stmtInFlight.has(contactId)) {
          stmtInFlight.set(contactId, readStatement(contactId)
            .then(async (data) => {
              stmtCache.set(contactId, { at: new Date(), data });
              await saveLedger(db, contactId, data.entries); // the period totals use it too
            })
            .finally(() => { stmtInFlight.delete(contactId); }));
        }
        await stmtInFlight.get(contactId);
      } catch (e) {
        console.error("My Fone statement error:", e.message);
        if (!hit) return res.status(502).json({ success: false, message: "Could not read this shop's account from Zoho" });
        stale = true;
      }
    }
    const { at, data } = stmtCache.get(contactId);

    // keep the list's name / email / phone in step with Zoho
    const c = data.contact;
    if (c.name && (c.name !== shop.name || c.email !== (shop.email || "") || c.phone !== (shop.phone || ""))) {
      await db.collection(SHOPS).updateOne({ contactId }, { $set: { name: c.name, email: c.email, phone: c.phone, updatedAt: new Date() } });
    }
    return res.json({ success: true, fetchedAt: at, ...(stale ? { stale: true } : {}), today: todayYmd(), ...data });
  } catch (e) {
    console.error("My Fone statement error:", e);
    return res.status(500).json({ success: false, message: "Could not load the statement" });
  }
});

// ── the stored histories: sync ──────────────────────────────────────
const syncState = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, failed: [], reason: null, by: null };
let syncRun = null;

async function runSync(db, shops) {
  for (const s of shops) {
    try {
      await saveLedger(db, s.contactId, await readLedger(s.contactId, SYNC_PACE_MS));
    } catch (e) {
      console.error(`My Fone sync — ${s.name}:`, e.message);
      syncState.failed.push(s.name);
    }
    syncState.done += 1;
  }
}

// Re-reads the given shops' histories in the background; false when a
// sync is already going.
function startSync(db, shops, reason, by) {
  if (syncRun || !shops.length) return false;
  Object.assign(syncState, { running: true, startedAt: new Date(), finishedAt: null, total: shops.length, done: 0, failed: [], reason, by });
  syncRun = runSync(db, shops)
    .catch((e) => console.error("My Fone sync error:", e.message))
    .finally(() => {
      syncRun = null;
      syncState.running = false;
      syncState.finishedAt = new Date();
    });
  return true;
}

function syncStatus() {
  return {
    running: syncState.running,
    done: syncState.done,
    total: syncState.total,
    startedAt: syncState.startedAt,
    finishedAt: syncState.finishedAt,
    failed: syncState.failed,
  };
}

// When each shop's history was last read ({ contactId → Date }).
async function syncedAtByShop(db, ids) {
  const rows = await db.collection(LEDGERS).find({ contactId: { $in: ids } }, { projection: { contactId: 1, syncedAt: 1 } }).toArray();
  return new Map(rows.map((r) => [r.contactId, r.syncedAt]));
}

router.get("/sync", VIEW, (req, res) => res.json({ success: true, sync: syncStatus() }));

router.post("/sync", VIEW, async (req, res) => {
  try {
    if (syncState.running) return res.json({ success: true, started: false, sync: syncStatus() });
    const db = await connectToDatabase();
    const shops = await db.collection(SHOPS).find({}).sort({ sort: 1 }).toArray();
    const at = await syncedAtByShop(db, shops.map((s) => s.contactId));
    const times = shops.map((s) => (at.get(s.contactId) ? new Date(at.get(s.contactId)).getTime() : 0));
    const oldest = times.length ? Math.min(...times) : 0;
    if (oldest && Date.now() - oldest < MIN_SYNC_GAP_MS) {
      const wait = Math.ceil((MIN_SYNC_GAP_MS - (Date.now() - oldest)) / 60000);
      return res.status(429).json({
        success: false,
        message: `Every shop was synced in the last 30 minutes — try again in ${wait} min`,
      });
    }
    startSync(db, shops, "manual", who(req));
    return res.json({ success: true, started: true, sync: syncStatus() });
  } catch (e) {
    console.error("My Fone sync start error:", e);
    return res.status(500).json({ success: false, message: "Could not start the sync" });
  }
});

// ── a period: what each shop was invoiced and paid ──────────────────
function periodFigures(entries, from, to) {
  const f = { opening: 0, invoiced: 0, invoices: 0, received: 0, payments: 0, credits: 0, closing: 0, lastInvoice: null, lastPayment: null };
  let paidIn = 0;
  let refunds = 0;
  for (const e of entries) {
    if (e.date > to) continue;
    if (e.kind === "invoice" && (!f.lastInvoice || e.date > f.lastInvoice)) f.lastInvoice = e.date;
    if (e.kind === "payment" && (!f.lastPayment || e.date > f.lastPayment)) f.lastPayment = e.date;
    if (from && e.date < from) {
      f.opening += e.debit - e.credit;
      continue;
    }
    if (e.kind === "invoice") {
      f.invoiced += e.debit;
      f.invoices += 1;
    } else refunds += e.debit; // refunds give money back
    paidIn += e.credit;
    if (e.kind === "payment") f.payments += 1;
    if (e.kind === "credit") f.credits += 1;
  }
  f.received = paidIn - refunds;
  f.closing = f.opening + f.invoiced - f.received;
  for (const k of ["opening", "invoiced", "received", "closing"]) f[k] = r2(f[k]);
  return f;
}

router.get("/activity", VIEW, async (req, res) => {
  const from = YMD.test(String(req.query.from || "")) ? String(req.query.from) : "";
  const to = YMD.test(String(req.query.to || "")) ? String(req.query.to) : todayYmd();
  if (from && from > to) return res.status(400).json({ success: false, message: "The period starts after it ends" });
  try {
    const db = await connectToDatabase();
    const shops = await db.collection(SHOPS).find({}).sort({ sort: 1 }).toArray();
    const ids = shops.map((s) => s.contactId);
    const ledgers = await db.collection(LEDGERS)
      .find({ contactId: { $in: ids } }, {
        projection: {
          contactId: 1, syncedAt: 1, balance: 1,
          "entries.kind": 1, "entries.date": 1, "entries.debit": 1, "entries.credit": 1, "entries.unused": 1, "entries.balance": 1,
        },
      })
      .toArray();
    const byId = new Map(ledgers.map((l) => [l.contactId, l]));

    // new shops first; otherwise anything over 12 hours old
    const missing = shops.filter((s) => !byId.has(s.contactId));
    const staleBefore = Date.now() - LEDGER_STALE_MS;
    const stale = shops.filter((s) => byId.has(s.contactId) && new Date(byId.get(s.contactId).syncedAt).getTime() < staleBefore);
    if (missing.length) startSync(db, missing, "new", null);
    else if (stale.length) startSync(db, stale, "daily", null);

    let firstDate = null;
    for (const l of ledgers) for (const e of l.entries || []) if (e.date && (!firstDate || e.date < firstDate)) firstDate = e.date;
    const since = from || firstDate || to;

    const totals = { opening: 0, invoiced: 0, invoices: 0, received: 0, payments: 0, credits: 0, closing: 0, shopsInvoiced: 0 };
    const byShop = {};
    for (const s of shops) {
      const l = byId.get(s.contactId);
      if (!l) { byShop[s.contactId] = null; continue; }
      const f = periodFigures(l.entries || [], from, to);
      // credit the shop holds today: overpayments not yet used + open credit notes
      // (what Zoho calls unused credits; balance = unpaid invoices − this)
      const unusedCredits = r2((l.entries || []).reduce((t, e) =>
        t + (e.kind === "payment" ? num(e.unused) : 0) + (e.kind === "credit" ? num(e.balance) : 0), 0));
      byShop[s.contactId] = { ...f, balance: num(l.balance), unusedCredits, syncedAt: l.syncedAt };
      for (const k of ["opening", "invoiced", "invoices", "received", "payments", "credits", "closing"]) totals[k] += f[k];
      if (f.invoices) totals.shopsInvoiced += 1;
    }
    for (const k of ["opening", "invoiced", "received", "closing"]) totals[k] = r2(totals[k]);
    const times = ledgers.map((l) => new Date(l.syncedAt).getTime());
    return res.json({
      success: true,
      from: since,
      to,
      byShop,
      totals,
      history: {
        oldest: times.length ? new Date(Math.min(...times)) : null,
        newest: times.length ? new Date(Math.max(...times)) : null,
        missing: missing.length,
        shops: shops.length,
      },
      sync: syncStatus(),
    });
  } catch (e) {
    console.error("My Fone activity error:", e);
    return res.status(500).json({ success: false, message: "Could not work out the period" });
  }
});

// ── managing the list ───────────────────────────────────────────────
router.get("/contacts", EDIT, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ success: true, rows: [] });
  try {
    const r = await zohoGet(
      `/contacts?contact_type=customer&filter_by=Status.All&per_page=50&search_text=${encodeURIComponent(q)}`,
      "contacts",
    );
    const db = await connectToDatabase();
    const have = new Set((await db.collection(SHOPS).find({}, { projection: { contactId: 1 } }).toArray()).map((s) => s.contactId));
    const rows = (r.contacts || []).map((c) => ({
      contactId: String(c.contact_id),
      name: text(c.contact_name),
      company: text(c.company_name),
      email: text(c.email),
      phone: text(c.phone) || text(c.mobile),
      status: text(c.status),
      outstanding: num(c.outstanding_receivable_amount),
      inList: have.has(String(c.contact_id)),
    }));
    return res.json({ success: true, rows });
  } catch (e) {
    console.error("My Fone contact search error:", e.message);
    return res.status(502).json({ success: false, message: "Could not search Zoho customers" });
  }
});

router.post("/shops", EDIT, async (req, res) => {
  const contactId = cleanId(req.body && req.body.contactId);
  if (!contactId) return res.status(400).json({ success: false, message: "Pick a Zoho customer" });
  try {
    const db = await connectToDatabase();
    if (await db.collection(SHOPS).findOne({ contactId })) {
      return res.status(409).json({ success: false, message: "That shop is already in the list" });
    }
    const r = await zohoGet(`/contacts/${contactId}`, "contact");
    const ct = r.contact || {};
    if (ct.contact_type && ct.contact_type !== "customer") {
      return res.status(400).json({ success: false, message: "That Zoho contact is not a customer" });
    }
    const last = await db.collection(SHOPS).find({}).sort({ sort: -1 }).limit(1).toArray();
    const doc = {
      contactId,
      name: text(ct.contact_name) || contactId,
      email: text(ct.email),
      phone: text(ct.phone) || text(ct.mobile),
      sort: (last[0] && Number(last[0].sort) ? Number(last[0].sort) : 0) + 1,
      addedAt: new Date(),
      addedBy: who(req),
      updatedAt: new Date(),
    };
    await db.collection(SHOPS).insertOne(doc);
    // its history, for the period totals (in the background)
    readLedger(contactId)
      .then((entries) => saveLedger(db, contactId, entries))
      .catch((e) => console.error("My Fone new shop history:", e.message));
    return res.json({ success: true, shop: doc });
  } catch (e) {
    console.error("My Fone add shop error:", e.message);
    return res.status(500).json({ success: false, message: "Could not add the shop" });
  }
});

router.delete("/shops/:contactId", EDIT, async (req, res) => {
  const contactId = cleanId(req.params.contactId);
  if (!contactId) return res.status(400).json({ success: false, message: "Invalid shop" });
  try {
    const db = await connectToDatabase();
    const r = await db.collection(SHOPS).deleteOne({ contactId });
    await db.collection(LEDGERS).deleteOne({ contactId });
    stmtCache.delete(contactId);
    return res.json({ success: true, removed: r.deletedCount });
  } catch (e) {
    console.error("My Fone remove shop error:", e.message);
    return res.status(500).json({ success: false, message: "Could not remove the shop" });
  }
});

module.exports = router;
