// Thin wrapper around the RepairDesk REST API.
// API key is read from REPAIRDESK_API_KEY in the environment.

const axios = require("axios");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";

// POST /ticket/updateticketstatus
// See: https://api-docs.repairdesk.co/#/Tickets/post_ticket_updateticketstatus
// The endpoint expects form-encoded `id` (ticket id) and `status` fields.
async function updateTicketStatus(ticketId, status) {
  const apiKey = process.env.REPAIRDESK_API_KEY;
  if (!apiKey) {
    throw new Error("REPAIRDESK_API_KEY is not configured");
  }
  if (!ticketId) {
    throw new Error("ticketId is required");
  }

  const url = `${REPAIRDESK_API_BASE}/ticket/updateticketstatus?api_key=${encodeURIComponent(apiKey)}`;

  const params = new URLSearchParams();
  params.append("id", String(ticketId));
  params.append("status", String(status));

  const response = await axios.post(url, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
  return response.data;
}

module.exports = { updateTicketStatus };
