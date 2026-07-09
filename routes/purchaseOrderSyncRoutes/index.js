// Public trigger for the daily Purchase Order UPDATE sync.
//
//   GET|POST /integration/purchaseOrderSync
//
// Meant to be hit by a scheduler once a day (e.g. midnight). It pulls the Tencent
// sheet and applies the purchase team's edits to the matching DB rows in place
// (new rows are inserted; nothing is deleted). See utils/purchaseOrderSync
// (updatePurchaseOrders) for the matching logic.
//
// Public (a cron can't carry our JWT) — protected by a shared secret. Set
// PO_SYNC_SECRET in the env and send it as the `x-po-sync-secret` header (or
// `?secret=` / a `secret` body field). Without the env var set, the endpoint
// refuses to run.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { updatePurchaseOrders } = require("../../utils/purchaseOrderSync");

async function handle(req, res) {
  try {
    const secret = process.env.PO_SYNC_SECRET;
    if (!secret) {
      return res
        .status(503)
        .json({ success: false, message: "PO sync not configured (set PO_SYNC_SECRET)." });
    }
    const provided =
      req.get("x-po-sync-secret") ||
      (req.query && req.query.secret) ||
      (req.body && req.body.secret);
    if (provided !== secret) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const db = await connectToDatabase();
    const result = await updatePurchaseOrders(db);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error("PO update sync error:", error);
    return res
      .status(502)
      .json({ success: false, message: error.message || "Update sync failed" });
  }
}

// Accept GET or POST so it works with whatever the scheduler sends.
router.all("/", handle);

module.exports = router;
