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
// Public webhook endpoint that HandwritingOCR posts to when extraction
// finishes. Mounted outside the authenticated chain (OCR doesn't hold
// our JWT) — security is via the body's ocrId matching our own row.
var creditNoteWebhookRouter = require('./routes/creditNoteRoutes/webhook');
// Public webhook endpoint for Meta's WhatsApp Cloud API. Same mount
// pattern as the OCR webhook: outside the auth chain, security via
// the X-Hub-Signature-256 HMAC plus the GET-handshake verify token.
var whatsappWebhookRouter = require('./routes/whatsappRoutes/webhook');
// Public widget submission endpoints — receive form submissions from
// the embeddable widgets shipped out of the iMobile_Widget repo.
// Mounted outside the auth chain (third-party sites can't carry our
// JWT); security via CORS allowlist + origin check + rate limit +
// honeypot, all configured inside the router.
var widgetRouter = require('./routes/widgetRoutes/index');
// TEMPORARY: external-integration endpoint (no auth). Remove together with
// routes/_tempUpdateStatusByTicket.js when the integration is decommissioned.
var tempIntegrationRouter = require('./routes/_tempUpdateStatusByTicket');
var { authenticate } = require('./middleware/auth');

var app = express();

app.use(cors());

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
// `verify` stashes the raw request bytes on req.rawBody so webhook
// endpoints can recompute HMAC signatures over the exact payload Meta
// signed — once express.json() parses the body, the original byte
// sequence is gone and any re-serialised JSON won't match the digest.
// The callback runs on every request but only retains a Buffer
// reference, so the overhead is negligible.
app.use(express.json({
  verify: function (req, _res, buf) {
    if (buf && buf.length) req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/auth', authRouter);
// TEMPORARY: mounted before the auth-protected routers so /integration/* stays
// open to the external caller. Remove when the integration is gone.
app.use(tempIntegrationRouter);
// HandwritingOCR webhook — public POST endpoint mounted before the
// authenticated routers because OCR doesn't carry our JWT.
app.use('/webhook', creditNoteWebhookRouter);
// WhatsApp Cloud API webhook — exposes:
//   GET  /webhook/whatsapp  → Meta's subscription verification handshake
//   POST /webhook/whatsapp  → inbound message + status notifications
// Public for the same reason as the OCR webhook (Meta can't carry our
// JWT); request integrity is enforced inside the router via
// X-Hub-Signature-256 against WHATSAPP_APP_SECRET.
app.use('/webhook', whatsappWebhookRouter);
// Widget submission endpoints — POST /widget/<name>. Public; CORS +
// origin allowlist + rate limit + honeypot live inside the router.
app.use('/widget', widgetRouter);
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
