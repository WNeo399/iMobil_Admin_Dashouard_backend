// One-off backfill: assign series_id + series (display name) to every
// imb_products_model that doesn't have one, derived from the model name.
//
// Series groups models within a brand:
//   Apple   → iPhone / iPad
//   Samsung → S Series / Note Series / Flip Series / Fold Series
//
// The model names follow consistent patterns, so the mapping is reliable.
// Anything that doesn't match lands in "Other" and is listed so it can be
// fixed by hand (or via the Reference Data page).
//
// DRY RUN by default:   node bin/backfillModelSeries.js
// Apply for real:       node bin/backfillModelSeries.js --apply

require("dotenv").config();
const {
  connectToDatabase,
  closeDatabaseConnection,
} = require("../utils/mongodb");
const { slugify } = require("../utils/catalogueSlug");
const { deriveSeries } = require("../utils/modelSeries");

const APPLY = process.argv.includes("--apply");
const MODEL = "imb_products_model";

// Shared derivation rule (utils/modelSeries) — name → series display name.
function seriesForModel(m) {
  return deriveSeries(m && m.name);
}

(async () => {
  try {
    const db = await connectToDatabase();
    const col = db.collection(MODEL);
    const models = await col.find({}).toArray();

    console.log(APPLY ? "\n=== APPLYING ===\n" : "\n=== DRY RUN (no writes) ===\n");

    const bySeries = {};
    const unmatched = [];
    let updated = 0;

    for (const m of models) {
      const series = seriesForModel(m);
      if (!series) {
        unmatched.push(m);
        continue;
      }
      const series_id = slugify(series);
      bySeries[series] = (bySeries[series] || 0) + 1;
      // Only write when something actually changes (idempotent re-runs).
      if (m.series_id !== series_id || m.series !== series) {
        updated += 1;
        if (APPLY) {
          await col.updateOne(
            { _id: m._id },
            { $set: { series_id, series } },
          );
        }
      }
    }

    console.log(`Models scanned: ${models.length}`);
    console.log("Series distribution:");
    for (const [s, n] of Object.entries(bySeries)) {
      console.log(`   ${s}: ${n}`);
    }
    console.log(`${APPLY ? "Updated" : "Would update"}: ${updated}`);

    if (unmatched.length) {
      console.log(`\n⚠️  ${unmatched.length} model(s) didn't match any series rule — set these manually:`);
      unmatched.forEach((m) => console.log(`   • ${m.name}  [${m._id}] (brand ${m.brand_id})`));
    } else {
      console.log("\n✅ Every model mapped to a series.");
    }

    if (!APPLY) console.log("\nNothing written. Re-run with --apply to commit.");
  } catch (e) {
    console.error("Backfill model series failed:", e);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    process.exit();
  }
})();
