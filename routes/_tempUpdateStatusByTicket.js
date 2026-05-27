// TEMPORARY UNAUTHENTICATED ENDPOINT — remove when the external integration is
// decommissioned. Do not extend or rely on this for permanent functionality.
// To remove: delete this file and the `tempIntegrationRouter` mount in app.js.
//
// POST /integration/case-status
// Body: { repairDeskTicketNumber, updateStatus, updateBy }
// Looks up the case by repairDeskTicketNumber, sets `status`, and appends a
// `statusHistory` entry attributed to `updateBy`.

const express = require("express");
const { connectToDatabase } = require("../utils/mongodb");

const router = express.Router();

// Kept in sync with VALID_STATUSES in routes/sqtRoutes/cases.js and the
// STATUS_META labels in views/sqt/cases/index.vue. The external caller passes
// the human-readable label; we map it back to the internal status value.
// Matching is case-insensitive and whitespace-tolerant.
const STATUS_LABEL_TO_VALUE = {
  "pending": "pending",
  "waiting for parts": "waiting-for-parts",
  "parts arrived": "parts-arrived",
  "waiting for drop-off": "waiting-for-drop-off",
  "repairing": "repairing",
  "repaired": "repaired",
  "repaired & collected": "repaired-and-collected",
  "waiting solvup": "waiting-solvup",
  "unrepairable": "unrepairable",
  "ber": "ber",
  "completed": "completed",
  "cancelled": "cancelled",
};

function normalizeLabel(s) {
  // collapse whitespace, lower-case so "Waiting  Solvup" / "waiting solvup" all match
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resolveStatusFromLabel(label) {
  return STATUS_LABEL_TO_VALUE[normalizeLabel(label)] || null;
}

const COLLECTION = "sqt_cases";

router.post("/integration/case-status", async function (req, res) {
  try {
    const body = req.body || {};
    const repairDeskTicketNumber = body.repairDeskTicketNumber
      ? String(body.repairDeskTicketNumber).trim()
      : "";
    const updateStatus = body.updateStatus ? String(body.updateStatus).trim() : "";
    const updateBy = body.updateBy ? String(body.updateBy).trim() : "";

    if (!repairDeskTicketNumber) {
      return res
        .status(400)
        .json({ success: false, message: "repairDeskTicketNumber is required" });
    }
    if (!updateStatus) {
      return res.status(400).json({ success: false, message: "updateStatus is required" });
    }
    const resolvedStatus = resolveStatusFromLabel(updateStatus);
    if (!resolvedStatus) {
      return res.status(400).json({
        success: false,
        message: `Unknown updateStatus "${updateStatus}". Allowed labels: ${Object.keys(
          STATUS_LABEL_TO_VALUE,
        )
          .map((k) => `"${k}"`)
          .join(", ")}`,
      });
    }
    if (!updateBy) {
      return res.status(400).json({ success: false, message: "updateBy is required" });
    }

    const db = await connectToDatabase();
    const collection = db.collection(COLLECTION);

    // Look up first so we can no-op when the inbound status matches what's
    // already saved. This closes the dashboard→RepairDesk→webhook loop:
    // when the dashboard pushes a status into RepairDesk, RepairDesk fires
    // this webhook back; without the guard we'd push the same status into
    // Mongo again (creating a duplicate statusHistory entry) and the
    // history would grow on every edit.
    const existing = await collection.findOne({ repairDeskTicketNumber });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: `No case found with repairDeskTicketNumber "${repairDeskTicketNumber}"`,
      });
    }
    if (existing.status === resolvedStatus) {
      return res.json({
        success: true,
        message: `Case ${repairDeskTicketNumber} already at ${resolvedStatus} — no change`,
        data: existing,
      });
    }

    const now = new Date();
    const historyEntry = {
      status: resolvedStatus,
      at: now,
      updatedBy: updateBy,
      note: null,
    };

    const result = await collection.findOneAndUpdate(
      { repairDeskTicketNumber },
      {
        $set: { status: resolvedStatus, updatedAt: now },
        $push: { statusHistory: historyEntry },
      },
      { returnDocument: "after" },
    );

    const updated = result ? (result.value || result) : null;
    if (!updated) {
      // The doc disappeared between the read and the update — vanishingly
      // unlikely but handle it cleanly anyway.
      return res.status(404).json({
        success: false,
        message: `No case found with repairDeskTicketNumber "${repairDeskTicketNumber}"`,
      });
    }

    return res.json({
      success: true,
      message: `Case ${repairDeskTicketNumber} moved to ${resolvedStatus}`,
      data: updated,
    });
  } catch (error) {
    console.error("Integration update status error:", error);
    return res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

module.exports = router;
