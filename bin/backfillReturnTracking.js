// One-time backfill: initialise `returnTracking` on sqt_cases that are already
// in a terminal status (unrepairable / ber / cancelled) but predate the return-
// tracking feature, so they show up on the Returns dashboard.
//
// Safe to re-run — only documents that don't yet have a `returnTracking` field
// are touched. Cases that already have one (created by the /status route, or by
// a previous run of this script) are left alone so HQ's received progress is
// never clobbered.
//
// Run with:   node bin/backfillReturnTracking.js
//
// What it does:
//   1. Finds terminal-status cases with no returnTracking
//   2. Builds the tracker from each case's zohoOrders (outstanding parts) +
//      device applicability, via the shared utils/returnTracking helper
//   3. $set it on the doc and report counts

require("dotenv").config();
const {
  connectToDatabase,
  closeDatabaseConnection,
} = require("../utils/mongodb");
const {
  TERMINAL_RETURN_STATUSES,
  buildReturnTracking,
} = require("../utils/returnTracking");

(async () => {
  try {
    const db = await connectToDatabase();
    const col = db.collection("sqt_cases");

    const filter = {
      status: { $in: TERMINAL_RETURN_STATUSES },
      returnTracking: { $exists: false },
    };

    const total = await col.countDocuments({
      status: { $in: TERMINAL_RETURN_STATUSES },
    });
    const todo = await col.countDocuments(filter);
    console.log(
      `Terminal-status cases: ${total}; missing returnTracking: ${todo}`,
    );
    if (todo === 0) {
      console.log("Nothing to backfill — all terminal cases already tracked.");
      return;
    }

    const cursor = col.find(filter);
    let updated = 0;
    let withParts = 0;
    let withDevice = 0;
    const now = new Date();

    while (await cursor.hasNext()) {
      const theCase = await cursor.next();
      const rt = buildReturnTracking(theCase, theCase.status, now);
      await col.updateOne(
        { _id: theCase._id },
        { $set: { returnTracking: rt, updatedAt: now } },
      );
      updated += 1;
      if (rt.parts.length > 0) withParts += 1;
      if (rt.device.applicable && rt.device.expected) withDevice += 1;
    }

    console.log(`\n✅ Backfilled ${updated} case(s).`);
    console.log(`   with parts to return:  ${withParts}`);
    console.log(`   with device to return: ${withDevice}`);
  } catch (e) {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    process.exit();
  }
})();
