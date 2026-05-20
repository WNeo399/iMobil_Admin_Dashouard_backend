var express = require("express");
var router = express.Router();

var shopsRouter = require("./shops");
var modelsRouter = require("./models");
var partsRouter = require("./parts");
var qualitiesRouter = require("./qualities");
var casesRouter = require("./cases");

router.use("/shops", shopsRouter);
router.use("/models", modelsRouter);
router.use("/qualities", qualitiesRouter);
router.use("/cases", casesRouter);

// Parts are scoped under a model — mounted on /models/:modelId/parts
router.use("/models/:modelId/parts", partsRouter);

module.exports = router;
