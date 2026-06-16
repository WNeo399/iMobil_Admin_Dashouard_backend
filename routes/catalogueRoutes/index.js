// IMB catalogue router. Mounted in app.js at /catalogue under the
// authenticated chain. Three concerns:
//   - reference.js : brand / category / model / quality CRUD
//   - products.js  : the imb_products catalogue CRUD
//   - match.js     : the Oz matcher (POST /catalogue/match)
//
// Per-endpoint permission gating lives inside each sub-router.

var express = require("express");
var router = express.Router();

const referenceRouter = require("./reference");
const productsRouter = require("./products");
const matchRouter = require("./match");

router.use("/", referenceRouter);
router.use("/", productsRouter);
router.use("/", matchRouter);

module.exports = router;
