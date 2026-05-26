// One-time data migration: convert string `createdAt`/`updatedAt` in `sqt_cases`
// to real BSON Date values, so date-range queries (`$gte: Date`) match.
//
// Safe to re-run — only documents whose field is still a string are touched.
//
// Run with:   node bin/migrateCreatedAtToDate.js
//
// What it does:
//   1. Counts string-typed createdAt / updatedAt
//   2. Updates each in-place to a Date (via an aggregation pipeline update)
//   3. Reports before/after counts
//
// Why now: historical sqt_cases were imported from an external source with
// ISO-string timestamps. The dashboard's date-window queries silently miss
// these documents because Mongo's $gte:Date doesn't match strings.

require("dotenv").config();
const { connectToDatabase, closeDatabaseConnection } = require("../utils/mongodb");

async function migrateField(col, field) {
    const before = await col.countDocuments({ [field]: { $type: "string" } });
    if (before === 0) {
        console.log(`  ${field}: no string-typed values — skipping`);
        return { before: 0, after: 0 };
    }

    // Aggregation-pipeline update: only rewrites docs where $type is "string".
    const res = await col.updateMany(
        { [field]: { $type: "string" } },
        [{ $set: { [field]: { $toDate: `$${field}` } } }]
    );

    const after = await col.countDocuments({ [field]: { $type: "string" } });
    console.log(`  ${field}: converted ${res.modifiedCount} / ${before}; remaining strings: ${after}`);
    return { before, after };
}

(async () => {
    try {
        const db = await connectToDatabase();
        const col = db.collection("sqt_cases");

        console.log("Before:");
        const total = await col.countDocuments({});
        const totalDateCa = await col.countDocuments({ createdAt: { $type: "date" } });
        const totalStrCa = await col.countDocuments({ createdAt: { $type: "string" } });
        console.log(`  total docs: ${total}`);
        console.log(`  createdAt is Date:   ${totalDateCa}`);
        console.log(`  createdAt is String: ${totalStrCa}`);

        console.log("\nMigrating sqt_cases:");
        await migrateField(col, "createdAt");
        await migrateField(col, "updatedAt");

        console.log("\nAfter:");
        const finalDateCa = await col.countDocuments({ createdAt: { $type: "date" } });
        const finalStrCa = await col.countDocuments({ createdAt: { $type: "string" } });
        console.log(`  createdAt is Date:   ${finalDateCa}`);
        console.log(`  createdAt is String: ${finalStrCa}`);

        if (finalStrCa === 0) {
            console.log("\n✅ All createdAt values are now BSON Dates.");
        } else {
            console.log("\n⚠️  Some createdAt values remain as strings — inspect them manually.");
        }
    } catch (e) {
        console.error("Migration failed:", e);
        process.exitCode = 1;
    } finally {
        await closeDatabaseConnection();
        process.exit();
    }
})();
