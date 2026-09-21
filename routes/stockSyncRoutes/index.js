// Public trigger for the stock register's Zoho syncs — for an external
// scheduler, the same way /integration/purchaseOrderSync is driven.
//
//   GET|POST /integration/stockSync                 hourly pass (default)
//   GET|POST /integration/stockSync?mode=hourly     items modified since the
//                                                   last pass, updated in
//                                                   place — seconds; answers
//                                                   with the result
//   GET|POST /integration/stockSync?mode=full       the whole register from
//                                                   Zoho (stock, sales,
//                                                   prices, collections) —
//                                                   a couple of minutes;
//                                                   answers "started" and
//                                                   runs on
//
// Suggested schedule: hourly for the default, once a night for mode=full.
// Both are safe to call again while a run is going: the hourly pass steps
// aside ("skipped": "running"), the full refresh reports alreadyRunning.
//
// Public (a cron can't carry our JWT) — protected by a shared secret sent
// as the `x-stock-sync-secret` header, `?secret=`, or a `secret` body
// field. Reads STOCK_SYNC_SECRET, or PO_SYNC_SECRET when that isn't set,
// so one secret can drive every cron trigger. With neither set, refuses.

var express = require("express");
var router = express.Router();
const { runStockItemsSync } = require("../../utils/stockItemsSync");
const { startFullRefresh } = require("../../utils/stockRefresh");

async function handle(req, res) {
  try {
    const secret = process.env.STOCK_SYNC_SECRET || process.env.PO_SYNC_SECRET;
    if (!secret) {
      return res
        .status(503)
        .json({ success: false, message: "Stock sync trigger not configured (set STOCK_SYNC_SECRET)." });
    }
    const provided =
      req.get("x-stock-sync-secret") ||
      (req.query && req.query.secret) ||
      (req.body && req.body.secret);
    if (provided !== secret) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const mode = String((req.query && req.query.mode) || (req.body && req.body.mode) || "hourly").toLowerCase();
    if (mode === "full") {
      const r = startFullRefresh("cron");
      return res.json({ success: true, mode, started: r.started, running: r.running, alreadyRunning: !r.started });
    }
    if (mode !== "hourly") {
      return res.status(400).json({ success: false, message: "mode must be hourly or full" });
    }
    const result = await runStockItemsSync({ log: console.log, trigger: "cron" });
    return res.json({ success: true, mode, ...result });
  } catch (error) {
    console.error("Stock sync trigger error:", error);
    return res.status(502).json({ success: false, message: error.message || "Sync failed" });
  }
}

// Accept GET or POST so it works with whatever the scheduler sends.
router.all("/", handle);

module.exports = router;
