// Inbound InFlow sales-order webhook.
//
// An external system (InFlow / a Flow automation) POSTs an invoice payload here;
// we upsert the customer + vendor and the sales order. Idempotent by
// invoiceNumber — a repeat webhook refreshes the invoice fields but PRESERVES
// paidAmount + payments (recorded in-app).
//
// totalAmount may be negative — a negative order is a CREDIT NOTE under the
// customer (it reduces what they owe).
//
// Payload (JSON body):
//   { invoiceNumber, vendor, customerName, invoiceDate ("DD/MM/YYYY"),
//     subtotal, tax, totalAmount,
//     lineItems: [{ sku, description, quantity, unitPrice, subTotal }] }
//
// Public (no JWT). Optional shared secret: if INFLOW_WEBHOOK_SECRET is set, the
// caller must send a matching `x-webhook-secret` header (or `secret` param).

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");

const ORDERS = "inflow_salesorders";
const CUSTOMERS = "inflow_customers";
const VENDORS = "inflow_vendors";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// "DD/MM/YYYY" → Date (local midnight); falls back to Date parsing; null if bad.
function parseDMY(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Upsert a customer/vendor by case-insensitive name; returns its _id.
async function upsertNamed(db, collection, name, now) {
  if (!name) return null;
  const nameLower = name.toLowerCase();
  const r = await db.collection(collection).findOneAndUpdate(
    { nameLower },
    { $setOnInsert: { name, nameLower, createdAt: now }, $set: { updatedAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  const doc = r ? r.value || r : null;
  return doc ? doc._id : null;
}

async function handleWebhook(req, res) {
  try {
    const secret = process.env.INFLOW_WEBHOOK_SECRET;
    if (secret) {
      const provided =
        req.get("x-webhook-secret") ||
        (req.query && req.query.secret) ||
        (req.body && req.body.secret);
      if (provided !== secret) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
    }

    const p = req.body || {};
    const invoiceNumber = String(p.invoiceNumber || "").trim();
    if (!invoiceNumber) {
      return res.status(400).json({ success: false, message: "invoiceNumber is required" });
    }

    const db = await connectToDatabase();
    const now = new Date();
    const customerName = String(p.customerName || "").trim();
    const vendorName = String(p.vendor || "").trim();

    const customerId = await upsertNamed(db, CUSTOMERS, customerName, now);
    const vendorId = await upsertNamed(db, VENDORS, vendorName, now);

    const lineItems = Array.isArray(p.lineItems)
      ? p.lineItems.map((li) => ({
          sku: String((li && li.sku) || "").trim(),
          description: String((li && li.description) || ""),
          quantity: num(li && li.quantity),
          unitPrice: num(li && li.unitPrice),
          subTotal: num(li && li.subTotal),
        }))
      : [];

    const totalAmount = num(p.totalAmount);
    const set = {
      vendor: vendorName || null,
      vendorId,
      customerName: customerName || null,
      customerId,
      invoiceDate: parseDMY(p.invoiceDate),
      invoiceDateRaw: p.invoiceDate != null ? String(p.invoiceDate) : null,
      // S3 object key of the invoice PDF (joined to a base URL for preview).
      invoiceUrl: p.invoiceUrl != null && String(p.invoiceUrl).trim() ? String(p.invoiceUrl).trim() : null,
      subtotal: num(p.subtotal),
      tax: num(p.tax),
      totalAmount,
      isCreditNote: totalAmount < 0,
      lineItems,
      updatedAt: now,
    };

    const r = await db.collection(ORDERS).findOneAndUpdate(
      { invoiceNumber },
      {
        $set: set,
        // preserve in-app payment state across repeat webhooks
        $setOnInsert: {
          invoiceNumber,
          paidAmount: 0,
          payments: [],
          createdAt: now,
          source: "webhook",
        },
      },
      { upsert: true, returnDocument: "after" },
    );
    const doc = r ? r.value || r : null;

    return res.json({
      success: true,
      id: doc ? doc._id : null,
      invoiceNumber,
      isCreditNote: totalAmount < 0,
    });
  } catch (error) {
    console.error("InFlow webhook error:", error);
    return res.status(500).json({ success: false, message: "Failed to record sales order" });
  }
}

// Accept GET or POST so it works with whatever the caller is configured for.
router.all("/", handleWebhook);

module.exports = router;
