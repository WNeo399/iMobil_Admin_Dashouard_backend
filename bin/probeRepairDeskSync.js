// Diagnostic probe for the RepairDesk status sync.
//
// Run with:    node bin/probeRepairDeskSync.js <caseId> [<newStatus>]
// Example:     node bin/probeRepairDeskSync.js 092767174131 repaired
//
// Walks every step the live `syncCaseStatus` performs and prints the result
// of each — so when the sync silently does nothing in production, we can see
// exactly which step rejected it.
//
// Steps:
//   1. API key configured?
//   2. Internal status mapped to a RepairDesk label?
//   3. /tickets?keyword=<caseId> — what's the response shape and count?
//   4. Can we extract an internal ticket id from the result?
//   5. /ticket/updateticketstatus — does the actual update succeed?
//
// Deletable — purely a debug helper.

require("dotenv").config();
const axios = require("axios");

const REPAIRDESK_API_BASE = "https://api.repairdesk.co/api/web/v1";

// Mirror what utils/repairDesk.js uses
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

(async () => {
    const caseId = process.argv[2];
    const newStatus = process.argv[3] || "pending";

    if (!caseId) {
        console.error("Usage: node bin/probeRepairDeskSync.js <caseId> [<newStatus>]");
        console.error("Example: node bin/probeRepairDeskSync.js 092767174131 repaired");
        process.exit(1);
    }

    console.log("─".repeat(70));
    console.log(`Probing RepairDesk sync for caseId="${caseId}" → status="${newStatus}"`);
    console.log("─".repeat(70));

    // ── Step 1: API key
    const apiKey = process.env.REPAIRDESK_API_KEY;
    console.log("\n[1] API key configured?");
    if (!apiKey) {
        console.log("    ✗ REPAIRDESK_API_KEY is NOT set in .env — sync would be skipped at the first guard.");
        process.exit(1);
    }
    console.log(`    ✓ found (length: ${apiKey.length}, last 4: ...${apiKey.slice(-4)})`);

    // ── Step 2: status mapping
    console.log("\n[2] Status mapped to a RepairDesk label?");
    const label = STATUS_TO_REPAIRDESK_LABEL[newStatus];
    if (!label) {
        console.log(`    ✗ "${newStatus}" is NOT in the sync map — sync would skip silently.`);
        console.log(`    Mapped statuses: ${Object.keys(STATUS_TO_REPAIRDESK_LABEL).join(", ")}`);
        process.exit(1);
    }
    console.log(`    ✓ "${newStatus}" → "${label}"`);

    // ── Step 3: search by keyword
    console.log(`\n[3] GET /tickets?keyword=${encodeURIComponent(caseId)}`);
    const searchUrl = `${REPAIRDESK_API_BASE}/tickets?api_key=${encodeURIComponent(apiKey)}&keyword=${encodeURIComponent(caseId)}`;
    let searchResp;
    try {
        searchResp = await axios.get(searchUrl, { timeout: 15000 });
    } catch (e) {
        console.log(`    ✗ HTTP request failed: ${e.message}`);
        if (e.response) {
            console.log(`      status: ${e.response.status}`);
            console.log(`      body:   ${JSON.stringify(e.response.data).slice(0, 500)}`);
        }
        process.exit(1);
    }
    console.log(`    ✓ HTTP ${searchResp.status}`);
    console.log(`    Top-level response keys: ${Object.keys(searchResp.data || {}).join(", ")}`);

    // Try every shape we know
    const body = searchResp.data || {};
    const candidateLists = {
        "data.ticketData": body.data && Array.isArray(body.data.ticketData) ? body.data.ticketData : null,
        "data (array)": Array.isArray(body.data) ? body.data : null,
        "ticketData": Array.isArray(body.ticketData) ? body.ticketData : null,
    };
    console.log("    Candidate result-list shapes:");
    for (const [shape, list] of Object.entries(candidateLists)) {
        console.log(`      ${shape.padEnd(20)} → ${list ? `${list.length} item(s)` : "not present"}`);
    }

    const list =
        candidateLists["data.ticketData"] ||
        candidateLists["data (array)"] ||
        candidateLists["ticketData"] ||
        [];

    if (list.length === 0) {
        console.log("    ✗ No tickets matched this caseId — sync would skip with 'no matching RepairDesk ticket'.");
        console.log("    Full response (first 1500 chars):");
        console.log("   ", JSON.stringify(body).slice(0, 1500));
        process.exit(1);
    }

    if (list.length > 1) {
        console.log(`    ⚠ ${list.length} tickets matched — sync would skip to avoid updating the wrong one.`);
        console.log("    First 2 ticket previews:");
        list.slice(0, 2).forEach((t, i) => {
            console.log(`      [${i}]`, JSON.stringify(t).slice(0, 300));
        });
        process.exit(1);
    }

    const ticket = list[0];
    console.log("    ✓ exactly 1 match");
    console.log("    Ticket payload (first 600 chars):");
    console.log("   ", JSON.stringify(ticket).slice(0, 600));

    // ── Step 4: extract BOTH ids
    // /ticket/updateticketstatus needs:
    //   id          = the ticket id            (summary.id or top-level id)
    //   ticketInvId = the per-device handle    (devices[0].id)
    console.log("\n[4] Extract { id, ticketInvId }");
    const idCandidates = {
        "summary.id": ticket.summary && ticket.summary.id,
        "id": ticket.id,
        "ticket_id": ticket.ticket_id,
    };
    console.log("    Ticket id candidates:");
    for (const [field, val] of Object.entries(idCandidates)) {
        console.log(`      ${field.padEnd(15)} → ${val == null ? "<missing>" : val}`);
    }
    const id = idCandidates["summary.id"] || idCandidates["id"] || idCandidates["ticket_id"];

    const devices = Array.isArray(ticket.devices) ? ticket.devices : [];
    console.log(`    Devices on this ticket: ${devices.length}`);
    devices.forEach((d, i) => {
        console.log(`      [${i}] id=${d && d.id}  imei=${d && d.imei}  model=${d && (d.device || d.model)}`);
    });
    const ticketInvId = devices[0] && devices[0].id;

    if (!id || !ticketInvId) {
        console.log(`    ✗ Missing id (${id}) or ticketInvId (${ticketInvId}) — sync would skip.`);
        process.exit(1);
    }
    console.log(`    ✓ using id="${id}", ticketInvId="${ticketInvId}"`);

    // ── Step 5: actually update
    console.log(`\n[5] POST /ticket/updateticketstatus  (id=${id}, ticketInvId=${ticketInvId}, status="${label}")`);
    const updateUrl = `${REPAIRDESK_API_BASE}/ticket/updateticketstatus?api_key=${encodeURIComponent(apiKey)}`;
    const params = new URLSearchParams();
    params.append("id", String(id));
    params.append("ticketInvId", String(ticketInvId));
    params.append("status", String(label));

    try {
        const updateResp = await axios.post(updateUrl, params, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 15000,
        });
        console.log(`    ✓ HTTP ${updateResp.status}`);
        console.log("    Response body:");
        console.log("   ", JSON.stringify(updateResp.data, null, 2).slice(0, 1500));
        console.log("\n✅ End-to-end sync probe succeeded.");
    } catch (e) {
        console.log(`    ✗ Update failed: ${e.message}`);
        if (e.response) {
            console.log(`      status: ${e.response.status}`);
            console.log(`      body:   ${JSON.stringify(e.response.data).slice(0, 1500)}`);
        }
        process.exit(1);
    }
})();
