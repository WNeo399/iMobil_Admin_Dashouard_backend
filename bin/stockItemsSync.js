// One pass of the incremental stock-register sync (utils/stockItemsSync):
// items modified in Zoho since the last pass, updated in place. The
// backend runs this on a schedule by itself; this entrypoint is for running
// it by hand or from a cron.
//
//   node bin/stockItemsSync.js

require("dotenv").config();

const { runStockItemsSync } = require("../utils/stockItemsSync");

runStockItemsSync({ log: console.log, trigger: "cli" })
  .then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  })
  .catch((e) => {
    console.error("SYNC FAILED:", e.message);
    process.exit(1);
  });
