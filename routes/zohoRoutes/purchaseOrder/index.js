// Standalone wrapper around POST
// https://www.zohoapis.com/inventory/v1/purchaseorders — the purchase-side
// twin of ../salesOrder (user ask 2026-10-05: a "Create Purchase Order" tool,
// the same as Create Sales Order but raising a purchase order).
//
// Like the sales-order endpoint it touches no Mongo state: it translates a
// normalized payload → Zoho's shape, posts it, and returns Zoho's answer.
// The order is left a DRAFT under the "Vendor Placeholder" vendor unless the
// caller names one — staff re-assign the real vendor inside Zoho, exactly as
// they re-assign the customer on a tool-made sales order. No rate is sent,
// so Zoho prices each line at the item's own purchase rate.

var express = require("express");
var router = express.Router();
const { handleZohoInventoryPostRequest } = require("../../../utils/zohoRequest");
const { gstTaxId } = require("../../../utils/sppZoho");
const { requirePermission } = require("../../../middleware/auth");

const ZOHO_ORG_ID = "746138234";

// "Vendor Placeholder" in Zoho Inventory — the vendor a tool-made purchase
// order sits under until staff pick the real one.
const DEFAULT_VENDOR_ID = "2591985000079285780";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// One lineItem from our camelCase shape to Zoho's snake_case. Each line MUST
// have an itemId; quantity defaults to 1. Every purchase line carries a tax
// — the team's purchase orders all carry the org's GST (see utils/sppZoho) —
// so a line without its own tax_id gets that. Any other Zoho field the
// caller supplies (rate, description…) passes through verbatim.
function normalizeLineItem(raw, taxId) {
  if (!raw) return null;
  const itemId = raw.itemId != null ? String(raw.itemId).trim() : "";
  if (!itemId) return null;
  const qty = Number(raw.quantity);
  const line = {
    item_id: itemId,
    quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
  };
  for (const k of Object.keys(raw)) {
    if (k === "itemId" || k === "quantity") continue;
    line[k] = raw[k];
  }
  if (!line.tax_id && taxId) line.tax_id = taxId;
  return line;
}

router.post(
  "/create",
  requirePermission("zoho:purchaseOrder:create"),
  async function (req, res) {
    try {
      const body = req.body || {};

      const vendorId = isNonEmptyString(body.vendorId)
        ? body.vendorId.trim()
        : DEFAULT_VENDOR_ID;

      // Checked before anything reaches Zoho, so a bad payload costs no call.
      const rawLines = Array.isArray(body.lineItems) ? body.lineItems : [];
      if (rawLines.map((l) => normalizeLineItem(l, "")).filter(Boolean).length === 0) {
        return res.status(400).json({
          success: false,
          message: "lineItems must be a non-empty array; each entry needs an itemId",
        });
      }

      const taxId = await gstTaxId();
      const lineItems = rawLines.map((l) => normalizeLineItem(l, taxId)).filter(Boolean);

      const date = isNonEmptyString(body.date)
        ? body.date.trim()
        : new Date().toISOString().split("T")[0];
      const notes = isNonEmptyString(body.notes) ? body.notes.trim() : undefined;
      const referenceNumber = isNonEmptyString(body.referenceNumber)
        ? body.referenceNumber.trim()
        : undefined;

      const requestBody = {
        vendor_id: vendorId,
        date,
        line_items: lineItems,
      };
      if (notes !== undefined) requestBody.notes = notes;
      if (referenceNumber !== undefined) requestBody.reference_number = referenceNumber;

      const zohoUrl = `https://www.zohoapis.com/inventory/v1/purchaseorders?organization_id=${ZOHO_ORG_ID}`;
      const zohoResp = await handleZohoInventoryPostRequest(zohoUrl, requestBody);

      if (!zohoResp || zohoResp.code !== 0 || !zohoResp.purchaseorder) {
        const msg =
          (zohoResp && zohoResp.message) ||
          "Zoho Inventory did not accept the order";
        console.error("Zoho PO create failed:", zohoResp);
        return res.status(502).json({
          success: false,
          message: `Zoho: ${msg}`,
          data: zohoResp || null,
        });
      }

      const po = zohoResp.purchaseorder;
      return res.status(201).json({
        success: true,
        message: `Purchase order ${po.purchaseorder_number} created`,
        data: {
          purchaseOrderId: po.purchaseorder_id,
          purchaseOrderNumber: po.purchaseorder_number,
          purchaseOrder: po,
        },
      });
    } catch (error) {
      console.error("Standalone PO create error:", error);
      return res.status(500).json({
        success: false,
        message: `Failed to create purchase order: ${error.message || error}`,
      });
    }
  },
);

module.exports = router;
