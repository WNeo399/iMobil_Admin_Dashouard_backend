// iMobile Repair endpoints — thin proxy to RepairDesk for the iMobile
// account, gated by the `repair:*` permission group.
//
// Important: uses IMB_REPAIRDESK_API_KEY (the iMobile org's RepairDesk key),
// NOT the REPAIRDESK_API_KEY used by utils/repairDesk.js (which talks to
// the TechElite shops' RepairDesk for SQT status sync). The two are
// different RepairDesk accounts and must stay distinct.

var express = require("express");
var axios = require("axios");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";
// `filter=45` is the saved RepairDesk filter the original standalone page
// used — it scopes to active iMobile-store tickets only. Same value as in
// Imobile-Repair/src/app/util/helper.js.
const FILTER_ID = 45;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // safety net so a runaway response can't loop forever

const GATE_LIST = requirePermission("repair:ticket:list");
const GATE_DETAIL = requirePermission("repair:ticket:detail");

function getApiKey() {
  const key = process.env.IMB_REPAIRDESK_API_KEY;
  if (!key) {
    const err = new Error(
      "IMB_REPAIRDESK_API_KEY is not configured in the backend .env",
    );
    err.status = 500;
    throw err;
  }
  return key;
}

// Mirrors formateDate in Imobile-Repair/src/app/util/helper.js so dueDate
// strings in the response look the same as the original page produced.
function formatDateMs(ms) {
  if (!ms) return "";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sept", "Oct", "Nov", "Dec",
  ];
  const d = new Date(ms);
  const date = d.getDate();
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  let hour = d.getHours();
  const ampm = hour >= 12 ? "PM" : "AM";
  if (hour > 12) hour -= 12;
  if (hour === 0) hour = 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${date} ${month}, ${year} (${hour}:${minutes} ${ampm})`;
}

// Walk the RepairDesk paginated /tickets endpoint until next_page_exist === 0.
// Hits the MAX_PAGES safety cap only when RepairDesk returns >50k tickets,
// which would be surprising for the iMobile org — surface a console.warn
// if that ever happens so we know to revisit the cap.
async function fetchAllTickets(apiKey) {
  const all = [];
  let page = 0;
  let nextPageExists = 1;
  while (nextPageExists > 0 && page < MAX_PAGES) {
    page += 1;
    const url =
      `${REPAIRDESK_API_BASE}/tickets` +
      `?api_key=${encodeURIComponent(apiKey)}` +
      `&filter=${FILTER_ID}` +
      `&pagesize=${PAGE_SIZE}` +
      `&page=${page}`;
    const resp = await axios.get(url, { timeout: 30000 });
    const data = (resp.data && resp.data.data) || {};
    if (Array.isArray(data.ticketData)) {
      for (const t of data.ticketData) all.push(t);
    }
    nextPageExists = (data.pagination && data.pagination.next_page_exist) || 0;
  }
  if (nextPageExists > 0 && page >= MAX_PAGES) {
    console.warn(
      `[Repair] /tickets hit MAX_PAGES=${MAX_PAGES} (>= ${MAX_PAGES * PAGE_SIZE} tickets) — data may be truncated. Raise MAX_PAGES if this is expected.`,
    );
  }
  return all;
}

// Status-name strings RepairDesk uses for the three repaired sub-states.
// Treated as literal matches before the legacy `.includes("Repaired")`
// catch-all so a bare "Repaired" status doesn't accidentally swallow the
// "& Collected" / "and Dispatching" variants. The Collected variant is
// matched against both spellings because RepairDesk inconsistently uses
// "&" vs "and" across orgs (the SQT integration sees "Repaired & Collected").
const REPAIRED_DISPATCHING = "Repaired and Dispatching";
const REPAIRED_COLLECTED_VARIANTS = new Set([
  "Repaired and Collected",
  "Repaired & Collected",
]);

// Two unrepairable sub-states the iMobile org uses. Same "&" vs "and"
// defensiveness as the Repaired matchers above — accept both spellings
// so an admin re-saving the status in RepairDesk doesn't quietly drop
// tickets into the Other bucket.
const UNREPAIRABLE_DISPATCHING_VARIANTS = new Set([
  "Unrepairable and Dispatching",
  "Unrepairable & Dispatching",
]);
const UNREPAIRABLE_RETURNED_VARIANTS = new Set([
  "Unrepairable & Returned",
  "Unrepairable and Returned",
]);

// Group raw RepairDesk tickets into the buckets the page renders. The
// status-name string-matches are intentionally verbatim — they're how
// RepairDesk labels things on the iMobile org and changing the strings
// here breaks the grouping silently.
function groupTickets(raw) {
  const groups = {
    notYetRecive: [],
    overDue: [],
    pending: [],
    inProgress: [],
    onHold: [],
    // Three repaired sub-buckets — see the constants above for the
    // status-name strings each one matches. Anything else that contains
    // "Repaired" lands in plain `repaired` as a fallback.
    repaired: [],
    repairedDispatching: [],
    repairedCollected: [],
    // Two unrepairable sub-buckets. Matched by exact string (with both
    // & / and spellings) before the fullfilled catch-all so they don't
    // get lumped into "Other".
    unrepairableDispatching: [],
    unrepairableReturned: [],
    fullfilled: [],
  };
  // Hoist the "now" reference out of the per-ticket loop so every
  // overdue check uses the same instant — also avoids reading the system
  // clock N times for a list that's classified atomically.
  const now = Date.now();

  for (const each of raw) {
    if (!each || !each.summary || !Array.isArray(each.devices) || !each.devices[0]) {
      continue;
    }
    const t = {
      id: each.summary.id,
      ticketNumber: each.summary.order_id,
      createDate: each.summary.created_date * 1000,
      customer: (each.summary.customer && each.summary.customer.fullName) || "",
      dueDate: "",
      overDue: false,
      devices: each.devices,
    };
    // Due date: if due_on is set and positive use it, otherwise fall back
    // to created_date + 7 days. Mirrors the original.
    const dueOn = each.devices[0].due_on;
    const preformatedTs =
      dueOn && dueOn > 0
        ? dueOn * 1000
        : (each.summary.created_date + 7 * 24 * 60 * 60) * 1000;
    t.dueDate = formatDateMs(preformatedTs);

    const statusName =
      (each.devices[0].status && each.devices[0].status.name) || "";

    if (now > preformatedTs && statusName === "Received") {
      t.overDue = true;
      groups.overDue.push(t);
    } else if (
      statusName === "Waiting for Parts" ||
      statusName === "Awaiting reply"
    ) {
      groups.onHold.push(t);
    } else if (statusName === REPAIRED_DISPATCHING) {
      groups.repairedDispatching.push(t);
    } else if (REPAIRED_COLLECTED_VARIANTS.has(statusName)) {
      groups.repairedCollected.push(t);
    } else if (statusName.includes("Repaired")) {
      groups.repaired.push(t);
    } else if (UNREPAIRABLE_DISPATCHING_VARIANTS.has(statusName)) {
      groups.unrepairableDispatching.push(t);
    } else if (UNREPAIRABLE_RETURNED_VARIANTS.has(statusName)) {
      groups.unrepairableReturned.push(t);
    } else if (statusName === "Pending") {
      groups.pending.push(t);
    } else if (statusName === "Received") {
      groups.inProgress.push(t);
    } else {
      groups.fullfilled.push(t);
    }
  }
  return groups;
}

// Build a { orderId -> createdDate } map of repaired-invoice dates so the
// frontend can stamp a "Repaired Date" on every repaired ticket without a
// second client-side join.
async function fetchInvoiceMap(apiKey) {
  const url =
    `${REPAIRDESK_API_BASE}/invoices` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&filter=${FILTER_ID}` +
    `&pagesize=${PAGE_SIZE}`;
  const resp = await axios.get(url, { timeout: 30000 });
  const list =
    (resp.data && resp.data.data && resp.data.data.invoiceData) || [];
  const map = {};
  for (const inv of list) {
    const order =
      inv && inv.summary && inv.summary.ticket && inv.summary.ticket.order_id;
    const created = inv && inv.summary && inv.summary.created_date;
    if (order && created) {
      map[String(order)] = created;
    }
  }
  return map;
}

// ── GET /repair/tickets ──────────────────────────────────────────────
// One round trip that fetches every iMobile RepairDesk ticket + the
// invoice-by-orderId map, groups them by status, and stamps repaired_date
// on each repaired ticket. The frontend gets a single ready-to-render
// payload — no client-side joins needed.
router.get("/tickets", GATE_LIST, async function (req, res) {
  try {
    const apiKey = getApiKey();
    const [raw, invoiceMap] = await Promise.all([
      fetchAllTickets(apiKey),
      fetchInvoiceMap(apiKey),
    ]);
    const ticketGrouped = groupTickets(raw);
    // Stamp the invoice's created_date as `repaired_date` on every
    // repaired-variant ticket so the table can render it directly. If
    // there's no matching invoice yet (e.g. status set but invoice not
    // raised), the field is null and the cell shows "—".
    const stampRepairedDate = (list) => {
      for (const t of list) {
        t.repaired_date = invoiceMap[String(t.ticketNumber)] || null;
      }
    };
    stampRepairedDate(ticketGrouped.repaired);
    stampRepairedDate(ticketGrouped.repairedDispatching);
    stampRepairedDate(ticketGrouped.repairedCollected);
    return res.json({
      success: true,
      data: { ticketGrouped, invoiceMap },
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Repair /tickets error:", error.message || error);
    return res.status(status).json({
      success: false,
      message: `Failed to fetch tickets: ${error.message || error}`,
    });
  }
});

// ── GET /repair/tickets/:id ──────────────────────────────────────────
// Single-ticket detail proxy. Used by the Detail dialog. Surfaces
// "No Result Found" as a 404 so the frontend can show a clean error.
router.get("/tickets/:id", GATE_DETAIL, async function (req, res) {
  try {
    const apiKey = getApiKey();
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "id is required" });
    }
    const url =
      `${REPAIRDESK_API_BASE}/tickets/${encodeURIComponent(id)}` +
      `?api_key=${encodeURIComponent(apiKey)}`;
    const resp = await axios.get(url, { timeout: 30000 });
    const body = resp.data || {};
    if (body.message === "No Result Found") {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }
    return res.json({
      success: true,
      data: body.data || null,
    });
  } catch (error) {
    const status = error.status || 500;
    console.error("Repair /tickets/:id error:", error.message || error);
    return res.status(status).json({
      success: false,
      message: `Failed to fetch ticket: ${error.message || error}`,
    });
  }
});

module.exports = router;
