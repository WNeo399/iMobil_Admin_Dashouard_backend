// Standalone, side-effect-free wrapper around POST
// https://www.zohoapis.com/inventory/v1/salesorders — exposed so any caller
// (admin tooling, future automations, etc.) can drop a sales order without
// inheriting the SQT-specific behaviour bundled into /sqt/cases/:id/sendParts.
//
// Compared to sendParts this endpoint:
//   - does NOT touch any case / Mongo state
//   - does NOT sync RepairDesk
//   - does NOT enforce a particular pricebook/template/customer
//   - just translates a normalized payload → Zoho's expected shape, hits
//     the API, and returns Zoho's response.

var express = require("express");
var router = express.Router();
const multer = require("multer");
const FormData = require("form-data");
const {
  handleZohoInventoryPostRequest,
  handleZohoInventoryMultipartPostRequest,
} = require("../../../utils/zohoRequest");
const { requirePermission } = require("../../../middleware/auth");

const ZOHO_ORG_ID = "746138234";

// In-memory upload for SO attachments. 25 MB is generous for a typical PO
// PDF (which sits around 150 KB) while still capping the worst case.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Sane fallback customer used when the caller doesn't supply one — keeps
// the endpoint usable for ad-hoc tooling that doesn't have a real customer
// context (e.g. internal "stock movement" orders).
const DEFAULT_CUSTOMER_ID = "2591985000300565735";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// Coerce a single lineItem from our `camelCase` shape to Zoho's snake_case.
// Each line MUST have an itemId; quantity defaults to 1. Any extra fields
// the caller supplies (rate, discount, description, etc.) are passed
// through verbatim so we don't have to enumerate Zoho's full schema here.
function normalizeLineItem(raw) {
  if (!raw) return null;
  const itemId = raw.itemId != null ? String(raw.itemId).trim() : "";
  if (!itemId) return null;
  const qty = Number(raw.quantity);
  const line = {
    item_id: itemId,
    quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
  };
  // Pass through any other Zoho fields the caller already speaks (snake_case).
  for (const k of Object.keys(raw)) {
    if (k === "itemId" || k === "quantity") continue;
    line[k] = raw[k];
  }
  return line;
}

router.post(
  "/create",
  requirePermission("zoho:salesOrder:create"),
  async function (req, res) {
    try {
      const body = req.body || {};

      // ── Customer (defaulted) ────────────────────────────────────────
      const customerId = isNonEmptyString(body.customerId)
        ? body.customerId.trim()
        : DEFAULT_CUSTOMER_ID;

      // ── Pricebook (optional) ────────────────────────────────────────
      // When omitted, Zoho uses the customer's default pricebook. Tools that
      // need a specific pricebook (e.g. Buzztech) pass one explicitly.
      const priceListId = isNonEmptyString(body.priceListId)
        ? body.priceListId.trim()
        : "";

      // ── Line items (required, non-empty) ────────────────────────────
      const rawLines = Array.isArray(body.lineItems) ? body.lineItems : [];
      const lineItems = rawLines.map(normalizeLineItem).filter(Boolean);
      if (lineItems.length === 0) {
        return res.status(400).json({
          success: false,
          message: "lineItems must be a non-empty array; each entry needs an itemId",
        });
      }

      // ── Optional fields ─────────────────────────────────────────────
      const date = isNonEmptyString(body.date)
        ? body.date.trim()
        : new Date().toISOString().split("T")[0];
      const notes = isNonEmptyString(body.notes) ? body.notes.trim() : undefined;
      const templateId = isNonEmptyString(body.templateId)
        ? body.templateId.trim()
        : undefined;
      const customFields = Array.isArray(body.customFields)
        ? body.customFields
        : undefined;

      const requestBody = {
        customer_id: customerId,
        date,
        line_items: lineItems,
      };
      if (priceListId) requestBody.pricebook_id = priceListId;
      if (notes !== undefined) requestBody.notes = notes;
      if (templateId !== undefined) requestBody.template_id = templateId;
      if (customFields !== undefined) requestBody.custom_fields = customFields;

      const zohoUrl = `https://www.zohoapis.com/inventory/v1/salesorders?organization_id=${ZOHO_ORG_ID}`;
      const zohoResp = await handleZohoInventoryPostRequest(zohoUrl, requestBody);

      if (!zohoResp || zohoResp.code !== 0 || !zohoResp.salesorder) {
        const msg =
          (zohoResp && zohoResp.message) ||
          "Zoho Inventory did not accept the order";
        console.error("Zoho SO create failed:", zohoResp);
        return res.status(502).json({
          success: false,
          message: `Zoho: ${msg}`,
          data: zohoResp || null,
        });
      }

      const so = zohoResp.salesorder;
      return res.status(201).json({
        success: true,
        message: `Sales order ${so.salesorder_number} created`,
        data: {
          salesOrderId: so.salesorder_id,
          salesOrderNumber: so.salesorder_number,
          salesOrder: so,
        },
      });
    } catch (error) {
      console.error("Standalone SO create error:", error);
      return res.status(500).json({
        success: false,
        message: `Failed to create sales order: ${error.message || error}`,
      });
    }
  },
);

// POST /zoho/salesOrder/attach
// Attach a single file to an existing Zoho sales order.
// Body (multipart/form-data):
//   salesOrderId  — the Zoho sales order id (required)
//   file          — the file to attach (required, max 25 MB)
// Used by the Buzztech import tool to staple the original PO PDF onto the
// generated SO; kept generic so any other tool can use it too.
router.post(
  "/attach",
  requirePermission("zoho:salesOrder:create"),
  upload.single("file"),
  async function (req, res) {
    try {
      const salesOrderId =
        req.body && req.body.salesOrderId
          ? String(req.body.salesOrderId).trim()
          : "";
      if (!salesOrderId) {
        return res.status(400).json({
          success: false,
          message: "salesOrderId is required",
        });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({
          success: false,
          message: "file is required (form field 'file')",
        });
      }

      // Zoho's attachment endpoint expects multipart with the file under the
      // field name `attachment`.
      const form = new FormData();
      form.append("attachment", req.file.buffer, {
        filename: req.file.originalname || "attachment",
        contentType: req.file.mimetype || "application/octet-stream",
      });

      const url = `https://www.zohoapis.com/inventory/v1/salesorders/${encodeURIComponent(salesOrderId)}/attachment?organization_id=${ZOHO_ORG_ID}`;
      const zohoResp = await handleZohoInventoryMultipartPostRequest(url, form);

      if (!zohoResp || zohoResp.code !== 0) {
        const msg =
          (zohoResp && zohoResp.message) ||
          "Zoho Inventory did not accept the attachment";
        console.error("Zoho SO attachment failed:", zohoResp);
        return res.status(502).json({
          success: false,
          message: `Zoho: ${msg}`,
          data: zohoResp || null,
        });
      }

      return res.json({
        success: true,
        message: `Attached ${req.file.originalname || "file"} to sales order`,
        data: { salesOrderId, response: zohoResp },
      });
    } catch (error) {
      console.error("Attach SO error:", error);
      return res.status(500).json({
        success: false,
        message: `Failed to attach file: ${error.message || error}`,
      });
    }
  },
);

module.exports = router;
