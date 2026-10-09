// Device transfer records (2026-10-09): every bulk shelf move off the Stock
// page — above all "Assigned To Exyon" — leaves a numbered record with a
// snapshot of the devices as moved, so the batch can be printed or
// downloaded later (Refurbished Device → Warehouse → Transfers).
const TRANSFERS = "refurb_transfers";
const COUNTERS = "refurb_counters";

// what a line keeps of the device at the time of the move
const SNAPSHOT = { imei: 1, serialNumber: 1, brand: 1, model: 1, storage: 1, color: 1, grade: 1, stockSource: 1, costPrice: 1, currency: 1, supplyBatchNo: 1 };

// TR-10001, TR-10002, …
async function nextTransferNo(db) {
  const r = await db.collection(COUNTERS).findOneAndUpdate(
    { _id: "transfer" },
    { $inc: { seq: 1 }, $setOnInsert: { base: 10000 } },
    { upsert: true, returnDocument: "after" },
  );
  const doc = (r && (r.value || r)) || {};
  const seq = (doc.base || 10000) + (doc.seq || 1);
  return { seq, transferNo: `TR-${seq}` };
}

// `devices`: the moved devices' docs (SNAPSHOT projection); `from`: Map of
// device id → the shelf it came from; `who`: the account's username.
async function recordTransfer(db, { to, devices, from, who, note }) {
  if (!Array.isArray(devices) || !devices.length) return null;
  const { seq, transferNo } = await nextTransferNo(db);
  const lines = devices.map((d) => ({
    deviceId: d._id,
    imei: d.imei || "", serialNumber: d.serialNumber || "",
    brand: d.brand || "", model: d.model || "", storage: d.storage || "", color: d.color || "", grade: d.grade || "",
    stockSource: d.stockSource || "", supplyBatchNo: d.supplyBatchNo || "",
    from: (from && from.get(String(d._id))) || "",
    costPrice: d.costPrice == null ? null : d.costPrice, currency: d.currency || "",
  }));
  const doc = {
    transferNo, seq, to: String(to || ""), count: lines.length, lines,
    note: String(note || "").trim().slice(0, 500),
    createdAt: new Date(), createdBy: who || null,
  };
  const r = await db.collection(TRANSFERS).insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

module.exports = { TRANSFERS, SNAPSHOT, recordTransfer };
