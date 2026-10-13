// One-off for the SQT Call Center (user 2026-10-13): every case that is
// past "pending" when the call center starts is an OLD case — no process
// call required. Marks them callCenter.noCall so the Call Center queue
// holds only the pending ones and whatever comes in from now on. Cases that
// already carry a call-center flag are left alone, so this is safe to
// re-run. Dry run by default.
//
//   node bin/callCenterOldCases.js [--apply]
//
// Writes a backup of the touched ids to the OS temp folder first.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const { connectToDatabase } = require("../utils/mongodb");

const APPLY = process.argv.includes("--apply");
const COLLECTION = "sqt_cases";

(async () => {
  const db = await connectToDatabase();
  const col = db.collection(COLLECTION);
  const match = { status: { $ne: "pending" }, callCenter: { $exists: false } };
  const rows = await col.find(match, { projection: { _id: 1, caseId: 1, status: 1, createdAt: 1 } }).toArray();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`${rows.length} cases past pending without a call-center flag:`, JSON.stringify(byStatus));
  console.log("pending (stay on the call list):", await col.countDocuments({ status: "pending", callCenter: { $exists: false } }));
  if (!APPLY) { console.log("\ndry run — add --apply to mark them"); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(os.tmpdir(), `callCenterOldCases.${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows.map((r) => ({ _id: String(r._id), caseId: r.caseId, status: r.status })), null, 1));
  console.log("backup of the touched ids:", backup);

  const now = new Date();
  const r = await col.updateMany(match, {
    $set: {
      callCenter: {
        contacted: false,
        noCall: true,
        note: "Old case — opened before the call center started",
        at: now,
        by: "system",
        attempts: [],
      },
    },
  });
  console.log(`marked ${r.modifiedCount} cases as old (no call needed)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
