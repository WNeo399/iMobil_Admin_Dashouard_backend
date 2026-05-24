var express = require("express");
var router = express.Router();

var shopsRouter = require("./shops");
var modelsRouter = require("./models");
var partsRouter = require("./parts");
var qualitiesRouter = require("./qualities");
var casesRouter = require("./cases");
const { requirePermission } = require("../../middleware/auth");

// Shops/Models/Parts/Qualities are admin + TechElite Admin territory. Both hold
// matching wildcard permissions (sqt:*:*, *:*:*); shop and iMobile roles do not.
router.use("/shops", requirePermission("sqt:shop:list"), shopsRouter);
router.use("/models", requirePermission("sqt:model:list"), modelsRouter);
router.use("/qualities", requirePermission("sqt:model:list"), qualitiesRouter);
// Cases are gated per-route inside (mixed shop-side / internal permissions)
router.use("/cases", casesRouter);

// Parts are scoped under a model — mounted on /models/:modelId/parts
router.use("/models/:modelId/parts", requirePermission("sqt:model:list"), partsRouter);

module.exports = router;
