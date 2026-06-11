// Twilio webhook router. Mounted in app.js at /webhook/twilio
// (outside the JWT-authenticated chain — Twilio's servers can't carry
// our auth, integrity comes from X-Twilio-Signature instead).
//
// IMPORTANT — mount order matters. The more specific path
// (/whatsapp/status) must be registered BEFORE the more general one
// (/whatsapp), otherwise the inbound router would catch
// /whatsapp/status as its own /status sub-route by mistake.

var express = require("express");
var router = express.Router();

const whatsappInboundRouter = require("./whatsappInbound");
const whatsappStatusRouter = require("./whatsappStatus");

router.use("/whatsapp/status", whatsappStatusRouter);
router.use("/whatsapp", whatsappInboundRouter);

module.exports = router;
