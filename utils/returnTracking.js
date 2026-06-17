// Return-tracking domain logic for terminal SQT cases.
//
// When a case enters a terminal status (unrepairable / ber / cancelled), any
// parts sitting at the shop — and, for ber/unrepairable, the customer's
// device — need to come back to HQ. The case carries a `returnTracking`
// sub-document describing what's owed and what's been received:
//
//   {
//     active,            // true while the case is terminal; false once reopened
//     reason,            // which terminal status triggered it
//     initializedAt,
//     parts: [{
//       zohoSalesOrderId, zohoSalesOrderNumber, lineItemIdx,
//       partName, sku,
//       quantityToReturn, quantityReceived, received,
//       receivedAt, receivedBy, note
//     }],
//     device: {          // only meaningful for ber/unrepairable
//       applicable, expected, received, receivedAt, receivedBy, note
//     },
//     summaryStatus,     // 'none' | 'pending' | 'complete' (persisted for queries)
//     updatedAt
//   }
//
// HQ marks each part / the device received — there's no in-transit state
// (one-step model). These helpers are shared between the /sqt/cases routes and
// the backfill script so the seeding rules can't drift.

// Terminal statuses that require items to be returned to HQ.
const TERMINAL_RETURN_STATUSES = ["unrepairable", "ber", "cancelled"];
// Subset where the customer's physical device should also be returned "if
// possible". Cancelled is excluded — the device was never committed to a
// repair, so it stays with the customer.
const DEVICE_RETURN_STATUSES = ["unrepairable", "ber"];

// Stable key for a return part: the order it came from + its line-item index.
function returnPartKey(p) {
  return `${(p && p.zohoSalesOrderId) || ""}#${p && p.lineItemIdx}`;
}

// Outstanding (still-to-return) line items across all of a case's zohoOrders.
// Outstanding = quantitySent − quantityUsed − quantityReturned, where > 0.
function outstandingReturnParts(zohoOrders) {
  const parts = [];
  const orders = Array.isArray(zohoOrders) ? zohoOrders : [];
  orders.forEach((o) => {
    const lis = Array.isArray(o && o.lineItems) ? o.lineItems : [];
    lis.forEach((li, idx) => {
      const sent = Number(li && li.quantitySent) || 0;
      const used = Number(li && li.quantityUsed) || 0;
      const alreadyReturned = Number(li && li.quantityReturned) || 0;
      const toReturn = sent - used - alreadyReturned;
      if (toReturn > 0) {
        parts.push({
          zohoSalesOrderId: (o && o.zohoSalesOrderId) || null,
          zohoSalesOrderNumber: (o && o.zohoSalesOrderNumber) || null,
          lineItemIdx: idx,
          partName: (li && li.partName) || "",
          sku: (li && li.sku) || "",
          quantityToReturn: toReturn,
          quantityReceived: 0,
          received: false,
          receivedAt: null,
          receivedBy: null,
          note: null,
        });
      }
    });
  });
  return parts;
}

// Keep every already-tracked part (so HQ's received progress survives a
// re-init / reconcile) and append any newly-outstanding ones not seen before.
function mergeReturnParts(seeded, existing) {
  const exist = Array.isArray(existing) ? existing : [];
  const seenKeys = new Set(exist.map(returnPartKey));
  const result = exist.map((p) => ({ ...p }));
  for (const s of seeded) {
    if (!seenKeys.has(returnPartKey(s))) result.push({ ...s });
  }
  return result;
}

// Rollup persisted on the doc so the dashboard can filter cheaply:
//   'none'     nothing was ever required (no parts, device n/a or not expected)
//   'pending'  something is still outstanding
//   'complete' everything that was expected has been received
function computeReturnSummary(rt) {
  const parts = Array.isArray(rt && rt.parts) ? rt.parts : [];
  const device = (rt && rt.device) || {};
  const deviceRequired = !!(device.applicable && device.expected);
  const anyRequired = parts.length > 0 || deviceRequired;
  if (!anyRequired) return "none";
  const partsOutstanding = parts.some((p) => !p.received);
  const deviceOutstanding = deviceRequired && !device.received;
  return partsOutstanding || deviceOutstanding ? "pending" : "complete";
}

// Build (or reconcile) the returnTracking sub-document for a case that is
// entering / sitting in a terminal status. Idempotent: re-running it never
// clobbers received progress, it only adds newly-outstanding parts and keeps
// reason / device.applicable in sync with the current status.
// opts.deviceExpected (boolean) lets the caller set whether the customer's
// device is expected back — e.g. the shop's answer in the Mark Unrepairable
// dialog ("do you have the device on hand for return?"). It wins over the
// prior value and the default.
function buildReturnTracking(theCase, status, now, opts = {}) {
  const deviceApplicable = DEVICE_RETURN_STATUSES.includes(status);
  const existing = theCase && theCase.returnTracking;
  const seeded = outstandingReturnParts(theCase && theCase.zohoOrders);

  // Carry forward prior parts (with their received state) when one exists,
  // otherwise start from the freshly-seeded outstanding list.
  const parts = existing ? mergeReturnParts(seeded, existing.parts) : seeded;

  // Device: default to "expected back" for ber/unrepairable, unless the caller
  // explicitly says otherwise; preserve a prior expected/received decision when
  // reconciling. Force not-applicable/expected off for cancelled.
  const overrideExpected =
    typeof opts.deviceExpected === "boolean" ? opts.deviceExpected : undefined;
  const priorDevice = (existing && existing.device) || {};
  const resolvedExpected = deviceApplicable
    ? overrideExpected !== undefined
      ? overrideExpected
      : priorDevice.expected !== undefined
        ? !!priorDevice.expected
        : true
    : false;
  // A device that isn't expected back can't be (or stay) received.
  const keepReceived = deviceApplicable && resolvedExpected;
  const device = {
    applicable: deviceApplicable,
    expected: resolvedExpected,
    received: keepReceived ? !!priorDevice.received : false,
    receivedAt: keepReceived ? priorDevice.receivedAt || null : null,
    receivedBy: keepReceived ? priorDevice.receivedBy || null : null,
    note: priorDevice.note || null,
  };

  const rt = {
    active: true,
    reason: status,
    initializedAt: (existing && existing.initializedAt) || now,
    parts,
    device,
    summaryStatus: "none",
    updatedAt: now,
  };
  rt.summaryStatus = computeReturnSummary(rt);
  return rt;
}

module.exports = {
  TERMINAL_RETURN_STATUSES,
  DEVICE_RETURN_STATUSES,
  returnPartKey,
  outstandingReturnParts,
  mergeReturnParts,
  computeReturnSummary,
  buildReturnTracking,
};
