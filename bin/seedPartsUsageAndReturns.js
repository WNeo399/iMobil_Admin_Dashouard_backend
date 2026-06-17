// One-off data alignment so historical sqt_cases match the return-tracking
// feature's assumptions:
//
//   • Completed cases  → assume every part sent was USED.
//       set lineItems[].quantityUsed = quantitySent, quantityReturned = 0
//
//   • Unrepairable / BER / Cancelled cases → assume every part sent must be
//     RETURNED (none used yet).
//       set lineItems[].quantityUsed = 0, quantityReturned = 0
//       then (re)build returnTracking so the case shows on the Returns
//       dashboard. For ber/unrepairable this also seeds the device return.
//
// Safe + idempotent — re-running converges to the same state, and rebuilding
// returnTracking preserves any HQ "received" progress that already exists.
//
// DRY RUN by default (no writes). Preview:   node bin/seedPartsUsageAndReturns.js
// Apply for real:                            node bin/seedPartsUsageAndReturns.js --apply

require("dotenv").config();
const {
  connectToDatabase,
  closeDatabaseConnection,
} = require("../utils/mongodb");
const {
  TERMINAL_RETURN_STATUSES,
  buildReturnTracking,
} = require("../utils/returnTracking");

const APPLY = process.argv.includes("--apply");

// Return a cloned zohoOrders array with usage rewritten per mode, plus how many
// line items actually changed value.
//   mode 'used'   → quantityUsed = quantitySent (completed cases)
//   mode 'return' → quantityUsed = 0             (terminal cases — all to return)
// quantityReturned is forced to 0 in both modes (nothing received back yet).
function rewriteUsage(zohoOrders, mode) {
  let changedItems = 0;
  let totalItems = 0;
  const cloned = (Array.isArray(zohoOrders) ? zohoOrders : []).map((o) => ({
    ...o,
    lineItems: (Array.isArray(o.lineItems) ? o.lineItems : []).map((li) => {
      totalItems += 1;
      const sent = Number(li.quantitySent) || 0;
      const nextUsed = mode === "used" ? sent : 0;
      const prevUsed = Number(li.quantityUsed) || 0;
      const prevReturned = Number(li.quantityReturned) || 0;
      if (prevUsed !== nextUsed || prevReturned !== 0) changedItems += 1;
      return { ...li, quantityUsed: nextUsed, quantityReturned: 0 };
    }),
  }));
  return { cloned, changedItems, totalItems };
}

(async () => {
  try {
    const db = await connectToDatabase();
    const col = db.collection("sqt_cases");
    const now = new Date();

    console.log(APPLY ? "\n=== APPLYING ===\n" : "\n=== DRY RUN (no writes) ===\n");

    // ── 1) Completed cases — all parts used, UNLESS usage already recorded ───
    // A completed case where someone already set a non-zero quantityUsed (via
    // markRepaired) is treated as authoritative and left untouched. Only cases
    // whose parts are still at the sendParts default (quantityUsed = 0) get the
    // "assume all used" treatment.
    const completed = await col.find({ status: "completed" }).toArray();
    let completedUpdated = 0;
    let completedItems = 0;
    const skipped = [];
    for (const c of completed) {
      const orders = Array.isArray(c.zohoOrders) ? c.zohoOrders : [];
      const lineItems = orders.flatMap((o) =>
        Array.isArray(o.lineItems) ? o.lineItems : [],
      );
      if (lineItems.length === 0) continue; // no parts → nothing to do
      completedItems += lineItems.length;

      const hasUsage = lineItems.some(
        (li) => (Number(li.quantityUsed) || 0) > 0,
      );
      if (hasUsage) {
        skipped.push({
          _id: c._id,
          caseId: c.caseId || null,
          serviceRequestId: c.serviceRequestId || null,
          lineItems: lineItems.map((li) => ({
            sku: li.sku || "",
            partName: li.partName || "",
            sent: Number(li.quantitySent) || 0,
            used: Number(li.quantityUsed) || 0,
            returned: Number(li.quantityReturned) || 0,
          })),
        });
        continue;
      }

      const { cloned } = rewriteUsage(c.zohoOrders, "used");
      completedUpdated += 1;
      if (APPLY) {
        await col.updateOne(
          { _id: c._id },
          { $set: { zohoOrders: cloned, updatedAt: now } },
        );
      }
    }
    console.log(
      `Completed cases: ${completed.length} scanned; ` +
        `${completedUpdated} ${APPLY ? "updated" : "would update"} (parts → all used); ` +
        `${skipped.length} skipped (usage already recorded); ` +
        `${completedItems} sent line item(s) seen`,
    );
    if (skipped.length) {
      console.log(
        "\n  Skipped completed cases (quantityUsed already set — left untouched):",
      );
      for (const s of skipped) {
        const label = s.caseId || s.serviceRequestId || String(s._id);
        const parts = s.lineItems
          .map((li) => `${li.sku || li.partName || "?"} used ${li.used}/${li.sent}`)
          .join(", ");
        console.log(`    • ${label}  (${s._id})  [${parts}]`);
      }
      console.log("");
    }

    // ── 2) Terminal cases — all parts to return + seed returnTracking ────────
    const terminal = await col
      .find({ status: { $in: TERMINAL_RETURN_STATUSES } })
      .toArray();
    const byReason = { unrepairable: 0, ber: 0, cancelled: 0 };
    let terminalItems = 0;
    let withDevice = 0;
    for (const c of terminal) {
      const { cloned, totalItems } = rewriteUsage(c.zohoOrders, "return");
      terminalItems += totalItems;
      byReason[c.status] = (byReason[c.status] || 0) + 1;
      // Build returnTracking off the zeroed orders so quantityToReturn =
      // quantitySent for every line.
      const rt = buildReturnTracking(
        { ...c, zohoOrders: cloned },
        c.status,
        now,
      );
      if (rt.device.applicable && rt.device.expected) withDevice += 1;
      if (APPLY) {
        await col.updateOne(
          { _id: c._id },
          { $set: { zohoOrders: cloned, returnTracking: rt, updatedAt: now } },
        );
      }
    }
    console.log(
      `Terminal cases:  ${terminal.length} scanned ${APPLY ? "updated" : "would update"} ` +
        `(unrepairable ${byReason.unrepairable}, ber ${byReason.ber}, cancelled ${byReason.cancelled})`,
    );
    console.log(
      `   ${terminalItems} sent line item(s) → all marked to-return; ${withDevice} case(s) also expect a device back`,
    );

    if (!APPLY) {
      console.log(
        "\nNothing written. Re-run with --apply to commit these changes.",
      );
    } else {
      console.log("\n✅ Done.");
    }
  } catch (e) {
    console.error("Seed parts usage/returns failed:", e);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    process.exit();
  }
})();
