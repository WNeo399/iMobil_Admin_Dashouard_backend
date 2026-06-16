// TEMPORARY UNAUTHENTICATED ENDPOINT — remove when the external integration is
// decommissioned. Do not extend or rely on this for permanent functionality.
// To remove: delete this file and the `tempIntegrationRouter` mount in app.js.
//
// POST /integration/case-status/:caseId
// Body: { updateStatus, updateBy }
// Looks up the case by `caseId` (path param), sets `status`, and appends a
// `statusHistory` entry attributed to `updateBy`. `caseId` may also be sent
// in the body as a fallback for callers that can't put it in the path.

const express = require("express");
const { connectToDatabase } = require("../utils/mongodb");

const router = express.Router();

// Kept in sync with VALID_STATUSES in routes/sqtRoutes/cases.js and the
// STATUS_META labels in views/sqt/cases/index.vue. The external caller passes
// the human-readable label; we map it back to the internal status value.
// Matching is case-insensitive and whitespace-tolerant.
const STATUS_LABEL_TO_VALUE = {
  "on hold": "on-hold",
  "pending": "pending",
  "waiting for parts": "waiting-for-parts",
  "parts arrived": "parts-arrived",
  "waiting for drop off": "waiting-for-drop-off",
  "repairing": "repairing",
  "repaired": "repaired",
  "repaired & collected": "repaired-and-collected",
  "waiting solvup": "waiting-solvup",
  "unrepairable": "unrepairable",
  // RepairDesk's "Unrepairable & Hold" has no dashboard equivalent —
  // there's no unrepairable-hold state, so it folds into "unrepairable".
  "unrepairable & hold": "unrepairable",
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

router.post("/integration/case-status/:caseId", async function (req, res) {
  try {
    const body = req.body || {};
    // caseId comes from the path param; fall back to the body so a
    // caller that can't templatise the URL still works.
    const caseId = (req.params.caseId || body.caseId)
      ? String(req.params.caseId || body.caseId).trim()
      : "";
    const updateStatus = body.updateStatus ? String(body.updateStatus).trim() : "";
    const updateBy = body.updateBy ? String(body.updateBy).trim() : "";

    if (!caseId) {
      return res
        .status(400)
        .json({ success: false, message: "caseId is required" });
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
    const existing = await collection.findOne({ caseId });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: `No case found with caseId "${caseId}"`,
      });
    }
    if (existing.status === resolvedStatus) {
      return res.json({
        success: true,
        message: `Case ${caseId} already at ${resolvedStatus} — no change`,
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
      { caseId },
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
        message: `No case found with caseId "${caseId}"`,
      });
    }

    return res.json({
      success: true,
      message: `Case ${caseId} moved to ${resolvedStatus}`,
      data: updated,
    });
  } catch (error) {
    console.error("Integration update status error:", error);
    return res.status(500).json({ success: false, message: "Failed to update status" });
  }
});

module.exports = router;
