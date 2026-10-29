var express = require("express");
var router = express.Router();

var shopsRouter = require("./shops");
var modelsRouter = require("./models");
var partsRouter = require("./parts");
var qualitiesRouter = require("./qualities");
var casesRouter = require("./cases");
var callCenterRouter = require("./callCenter");
var caseEmailsRouter = require("./caseEmails");
const { requirePermission } = require("../../middleware/auth");

// Shops/Models/Parts/Qualities are admin + TechElite Admin territory. Both hold
// matching wildcard permissions (sqt:*:*, *:*:*); shop and iMobile roles do not.
router.use("/shops", requirePermission("sqt:shop:list"), shopsRouter);
router.use("/models", requirePermission("sqt:model:list"), modelsRouter);
router.use("/qualities", requirePermission("sqt:model:list"), qualitiesRouter);
// Cases are gated per-route inside (mixed shop-side / internal permissions)
router.use("/cases", casesRouter);
// The call center's portal (sqt:callcenter:*) — gated inside per route.
router.use("/call-center", callCenterRouter);
// Need Attention — SquareTrade follow-up emails (sqt:email:*), gated inside.
router.use("/case-emails", caseEmailsRouter);

// Parts are scoped under a model — mounted on /models/:modelId/parts
router.use("/models/:modelId/parts", requirePermission("sqt:model:list"), partsRouter);

module.exports = router;
