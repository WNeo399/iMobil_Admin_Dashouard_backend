// Every Zoho Inventory invoice with money still owing — Zoho's Unpaid
// (sent / overdue) and Partially Paid lists, merged by invoice. Read by
// the My Fone summary (routes/accountantRoutes/myfone.js); it also fed the
// Accountant Dashboard page until that was taken out on 2026-10-01.
//
// Zoho's daily Inventory call cap (10,000) is shared with production, so
// the list is kept for 10 minutes; a refresh reads it again, at most once a
// minute. A page that never comes back fails the read rather than giving a
// short list — the caller then gets the last good list, marked stale.

const { handleZohoInventoryRequest } = require("./zohoRequest");
const { ORGANIZATION_ID } = require("./zohoStock");

const CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const FILTERS = ["Status.Unpaid", "Status.PartiallyPaid"];
const MAX_PAGES = 100; // 200 a page — far more than will ever be owing
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

let cache = null; // { at: Date, rows }
let inFlight = null;

async function readFilter(filter) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://www.zohoapis.com/inventory/v1/invoices?organization_id=${ORGANIZATION_ID}` +
      `&filter_by=${filter}&per_page=200&page=${page}&sort_column=due_date&sort_order=A`;
    let resp = null;
    let lastSeen;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await handleZohoInventoryRequest(url);
      if (r && Array.isArray(r.invoices)) { resp = r; break; }
      lastSeen = r;
      if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
    if (!resp) {
      throw new Error(
        `Zoho invoices (${filter}) page ${page} failed` + (lastSeen ? `: ${JSON.stringify(lastSeen).slice(0, 160)}` : ""),
      );
    }
    out.push(...resp.invoices);
    if (!(resp.page_context && resp.page_context.has_more_page)) break;
  }
  return out;
}

function shape(i) {
  return {
    invoiceId: String(i.invoice_id),
    invoiceNumber: i.invoice_number || "",
    orderNumber: i.reference_number || "",
    customerId: String(i.customer_id || ""),
    customerName: i.customer_name || i.company_name || "",
    date: i.date || null,
    dueDate: i.due_date || null,
    status: i.status || "",
    total: num(i.total),
    balance: num(i.balance),
    currency: i.currency_code || "",
    currencySymbol: i.currency_symbol || "$",
    salesperson: i.salesperson_name || "",
  };
}

async function readAll() {
  const byId = new Map();
  for (const filter of FILTERS) {
    for (const inv of await readFilter(filter)) {
      if (num(inv.balance) > 0 && inv.status !== "void" && inv.status !== "draft") byId.set(String(inv.invoice_id), inv);
    }
  }
  const rows = [...byId.values()].map(shape);
  rows.sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")) || b.balance - a.balance);
  return rows;
}

// → { at: Date, rows, stale? }. Throws only when Zoho fails and there is
// no earlier list to fall back on.
async function getUnpaidInvoices({ refresh = false } = {}) {
  const now = Date.now();
  const age = cache ? now - cache.at.getTime() : Infinity;
  const wantRefresh = refresh && age >= MIN_REFRESH_MS;
  if (cache && age < CACHE_MS && !wantRefresh) return { at: cache.at, rows: cache.rows };
  try {
    // one read at a time, whoever asks meanwhile shares it
    if (!inFlight) {
      inFlight = readAll()
        .then((rows) => { cache = { at: new Date(), rows }; })
        .finally(() => { inFlight = null; });
    }
    await inFlight;
    return { at: cache.at, rows: cache.rows };
  } catch (error) {
    console.error("Unpaid invoices error:", error.message);
    // the last good list beats an error page, when there is one
    if (cache) return { at: cache.at, rows: cache.rows, stale: true };
    throw error;
  }
}

module.exports = { getUnpaidInvoices, MIN_REFRESH_MS };
