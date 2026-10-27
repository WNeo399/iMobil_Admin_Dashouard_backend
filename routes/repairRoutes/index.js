// iMobile Repair endpoints — thin proxy to RepairDesk for the iMobile
// account, gated by the `repair:*` permission group.
//
// Uses IMB_REPAIRDESK_API_KEY — the iMobile org's own RepairDesk account.
// (The TechElite shops' RepairDesk, used for SQT, was retired in 2026-09.)

var express = require("express");
var axios = require("axios");
var router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";
// The saved RepairDesk filter the list (and the invoice join) reads. Each
// looks like a rolling window of tickets created in the last N days: #45
// (the original standalone page's, 45 days) → #60 (user 2026-10-27: 60 days —
// 435 tickets from 28 Aug vs 330 from 14 Sep, every #45 ticket included).
const FILTER_ID = 60;
const PAGE_SIZE = 1000;
const MAX_PAGES = 50; // safety net so a runaway response can't loop forever

const GATE_LIST = requirePermission("repair:ticket:list");
const GATE_DETAIL = requirePermission("repair:ticket:detail");
// Changing a ticket's status / adding a note write to RepairDesk (user 2026-10-27).
const GATE_STATUS = requirePermission("repair:ticket:status");
const GATE_NOTE = requirePermission("repair:ticket:note");
const NOTE_MAX = 2000;

// Every dashboard status change, who made it and what RepairDesk answered.
const STATUS_LOG = "imb_repair_status_log";

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

// ── GET /repair/tickets/search?q= ────────────────────────────────────
// A ticket-number search over EVERY RepairDesk ticket (user 2026-10-27:
// "in case it is older than the 60 days but is in RepairDesk") — the list
// above only holds the saved filter's window. RepairDesk's `keyword` finds
// "0-33512", "33512" or a part ("3351"); a saved filter would narrow it back
// to the window, so none is sent. Answers the same groups as /tickets (up
// to 50 tickets, newest first) with repaired dates from a keyword invoice
// search where RepairDesk gives one.
router.get("/tickets/search", GATE_LIST, async function (req, res) {
  try {
    const apiKey = getApiKey();
    const q = String(req.query.q || "").trim();
    if (q.length < 3) return res.json({ success: true, data: { ticketGrouped: groupTickets([]), total: 0 } });
    const key = encodeURIComponent(apiKey);
    const kw = encodeURIComponent(q);
    const [resp, invoiceMap] = await Promise.all([
      axios.get(`${REPAIRDESK_API_BASE}/tickets?api_key=${key}&keyword=${kw}&pagesize=50&page=1`, { timeout: 30000 }),
      axios.get(`${REPAIRDESK_API_BASE}/invoices?api_key=${key}&keyword=${kw}&pagesize=100`, { timeout: 30000 })
        .then((r) => {
          const map = {};
          for (const inv of (r.data && r.data.data && r.data.data.invoiceData) || []) {
            const order = inv && inv.summary && inv.summary.ticket && inv.summary.ticket.order_id;
            const created = inv && inv.summary && inv.summary.created_date;
            if (order && created) map[String(order)] = created;
          }
          return map;
        })
        .catch(() => ({})),
    ]);
    // RepairDesk answers "No Result Found" (success false, empty data) when nothing matches
    const data = (resp.data && resp.data.data) || {};
    const raw = Array.isArray(data.ticketData) ? data.ticketData : [];
    const ticketGrouped = groupTickets(raw);
    for (const k of ["repaired", "repairedDispatching", "repairedCollected"]) {
      for (const t of ticketGrouped[k]) t.repaired_date = invoiceMap[String(t.ticketNumber)] || null;
    }
    const total = (data.pagination && data.pagination.total_records) || raw.length;
    return res.json({ success: true, data: { ticketGrouped, total } });
  } catch (error) {
    const status = error.status || 500;
    console.error("Repair /tickets/search error:", error.message || error);
    return res.status(status).json({ success: false, message: `Failed to search RepairDesk: ${error.message || error}` });
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

// RepairDesk's ticket statuses (GET /statuses), one per name — the account
// lists Pending, Repaired, Waiting for Parts and Warranty Repair twice, and a
// status is set by its name. Cached for 10 minutes.
const STATUS_TTL_MS = 10 * 60 * 1000;
let statusCache = { at: 0, list: null };
async function fetchStatuses(apiKey) {
  if (statusCache.list && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.list;
  const resp = await axios.get(
    `${REPAIRDESK_API_BASE}/statuses?api_key=${encodeURIComponent(apiKey)}`,
    { timeout: 30000 },
  );
  const seen = new Set();
  const list = [];
  for (const s of (resp.data && resp.data.data) || []) {
    const name = String((s && s.name) || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, type: s.type || "", color: s.color || "" });
  }
  if (list.length) statusCache = { at: Date.now(), list };
  return list;
}

// One ticket's detail, or null when RepairDesk answers "No Result Found".
// Its summary + devices have the list's shape, so groupTickets takes it.
async function fetchTicket(apiKey, id) {
  const resp = await axios.get(
    `${REPAIRDESK_API_BASE}/tickets/${encodeURIComponent(id)}?api_key=${encodeURIComponent(apiKey)}`,
    { timeout: 30000 },
  );
  const body = resp.data || {};
  if (body.message === "No Result Found" || !body.data || !body.data.summary) return null;
  return body.data;
}

// A ticket as the list holds it, with the status group it now falls in.
function listShapeOf(raw) {
  const grouped = groupTickets([{ summary: raw.summary, devices: raw.devices }]);
  for (const [group, list] of Object.entries(grouped)) {
    if (list.length) return { group, ticket: list[0] };
  }
  return { group: null, ticket: null };
}

const statusNameOf = (d) => (d && d.status && d.status.name) || "";
const deviceNameOf = (d) => (d && ((d.device && d.device.name) || d.name)) || `line ${d && d.id}`;
const refusalOf = (body) =>
  (body && ((body.data && body.data.message) || body.message)) || "RepairDesk refused the change";

// ── GET /repair/statuses ─────────────────────────────────────────────
// The statuses a ticket can be set to, for the page's status menu.
router.get("/statuses", GATE_STATUS, async function (req, res) {
  try {
    const list = await fetchStatuses(getApiKey());
    return res.json({ success: true, data: list });
  } catch (error) {
    console.error("Repair /statuses error:", error.message || error);
    return res.status(error.status || 500).json({
      success: false,
      message: `Failed to fetch RepairDesk statuses: ${error.message || error}`,
    });
  }
});

// ── POST /repair/tickets/:id/status { status, deviceIds? } ───────────
// Sets a ticket's status in RepairDesk (user 2026-10-27: "update the ticket
// status from iMobile Repair page and push back to RepairDesk"). RepairDesk
// keeps a status per device line (POST /ticket/updateticketstatus { id,
// ticketInvId, status }): every line on the ticket, or only `deviceIds`;
// lines already in that status are left alone. Then an internal note on the
// ticket says who changed it — RepairDesk logs an API change under the API
// key's owner, not the dashboard user — and the change goes into
// imb_repair_status_log. Answers the ticket re-read from RepairDesk in the
// list's shape with the status group it now falls in.
router.post("/tickets/:id/status", GATE_STATUS, async function (req, res) {
  try {
    const apiKey = getApiKey();
    const id = String(req.params.id || "").trim();
    const status = String((req.body && req.body.status) || "").trim();
    const only = Array.isArray(req.body && req.body.deviceIds) ? req.body.deviceIds.map(String) : null;
    if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: "Bad ticket id" });
    if (!status) return res.status(400).json({ success: false, message: "Pick a status" });
    // an unknown name never reaches RepairDesk
    const statuses = await fetchStatuses(apiKey);
    if (!statuses.some((s) => s.name === status)) {
      return res.status(400).json({ success: false, message: `"${status}" isn't a RepairDesk status` });
    }
    const ticket = await fetchTicket(apiKey, id);
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
    const devices = Array.isArray(ticket.devices) ? ticket.devices : [];
    const picked = only ? devices.filter((d) => only.includes(String(d.id))) : devices;
    if (only && picked.length !== only.length) {
      return res.status(400).json({ success: false, message: "A device line isn't on this ticket" });
    }
    if (!picked.length) return res.status(400).json({ success: false, message: "This ticket has no device lines" });

    const todo = picked.filter((d) => statusNameOf(d) !== status);
    if (!todo.length) {
      return res.json({ success: true, data: { unchanged: true, changed: [], failed: [], noteAdded: false, ...listShapeOf(ticket) } });
    }

    const key = encodeURIComponent(apiKey);
    const changed = [];
    const failed = [];
    for (const d of todo) {
      const line = { id: String(d.id), name: deviceNameOf(d), from: statusNameOf(d) };
      try {
        const resp = await axios.post(
          `${REPAIRDESK_API_BASE}/ticket/updateticketstatus?api_key=${key}`,
          { id: Number(id), ticketInvId: Number(d.id), status },
          { timeout: 30000 },
        );
        if (resp.data && resp.data.success) changed.push(line);
        else failed.push({ ...line, message: refusalOf(resp.data) });
      } catch (e) {
        failed.push({ ...line, message: e.response ? refusalOf(e.response.data) : e.message });
      }
    }

    const by = (req.user && req.user.username) || "unknown";
    let noteAdded = false;
    if (changed.length) {
      const note = changed.length === 1 && devices.length === 1
        ? `Status changed from "${changed[0].from}" to "${status}" by ${by} (iMobile dashboard)`
        : `Status changed to "${status}" by ${by} (iMobile dashboard): ` +
          changed.map((c) => `${c.name} (was "${c.from}")`).join("; ");
      try {
        const resp = await axios.post(
          `${REPAIRDESK_API_BASE}/ticket/addnote?api_key=${key}`,
          { id: Number(id), type: 0, note, is_flag: 0 },
          { timeout: 30000 },
        );
        noteAdded = !!(resp.data && resp.data.success);
      } catch (e) {
        console.warn(`[Repair] note on ticket ${id} failed:`, e.response ? refusalOf(e.response.data) : e.message);
      }
    }

    try {
      const db = await connectToDatabase();
      await db.collection(STATUS_LOG).insertOne({
        ticketId: id,
        ticketNumber: ticket.summary.order_id || "",
        status,
        changed,
        failed,
        noteAdded,
        by,
        at: new Date(),
      });
    } catch (e) {
      console.warn("[Repair] status log failed:", e.message || e);
    }

    if (!changed.length) {
      return res.status(502).json({ success: false, message: `RepairDesk refused: ${failed[0].message}` });
    }
    // re-read so the page shows what RepairDesk now holds
    const fresh = (await fetchTicket(apiKey, id).catch(() => null)) || ticket;
    return res.json({ success: true, data: { changed, failed, noteAdded, ...listShapeOf(fresh) } });
  } catch (error) {
    console.error("Repair /tickets/:id/status error:", error.message || error);
    return res.status(error.status || 500).json({
      success: false,
      message: `Failed to change the status: ${error.message || error}`,
    });
  }
});

// ── POST /repair/tickets/:id/notes { note, type, deviceId?, flag? } ──
// Adds a note to a RepairDesk ticket (user 2026-10-27: "add an action to
// add a note") — POST /ticket/addnote { id, type: 0 internal / 1 diagnostic,
// note, deviceId (one device line, optional), is_flag }. RepairDesk files an
// API note under the API key's owner, so the text is signed with the
// dashboard user, like the status-change note. Answers RepairDesk's note.
router.post("/tickets/:id/notes", GATE_NOTE, async function (req, res) {
  try {
    const apiKey = getApiKey();
    const id = String(req.params.id || "").trim();
    const body = req.body || {};
    const note = String(body.note || "").trim();
    const deviceId = body.deviceId ? String(body.deviceId) : "";
    if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: "Bad ticket id" });
    if (!note) return res.status(400).json({ success: false, message: "Write a note" });
    if (note.length > NOTE_MAX) {
      return res.status(400).json({ success: false, message: `A note is at most ${NOTE_MAX} characters` });
    }
    const ticket = await fetchTicket(apiKey, id);
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
    if (deviceId && !(ticket.devices || []).some((d) => String(d.id) === deviceId)) {
      return res.status(400).json({ success: false, message: "That device line isn't on this ticket" });
    }
    const by = (req.user && req.user.username) || "unknown";
    const payload = {
      id: Number(id),
      type: body.type === "diagnostic" ? 1 : 0,
      note: `${note}\n— ${by} (iMobile dashboard)`,
      is_flag: body.flag ? 1 : 0,
    };
    if (deviceId) payload.deviceId = Number(deviceId);
    let resp;
    try {
      resp = await axios.post(
        `${REPAIRDESK_API_BASE}/ticket/addnote?api_key=${encodeURIComponent(apiKey)}`,
        payload,
        { timeout: 30000 },
      );
    } catch (e) {
      return res.status(502).json({ success: false, message: `RepairDesk refused: ${e.response ? refusalOf(e.response.data) : e.message}` });
    }
    if (!(resp.data && resp.data.success)) {
      return res.status(502).json({ success: false, message: `RepairDesk refused: ${refusalOf(resp.data)}` });
    }
    const saved = Array.isArray(resp.data.data) ? resp.data.data[0] || null : resp.data.data || null;
    return res.json({ success: true, data: { note: saved } });
  } catch (error) {
    console.error("Repair /tickets/:id/notes error:", error.message || error);
    return res.status(error.status || 500).json({
      success: false,
      message: `Failed to add the note: ${error.message || error}`,
    });
  }
});

module.exports = router;
