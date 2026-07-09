var createError = require('http-errors');
var express = require('express');
require('dotenv').config();
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');

const cors = require("cors");

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var zohoRouter = require('./routes/zohoRoutes/index');
var sqtRouter = require('./routes/sqtRoutes/index');
var dashboardRouter = require('./routes/dashboardRoutes/index');
var authRouter = require('./routes/authRoutes/index');
// iMobile Repair — proxies the iMobile RepairDesk org (separate API key,
// see routes/repairRoutes/index.js for the key-name distinction).
var repairRouter = require('./routes/repairRoutes/index');
// Credit Note OCR submission — forwards PDFs to HandwritingOCR using
// the bearer token kept in .env, so credentials stay server-side.
var creditNoteRouter = require('./routes/creditNoteRoutes/index');
// Admin-side endpoints for reviewing widget Special Order
// submissions. Same gate as Credit Note (zoho:salesOrder:create) so
// the same role can triage what came in via the embedded widget.
var specialOrderRouter = require('./routes/specialOrderRoutes/index');
// Admin CRUD for the per-widget origin allowlist that the public
// /widget/* endpoints consult on every submission. Gated by
// system:user:manage — system-tier admins manage who can talk to
// the public widget endpoints.
var widgetOriginRouter = require('./routes/widgetOriginRoutes/index');
// IMB parts catalogue — reference data (brand/category/model/quality)
// + the imb_products SKU catalogue CRUD + the Oz matcher endpoint.
// Gated by the collection permissions (reused — same admins manage
// iMobile product data).
var catalogueRouter = require('./routes/catalogueRoutes/index');
var svpEnquiryRouter = require('./routes/svpEnquiryRoutes/index');
var svpSerialRouter = require('./routes/svpSerialRoutes/index');
var svpPublicRouter = require('./routes/svpPublicRoutes/index');
// Per-user in-app notifications (bell + toast). Scoped to the caller inside
// the router, so it only needs `authenticate` — no per-permission gate.
var notificationRouter = require('./routes/notificationRoutes/index');
// Purchase Order — read-only view over the supplier's Tencent Docs sheet.
var purchaseOrderRouter = require('./routes/purchaseOrderRoutes/index');
// Refurbished Phones — read-only views over the external scraper MySQL DB.
var refurbishedRouter = require('./routes/refurbishedRoutes/index');
// Ask the Data — agentic Claude chat that answers questions by running
// read-only SQL over the scraper MySQL (see utils/aiSql.js for the guardrails).
var aiQueryRouter = require('./routes/aiQueryRoutes/index');
// InFlow — sales orders + customers. Authenticated read/payment API here;
// the public ingestion webhook is inflowWebhookRoutes (mounted below).
var inflowRouter = require('./routes/inflowRoutes/index');
var inflowWebhookRouter = require('./routes/inflowWebhookRoutes/index');
// Public daily-cron trigger for the Purchase Order UPDATE sync (Tencent → DB).
var purchaseOrderSyncRouter = require('./routes/purchaseOrderSyncRoutes/index');
// Public webhook endpoint that HandwritingOCR posts to when extraction
// finishes. Mounted outside the authenticated chain (OCR doesn't hold
// our JWT) — security is via the body's ocrId matching our own row.
var creditNoteWebhookRouter = require('./routes/creditNoteRoutes/webhook');
// Twilio WhatsApp webhook router. Exposes:
//   POST /webhook/twilio/whatsapp           inbound messages
//   POST /webhook/twilio/whatsapp/fallback  primary-down fallback
//   POST /webhook/twilio/whatsapp/status    outbound delivery receipts
// Mounted outside the auth chain (Twilio's servers can't carry our
// JWT) — integrity via X-Twilio-Signature, verified per-route.
// Replaces the earlier Meta Cloud API webhook now that we route
// WhatsApp through Twilio's Business Sender.
var twilioRouter = require('./routes/twilioRoutes/index');
// Public widget submission endpoints — receive form submissions from
// the embeddable widgets shipped out of the iMobile_Widget repo.
// Mounted outside the auth chain (third-party sites can't carry our
// JWT); security via CORS allowlist + origin check + rate limit +
// honeypot, all configured inside the router.
var widgetRouter = require('./routes/widgetRoutes/index');
// TEMPORARY: external-integration endpoint (no auth). Remove together with
// routes/_tempUpdateStatusByTicket.js when the integration is decommissioned.
var tempIntegrationRouter = require('./routes/_tempUpdateStatusByTicket');
// Inbound shipment webhook from Zoho Flow — attaches delivery method +
// tracking number to the matching sales order on an SQT case. Public (Zoho
// Flow can't carry our JWT); optional shared secret inside the router.
var shipmentWebhookRouter = require('./routes/shipmentWebhookRoutes/index');
var { authenticate } = require('./middleware/auth');

var app = express();

app.use(cors());

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
// Plain express.json — the rawBody-capture verify callback was only
// here for Meta's WhatsApp HMAC (which signs raw bytes); Twilio
// signs the URL + sorted form params instead, so we don't need to
// hold onto the original buffer anymore.
// The AI assistant ("Ask the Data") accepts image / spreadsheet attachments as
// base64 image blocks that can exceed the default limit — parse /aiQuery bodies
// with a larger cap first; the global parser below then skips it (body-parser
// sets req._body after the first parse, so it isn't re-read at 2mb).
app.use('/aiQuery', express.json({ limit: '15mb' }));
// 2mb limit so the SVP serial-list import (a few thousand serials posted as a
// JSON array) fits; default 100kb is too small. Still bounded.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/auth', authRouter);
// TEMPORARY: mounted before the auth-protected routers so /integration/* stays
// open to the external caller. Remove when the integration is gone.
app.use(tempIntegrationRouter);
// Zoho Flow shipment webhook — GET/POST /integration/shipment. Public.
app.use('/integration/shipment', shipmentWebhookRouter);
// InFlow sales-order ingestion webhook — GET/POST /integration/inflow. Public
// (optional INFLOW_WEBHOOK_SECRET shared secret inside the router).
app.use('/integration/inflow', inflowWebhookRouter);
// Purchase Order daily update sync — GET/POST /integration/purchaseOrderSync.
// Public; protected by the PO_SYNC_SECRET shared secret inside the router.
app.use('/integration/purchaseOrderSync', purchaseOrderSyncRouter);
// HandwritingOCR webhook — public POST endpoint mounted before the
// authenticated routers because OCR doesn't carry our JWT.
app.use('/webhook', creditNoteWebhookRouter);
// Twilio WhatsApp webhook router — see twilioRoutes/index.js for the
// list of sub-routes. Mounted public-side; X-Twilio-Signature is
// verified inside each handler.
app.use('/webhook/twilio', twilioRouter);
// Widget submission endpoints — POST /widget/<name>. Public; CORS +
// origin allowlist + rate limit + honeypot live inside the router.
app.use('/widget', widgetRouter);
// Public Apple SVP serial lookup — GET /svp/lookup. Read-only; rate-limited
// inside the router (trusted lookup server bypasses via the shared secret).
app.use('/svp', svpPublicRouter);
// Static serve for the built widget bundles produced by
// `npm run build:to-backend` in the iMobile_Widget repo. Each bundle
// lands at public/widgets/<widget-name>/v<N>.js and is served from
// /widget-assets/<widget-name>/v<N>.js. The path differs from the
// on-disk one because /widgets/ would collide with the API
// router above. Cached briefly so customers see updates promptly;
// once we move hosting to Cloudflare, this whole mount goes away.
app.use(
  '/widget-assets',
  express.static(path.join(__dirname, 'public', 'widgets'), {
    maxAge: '5m',
    immutable: false,
    setHeaders: (res) => {
      // Embeds run cross-origin. Static assets need permissive CORS
      // so the host page can fetch + parse them without complaints.
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  })
);
// All zoho/sqt/users routes require a valid login; per-permission checks are
// applied inside the routers.
app.use('/zoho', authenticate, zohoRouter);
app.use('/sqt', authenticate, sqtRouter);
app.use('/dashboard', authenticate, dashboardRouter);
app.use('/users', authenticate, usersRouter);
app.use('/repair', authenticate, repairRouter);
app.use('/creditNote', authenticate, creditNoteRouter);
app.use('/specialOrder', authenticate, specialOrderRouter);
app.use('/widgetOrigin', authenticate, widgetOriginRouter);
app.use('/catalogue', authenticate, catalogueRouter);
app.use('/svpEnquiry', authenticate, svpEnquiryRouter);
app.use('/svpSerial', authenticate, svpSerialRouter);
app.use('/notifications', authenticate, notificationRouter);
app.use('/purchaseOrder', authenticate, purchaseOrderRouter);
app.use('/refurbished', authenticate, refurbishedRouter);
app.use('/aiQuery', authenticate, aiQueryRouter);
app.use('/inflow', authenticate, inflowRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});



module.exports = app;
