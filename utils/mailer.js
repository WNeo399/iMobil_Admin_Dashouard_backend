// Outbound email via the Hostinger SMTP account configured in .env
// (HOSTINGER_SMTP_HOST / PORT / SUPPORT_USER / SUPPORT_PASS).
//
// sendMail({ to, cc, subject, text, html, attachments }) — `from` defaults
// to the authenticated SMTP user.

const nodemailer = require("nodemailer");

let transport = null;

function getTransport() {
  if (!transport) {
    const host = process.env.HOSTINGER_SMTP_HOST;
    const user = process.env.HOSTINGER_SMTP_SUPPORT_USER;
    const pass = process.env.HOSTINGER_SMTP_SUPPORT_PASS;
    if (!host || !user || !pass) {
      throw new Error("Email is not configured (HOSTINGER_SMTP_* missing in .env).");
    }
    const port = Number(process.env.HOSTINGER_SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user, pass },
    });
  }
  return transport;
}

async function sendMail(opts) {
  const t = getTransport();
  return t.sendMail({
    from: opts.from || process.env.HOSTINGER_SMTP_SUPPORT_USER,
    ...opts,
  });
}

// Connection/credential check without sending anything.
async function verifyMailer() {
  return getTransport().verify();
}

module.exports = { sendMail, verifyMailer };
