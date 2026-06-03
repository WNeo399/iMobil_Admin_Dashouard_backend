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
// Public webhook endpoint that HandwritingOCR posts to when extraction
// finishes. Mounted outside the authenticated chain (OCR doesn't hold
// our JWT) — security is via the body's ocrId matching our own row.
var creditNoteWebhookRouter = require('./routes/creditNoteRoutes/webhook');
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
app.use(express.json());
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
// All zoho/sqt/users routes require a valid login; per-permission checks are
// applied inside the routers.
app.use('/zoho', authenticate, zohoRouter);
app.use('/sqt', authenticate, sqtRouter);
app.use('/dashboard', authenticate, dashboardRouter);
app.use('/users', authenticate, usersRouter);
app.use('/repair', authenticate, repairRouter);
app.use('/creditNote', authenticate, creditNoteRouter);

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
