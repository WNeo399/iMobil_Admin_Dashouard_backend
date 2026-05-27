// Thin wrapper around the RepairDesk REST API.
// API key is read from REPAIRDESK_API_KEY in the environment.
//
// TEMPORARY: the `syncCaseStatus` helper and the ticket-search-by-caseId
// fallback only exist while we're still mirroring case status into RepairDesk.
// When we retire RepairDesk, delete this file along with the callers in
// routes/sqtRoutes/cases.js and routes/_tempUpdateStatusByTicket.js.

const axios = require("axios");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";

// Internal SQT status → RepairDesk status label. Statuses absent from this map
// (e.g. "repairing", "waiting-solvup") deliberately don't sync because
// RepairDesk has no matching label.
const STATUS_TO_REPAIRDESK_LABEL = {
  pending: "Pending",
  "waiting-for-parts": "Waiting For Parts",
  "parts-arrived": "Parts arrived",
  "waiting-for-drop-off": "Waiting For Drop Off",
  repaired: "Repaired",
  "repaired-and-collected": "Repaired & Collected",
  unrepairable: "Unrepairable & Returned",
  completed: "Completed",
  ber: "BER",
  cancelled: "Cancelled",
};

// POST /ticket/updateticketstatus
// Body (form-encoded):
//   id           — the RepairDesk ticket id (summary.id from /tickets)
//   ticketInvId  — the per-device id from devices[0].id; a ticket can hold
//                  several devices and each carries its own status, so the
//                  API needs both ids to know which row to update.
//   status       — the RepairDesk status label (e.g. "Repaired")
async function updateTicketStatus({ id, ticketInvId, status }) {
  const apiKey = process.env.REPAIRDESK_API_KEY;
  if (!apiKey) throw new Error("REPAIRDESK_API_KEY is not configured");
  if (!id) throw new Error("id is required");
  if (!ticketInvId) throw new Error("ticketInvId is required");
  if (!status) throw new Error("status is required");

  const url = `${REPAIRDESK_API_BASE}/ticket/updateticketstatus?api_key=${encodeURIComponent(apiKey)}`;

  const params = new URLSearchParams();
  params.append("id", String(id));
  params.append("ticketInvId", String(ticketInvId));
  params.append("status", String(status));

  const response = await axios.post(url, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
  return response.data;
}

// GET /tickets?api_key=&keyword=<caseId>
// Returns { id, ticketInvId } when exactly one ticket matches, else null.
// `id` is the RepairDesk ticket id; `ticketInvId` is devices[0].id (see the
// comment on updateTicketStatus for why we need both).
async function findTicketByCaseId(caseId) {
  const apiKey = process.env.REPAIRDESK_API_KEY;
  if (!apiKey || !caseId) return null;

  const url = `${REPAIRDESK_API_BASE}/tickets?api_key=${encodeURIComponent(apiKey)}&keyword=${encodeURIComponent(String(caseId))}`;
  let response;
  try {
    response = await axios.get(url, { timeout: 15000 });
  } catch (e) {
    console.warn(
      `[RepairDesk] /tickets search failed for caseId=${caseId}:`,
      e.message || e,
    );
    return null;
  }

  // RepairDesk responses are nested. Defensive about the wrapping:
  //   { data: { ticketData: [{ summary: { id }, devices: [{ id }] }] } }
  //   { data: [...] }       // some endpoints
  //   { ticketData: [...] } // unwrapped variant
  const body = response.data || {};
  const list =
    (body.data && Array.isArray(body.data.ticketData) && body.data.ticketData) ||
    (Array.isArray(body.data) && body.data) ||
    (Array.isArray(body.ticketData) && body.ticketData) ||
    [];

  if (list.length === 0) return null;
  if (list.length > 1) {
    // Skip rather than guess — log so we can investigate.
    console.warn(
      `[RepairDesk] /tickets keyword="${caseId}" returned ${list.length} matches — skipping sync to avoid updating the wrong ticket.`,
    );
    return null;
  }

  const ticket = list[0];
  const id =
    (ticket.summary && ticket.summary.id) ||
    ticket.id ||
    ticket.ticket_id ||
    null;
  const ticketInvId =
    (Array.isArray(ticket.devices) && ticket.devices[0] && ticket.devices[0].id) ||
    null;

  if (!id || !ticketInvId) {
    console.warn(
      `[RepairDesk] /tickets keyword="${caseId}" returned a ticket missing id (${id}) or devices[0].id (${ticketInvId}) — payload:`,
      JSON.stringify(ticket).slice(0, 400),
    );
    return null;
  }
  return { id: String(id), ticketInvId: String(ticketInvId) };
}

// Mirror a case's new status into RepairDesk. Never throws — RepairDesk
// downtime / lookup failures should not break the dashboard flow.
// Returns { synced: boolean, reason?: string } for callers that want to log.
async function syncCaseStatus(caseDoc, newStatus) {
  if (!caseDoc) return { synced: false, reason: "no case" };
  const label = STATUS_TO_REPAIRDESK_LABEL[newStatus];
  if (!label) {
    return { synced: false, reason: `status "${newStatus}" not in sync list` };
  }
  // We always search by caseId — even cases that have a cached
  // repairDeskTicketId don't have the per-device id we now need.
  const ticket = await findTicketByCaseId(caseDoc.caseId);
  if (!ticket) {
    return { synced: false, reason: "no matching RepairDesk ticket" };
  }
  try {
    await updateTicketStatus({
      id: ticket.id,
      ticketInvId: ticket.ticketInvId,
      status: label,
    });
    return { synced: true };
  } catch (e) {
    const msg = (e.response && e.response.data) || e.message || String(e);
    console.warn(
      `[RepairDesk] updateTicketStatus failed for id=${ticket.id} ticketInvId=${ticket.ticketInvId} (caseId=${caseDoc.caseId}):`,
      msg,
    );
    return { synced: false, reason: "RepairDesk API error" };
  }
}

module.exports = {
  updateTicketStatus,
  findTicketByCaseId,
  syncCaseStatus,
  STATUS_TO_REPAIRDESK_LABEL,
};
