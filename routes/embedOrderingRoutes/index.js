// Embed Ordering — distributors sell our parts to their own customers
// through the exploded-diagram widget embedded on their site.
//
// Deliberately self-contained: everything Embed Ordering lives under routes/embedOrderingRoutes
// and the embed_ordering_* collections, and nothing outside this folder imports from
// it. Shared plumbing (auth, Mongo, Zoho, S3) comes from utils/ like every
// other module. Kept that way so the whole module can be lifted into its
// own service later without untangling it from the dashboard.
//
//   /embed-ordering/distributors   the businesses embedding our widget
//   /embed-ordering/customers      each distributor’s own customers
//   /embed-ordering/orders         orders placed through the Embed Ordering widget
//   /embed-ordering/widget-summary what the ordering widget holds (Ordering Widget page)
//
// The widget's PUBLIC endpoints (catalogue, sign-in, cart orders) live in
// ./widget.js and are mounted at /widget/embed-ordering by routes/widgetRoutes — outside
// the JWT chain, so not here.
//
// Mounted under the authenticated chain in app.js. Gated by embedOrdering:* — held
// only by *:*:* (Admin) for now.

var express = require("express");
var router = express.Router();

router.use("/distributors", require("./distributors"));
router.use("/customers", require("./customers"));
router.use("/orders", require("./orders"));
router.use("/widget-summary", require("./widgetSummary"));

module.exports = router;
