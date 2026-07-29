// Blackbelt — partner accounts and their linked SQT shops.
//
// An account is { name, email, contactNumber }. Each SQT shop (sqt_shops)
// may point at ONE Blackbelt account via `blackbeltAccountId`; an account
// can have many shops pointing at it. Admin-only for now (blackbelt:*
// permissions are carried only by the admin wildcard).

var express = require("express");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { sendMail } = require("../../utils/mailer");

const ACCOUNTS = "blackbelt_accounts";
const SQT_SHOPS = "sqt_shops";
const INVOICES = "blackbelt_invoices";

const VIEW = requirePermission("blackbelt:account:view");
const INVOICE = requirePermission("blackbelt:invoice:view");

function oid(v) {
  try { return new ObjectId(String(v)); } catch (e) { return null; }
}

function accountPayloadError(b) {
  const name = String((b && b.name) || "").trim();
  if (!name) return "Account name is required.";
  const email = String((b && b.email) || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Email doesn't look valid.";
  if (b && b.negotiatedRate != null && String(b.negotiatedRate).trim() !== "") {
    const n = Number(b.negotiatedRate);
    if (!Number.isFinite(n) || n < 0) return "Rate must be a non-negative number.";
  }
  return null;
}

// The per-account negotiated rate — null when not yet agreed.
function parseRate(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Accounts ────────────────────────────────────────────────────────

// List accounts, each with its linked shops [{_id, storeName, status}].
router.get("/accounts", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const accounts = await db.collection(ACCOUNTS).find({}).sort({ name: 1 }).toArray();
    const links = await db.collection(SQT_SHOPS)
      .find({ blackbeltAccountId: { $exists: true, $ne: null } })
      .project({ storeName: 1, status: 1, blackbeltAccountId: 1 })
      .sort({ storeName: 1 })
      .toArray();
    const byAccount = {};
    for (const s of links) {
      const key = String(s.blackbeltAccountId);
      if (!byAccount[key]) byAccount[key] = [];
      byAccount[key].push({ _id: s._id, storeName: s.storeName, status: s.status });
    }
    return res.json({
      success: true,
      accounts: accounts.map((a) => ({ ...a, shops: byAccount[String(a._id)] || [] })),
    });
  } catch (e) {
    console.error("blackbelt accounts error:", e);
    return res.status(500).json({ success: false, message: "Failed to load accounts" });
  }
});

router.post("/accounts", VIEW, async function (req, res) {
  try {
    const err = accountPayloadError(req.body);
    if (err) return res.status(400).json({ success: false, message: err });
    const db = await connectToDatabase();
    const name = String(req.body.name).trim();
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dupe = await db.collection(ACCOUNTS).findOne({ name: { $regex: `^${esc}$`, $options: "i" } });
    if (dupe) return res.status(400).json({ success: false, message: "An account with that name already exists." });
    const now = new Date();
    const doc = {
      name,
      email: String((req.body.email) || "").trim(),
      contactNumber: String((req.body.contactNumber) || "").trim(),
      negotiatedRate: parseRate(req.body.negotiatedRate),
      createdAt: now,
      updatedAt: now,
      createdBy: (req.user && (req.user.username || req.user.email)) || null,
    };
    const r = await db.collection(ACCOUNTS).insertOne(doc);
    return res.json({ success: true, account: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("blackbelt account create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create account" });
  }
});

router.put("/accounts/:id", VIEW, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const err = accountPayloadError(req.body);
    if (err) return res.status(400).json({ success: false, message: err });
    const db = await connectToDatabase();
    const r = await db.collection(ACCOUNTS).updateOne(
      { _id },
      { $set: {
        name: String(req.body.name).trim(),
        email: String((req.body.email) || "").trim(),
        contactNumber: String((req.body.contactNumber) || "").trim(),
        negotiatedRate: parseRate(req.body.negotiatedRate),
        updatedAt: new Date(),
      } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Account not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("blackbelt account update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update account" });
  }
});

// Delete an account — linked shops are unlinked, not touched otherwise.
router.delete("/accounts/:id", VIEW, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const r = await db.collection(ACCOUNTS).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Account not found" });
    await db.collection(SQT_SHOPS).updateMany(
      { blackbeltAccountId: _id },
      { $unset: { blackbeltAccountId: "" }, $set: { updatedAt: new Date() } },
    );
    return res.json({ success: true });
  } catch (e) {
    console.error("blackbelt account delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete account" });
  }
});

// ── SQT shop links ──────────────────────────────────────────────────

// All SQT shops with their current Blackbelt link — options for the picker.
router.get("/sqtShops", VIEW, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const shops = await db.collection(SQT_SHOPS)
      .find({})
      .project({ storeName: 1, status: 1, blackbeltAccountId: 1 })
      .sort({ storeName: 1 })
      .toArray();
    return res.json({ success: true, shops });
  } catch (e) {
    console.error("blackbelt sqtShops error:", e);
    return res.status(500).json({ success: false, message: "Failed to load SQT shops" });
  }
});

// Replace the set of shops linked to this account. Shops in `shopIds` are
// pointed at the account (moving them off another account if needed); shops
// currently on this account but NOT in the list are unlinked.
router.post("/accounts/:id/shops", VIEW, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const account = await db.collection(ACCOUNTS).findOne({ _id });
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });

    const shopIds = (Array.isArray(req.body && req.body.shopIds) ? req.body.shopIds : [])
      .map(oid)
      .filter(Boolean);
    const now = new Date();
    const unlinked = await db.collection(SQT_SHOPS).updateMany(
      { blackbeltAccountId: _id, _id: { $nin: shopIds } },
      { $unset: { blackbeltAccountId: "" }, $set: { updatedAt: now } },
    );
    let linked = { modifiedCount: 0 };
    if (shopIds.length) {
      linked = await db.collection(SQT_SHOPS).updateMany(
        { _id: { $in: shopIds } },
        { $set: { blackbeltAccountId: _id, updatedAt: now } },
      );
    }
    return res.json({ success: true, linked: shopIds.length, changed: linked.modifiedCount + unlinked.modifiedCount });
  } catch (e) {
    console.error("blackbelt link shops error:", e);
    return res.status(500).json({ success: false, message: "Failed to update shop links" });
  }
});

// ── Invoices ────────────────────────────────────────────────────────
// An invoice bills an account: qty × the account's rate AT CREATION TIME
// (the rate is snapshotted onto the invoice, so renegotiating the account
// later never rewrites past invoices).

router.get("/invoices", INVOICE, async function (req, res) {
  try {
    const db = await connectToDatabase();
    const match = {};
    if (req.query.accountId) {
      const aid = oid(req.query.accountId);
      if (aid) match.accountId = aid;
    }
    const invoices = await db.collection(INVOICES).find(match).sort({ createdAt: -1 }).limit(300).toArray();
    return res.json({ success: true, invoices });
  } catch (e) {
    console.error("blackbelt invoices error:", e);
    return res.status(500).json({ success: false, message: "Failed to load invoices" });
  }
});

router.post("/invoices", INVOICE, async function (req, res) {
  try {
    const accountId = oid(req.body && req.body.accountId);
    if (!accountId) return res.status(400).json({ success: false, message: "accountId is required" });
    const qty = Number(req.body && req.body.qty);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      return res.status(400).json({ success: false, message: "Qty must be a positive whole number." });
    }
    const db = await connectToDatabase();
    const account = await db.collection(ACCOUNTS).findOne({ _id: accountId });
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });
    if (account.negotiatedRate == null) {
      return res.status(400).json({ success: false, message: `"${account.name}" has no negotiated rate yet — set it on the Accounts page first.` });
    }

    const rate = Number(account.negotiatedRate);
    const total = Math.round(qty * rate * 100) / 100;
    // Due date — user-picked at creation, defaulting to 15 days out.
    let dueDate = null;
    if (req.body && req.body.dueDate) {
      const d = new Date(req.body.dueDate);
      if (!isNaN(d.getTime())) dueDate = d;
    }
    if (!dueDate) dueDate = new Date(Date.now() + 15 * 86400000);
    // Next number = highest ever issued + 1 (NOT count+1, which would reuse
    // a number after a delete). Numbering starts at BBI-10001.
    const last = await db.collection(INVOICES).find({}).sort({ seq: -1 }).limit(1).toArray();
    const seq = Math.max((last[0] && last[0].seq) || 0, 10000) + 1;
    const doc = {
      number: `BBI-${seq}`,
      seq,
      accountId,
      accountName: account.name,
      rate,
      qty,
      total,
      note: String((req.body && req.body.note) || "").trim().slice(0, 500),
      dueDate,
      paymentStatus: "unpaid",
      paidAt: null,
      createdAt: new Date(),
      createdBy: (req.user && (req.user.username || req.user.email)) || null,
    };
    const r = await db.collection(INVOICES).insertOne(doc);
    return res.json({ success: true, invoice: { _id: r.insertedId, ...doc } });
  } catch (e) {
    console.error("blackbelt invoice create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create invoice" });
  }
});

// Email the invoice PDF to the account's configured address.
// The PDF is generated client-side (same jsPDF template as the preview) and
// posted here as base64 — the server never re-renders it.
// CC disabled while testing — restore to "accounts@exyon.com.au" to go live.
const INVOICE_CC = "";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const splitAddresses = (s) => String(s || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const stripDataUrl = (s) => {
  const v = String(s || "");
  const comma = v.indexOf(",");
  return v.startsWith("data:") && comma !== -1 ? v.slice(comma + 1) : v;
};

router.post("/invoices/:id/email", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const b = req.body || {};
    const pdfBase64 = stripDataUrl(b.pdfBase64);
    if (!pdfBase64) return res.status(400).json({ success: false, message: "pdfBase64 is required" });
    if (pdfBase64.length > 8 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: "PDF too large." });
    }

    const db = await connectToDatabase();
    const invoice = await db.collection(INVOICES).findOne({ _id });
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found" });
    const account = await db.collection(ACCOUNTS).findOne({ _id: invoice.accountId });
    if (!account) return res.status(404).json({ success: false, message: "Account no longer exists" });

    // Recipients — reviewed/edited in the compose dialog; fall back to the
    // account's configured address.
    const toList = splitAddresses(b.to || account.email);
    if (!toList.length) {
      return res.status(400).json({
        success: false,
        message: `"${account.name}" has no email configured — set it on the Accounts page or enter one in the dialog.`,
      });
    }
    const ccList = splitAddresses(b.cc != null ? b.cc : INVOICE_CC);
    for (const addr of [...toList, ...ccList]) {
      if (!EMAIL_RX.test(addr)) {
        return res.status(400).json({ success: false, message: `"${addr}" doesn't look like a valid email address.` });
      }
    }

    const total = Number(invoice.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dueStr = invoice.dueDate
      ? new Date(invoice.dueDate).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Melbourne" })
      : "";
    const subject = String(b.subject || "").trim().slice(0, 200) || `Invoice ${invoice.number} — Exyon Pty Ltd`;
    const body = String(b.body || "").slice(0, 5000) ||
      `Dear ${account.name},\n\n` +
      `Please find attached invoice ${invoice.number} for $${total}.` +
      (dueStr ? ` Payment is due by ${dueStr}.` : "") +
      `\n\nBank details are included on the invoice.\n\nKind regards,\nExyon Pty Ltd`;

    // Extra attachments from the dialog (on top of the invoice PDF).
    const extras = Array.isArray(b.attachments) ? b.attachments.slice(0, 5) : [];
    const attachments = [{ filename: `${invoice.number}.pdf`, content: Buffer.from(pdfBase64, "base64") }];
    for (const a of extras) {
      const data = stripDataUrl(a && a.dataBase64);
      if (!data) continue;
      if (data.length > 5 * 1024 * 1024) {
        return res.status(400).json({ success: false, message: `Attachment "${a.filename || ""}" is too large (max ~3.5MB).` });
      }
      const filename = String((a && a.filename) || "attachment").replace(/[/\\]/g, "_").slice(0, 120);
      attachments.push({ filename, content: Buffer.from(data, "base64") });
    }

    await sendMail({
      to: toList.join(", "),
      cc: ccList.length ? ccList.join(", ") : undefined,
      subject,
      text: body,
      attachments,
    });

    await db.collection(INVOICES).updateOne(
      { _id },
      { $set: {
        emailedAt: new Date(),
        emailedTo: toList.join(", "),
        emailedCc: ccList.join(", ") || null,
        emailedBy: (req.user && (req.user.username || req.user.email)) || null,
        updatedAt: new Date(),
      } },
    );
    return res.json({ success: true, to: toList.join(", "), cc: ccList.join(", ") });
  } catch (e) {
    console.error("blackbelt invoice email error:", e);
    return res.status(502).json({ success: false, message: e.message || "Failed to send the email" });
  }
});

// Record whether an invoice has been paid.
router.post("/invoices/:id/paymentStatus", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const status = req.body && req.body.status;
    if (status !== "paid" && status !== "unpaid") {
      return res.status(400).json({ success: false, message: "status must be 'paid' or 'unpaid'" });
    }
    const db = await connectToDatabase();
    const r = await db.collection(INVOICES).updateOne(
      { _id },
      { $set: {
        paymentStatus: status,
        paidAt: status === "paid" ? new Date() : null,
        paidBy: status === "paid" ? ((req.user && (req.user.username || req.user.email)) || null) : null,
        updatedAt: new Date(),
      } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Invoice not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("blackbelt payment status error:", e);
    return res.status(500).json({ success: false, message: "Failed to update payment status" });
  }
});

router.delete("/invoices/:id", INVOICE, async function (req, res) {
  try {
    const _id = oid(req.params.id);
    if (!_id) return res.status(400).json({ success: false, message: "invalid id" });
    const db = await connectToDatabase();
    const r = await db.collection(INVOICES).deleteOne({ _id });
    if (!r.deletedCount) return res.status(404).json({ success: false, message: "Invoice not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("blackbelt invoice delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete invoice" });
  }
});

module.exports = router;
