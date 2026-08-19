// Point of Sale — distributors sell our parts to their own customers
// through the exploded-diagram widget embedded on their site.
//
// Deliberately self-contained: everything POS lives under routes/posRoutes
// and the pos_* collections, and nothing outside this folder imports from
// it. Shared plumbing (auth, Mongo, Zoho, S3) comes from utils/ like every
// other module. Kept that way so the whole module can be lifted into its
// own service later without untangling it from the dashboard.
//
//   /pos/distributors   the businesses embedding our widget
//   /pos/customers      each distributor’s own customers
//
// Mounted under the authenticated chain in app.js. Gated by pos:* — held
// only by *:*:* (Admin) for now.

var express = require("express");
var router = express.Router();

router.use("/distributors", require("./distributors"));
router.use("/customers", require("./customers"));

module.exports = router;
