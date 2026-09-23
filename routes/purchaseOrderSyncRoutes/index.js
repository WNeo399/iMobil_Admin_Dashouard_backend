// Public trigger for the daily Purchase Order UPDATE sync — RETIRED.
//
//   GET|POST /integration/purchaseOrderSync
//
// Until 2026-09-23 a scheduler hit this once a day to pull the purchase
// team's edits out of the Tencent Docs sheet (utils/purchaseOrderSync). The
// sheet was retired that day — its open rows were imported into Spare Parts
// Purchase (bin/import-tencent-purchases.js) and purchasing runs there — so
// the endpoint now answers without touching Tencent. It stays mounted only so
// a scheduler still calling it gets a clear answer rather than an error;
// remove the scheduled job.

var express = require("express");
var router = express.Router();

router.all("/", (req, res) =>
  res.json({
    success: true,
    retired: true,
    message: "The Tencent purchase sheet was retired on 2026-09-23 — purchases run in Spare Parts Purchase. Nothing was synced; remove this scheduled job.",
  }),
);

module.exports = router;
