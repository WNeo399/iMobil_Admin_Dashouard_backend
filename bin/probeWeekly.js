// One-off diagnostic for the "Cases this week" KPI.
//
// Run with:   node bin/probeWeekly.js
//
// Prints:
//   - total documents in sqt_cases
//   - the BSON type of `createdAt` on a sample of 3 most-recent docs
//   - what the dashboard's $gte-by-Date match returns
//   - what an equivalent $gte-by-ISO-string match returns
//
// Deletable — purely a debug helper.

require("dotenv").config();
const { connectToDatabase, closeDatabaseConnection } = require("../utils/mongodb");

(async () => {
    try {
        const db = await connectToDatabase();
        const col = db.collection("sqt_cases");

        const total = await col.countDocuments({});
        console.log(`Total sqt_cases documents: ${total}`);

        const sample = await col
            .find({}, { projection: { createdAt: 1, status: 1, serviceRequestId: 1 } })
            .sort({ createdAt: -1 })
            .limit(3)
            .toArray();
        console.log("\nMost-recent 3 docs (createdAt + JS typeof):");
        for (const d of sample) {
            console.log({
                _id: String(d._id),
                serviceRequestId: d.serviceRequestId,
                status: d.status,
                createdAt: d.createdAt,
                jsType: typeof d.createdAt,
                isDate: d.createdAt instanceof Date
            });
        }

        const sevenDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
        sevenDaysAgo.setHours(0, 0, 0, 0);
        console.log(`\nWindow start (Date object): ${sevenDaysAgo.toISOString()}`);

        const countByDate = await col.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
        console.log(`\n[match createdAt >= Date]   matches: ${countByDate}`);

        const countByString = await col.countDocuments({
            createdAt: { $gte: sevenDaysAgo.toISOString() }
        });
        console.log(`[match createdAt >= String] matches: ${countByString}`);

        // Same aggregation the dashboard uses
        const agg = await col
            .aggregate([
                { $match: { createdAt: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ])
            .toArray();
        console.log("\nAggregation result (the `weekly` array):");
        console.log(agg);
    } catch (e) {
        console.error("Probe failed:", e);
    } finally {
        await closeDatabaseConnection();
        process.exit(0);
    }
})();
