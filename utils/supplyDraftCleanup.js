// A deleted device leaves the Pending supply drafts that list it (user
// 2026-11-23). A draft still naming a deleted device can neither be saved nor
// confirmed — supplyBatches.js resolveDevices answers "A selected device no
// longer exists" (SPL-10060: 35 devices deleted and re-entered, the draft kept
// the dead ids). Confirmed / cancelled batches are history and stay as they are.
const { ObjectId } = require("mongodb");

const SUPPLY = "refurb_supply_batches";
const STATUS_PENDING = "Pending";

// devices: the deleted device docs (at least _id; imei / model are kept on the
// audit entry). Returns the batch numbers the devices were taken off.
async function removeFromPendingSupplyDrafts(db, devices, who) {
  const list = (devices || []).filter((d) => d && d._id);
  if (!list.length) return [];
  // lines carry the ObjectId; a string copy is matched too, to be safe
  const ids = list.flatMap((d) => [new ObjectId(String(d._id)), String(d._id)]);
  const drafts = await db.collection(SUPPLY)
    .find({ status: STATUS_PENDING, "lines.deviceId": { $in: ids } }, { projection: { batchNo: 1, lines: 1 } })
    .toArray();
  const now = new Date();
  const touched = [];
  for (const b of drafts) {
    const gone = new Set(list.map((d) => String(d._id)));
    const removed = (b.lines || []).filter((l) => gone.has(String(l.deviceId)));
    if (!removed.length) continue;
    await db.collection(SUPPLY).updateOne(
      { _id: b._id, status: STATUS_PENDING },
      {
        $pull: { lines: { deviceId: { $in: ids } } },
        $push: {
          removedLines: {
            $each: removed.map((l) => ({
              at: now, by: who || "", reason: "device deleted",
              deviceId: l.deviceId, imei: l.imei || "", model: l.model || "", storage: l.storage || "",
            })),
          },
        },
        $set: { updatedAt: now, updatedBy: who || "" },
      },
    );
    touched.push(b.batchNo);
  }
  return touched;
}

module.exports = { removeFromPendingSupplyDrafts };
