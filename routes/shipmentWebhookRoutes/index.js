// Inbound shipment webhook from Zoho Flow.
//
// When a sales order ships, Zoho Flow calls this endpoint with the delivery
// method + tracking number (plus the SO number and our caseId/ticketId, which
// it reads from the SO's custom fields). We attach those to the matching
// zohoOrders entry so the SQT case's "Sent Parts" tab can show them.
//
// Params (query string OR body — Zoho Flow sends query params):
//   soNumber        required — the Zoho salesorder_number
//   caseId          our case id (set as a custom field when we sent the parts)
//   ticketId        RepairDesk ticket id (fallback match)
//   shippingMethod  delivery method
//   trackingNumber  tracking number
//   shippmentStatus shipment status (Zoho's spelling; "status" also accepted)
//
// Public — Zoho Flow can't carry our JWT. Optional shared secret: if
// ZOHO_WEBHOOK_SECRET is set, the caller must send a matching x-webhook-secret
// header (or a `secret` param). Only ever updates existing orders, never
// creates data, so it's low-risk if left open.

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_cases";

// First non-empty value across query then body, trying each alias in order.
function pick(req, ...names) {
  for (const n of names) {
    const q = req.query ? req.query[n] : undefined;
    const b = req.body ? req.body[n] : undefined;
    const v = q != null && String(q).trim() !== "" ? q : b;
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

async function handleShipment(req, res) {
  try {
    const secret = process.env.ZOHO_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.get("x-webhook-secret") || pick(req, "secret");
      if (provided !== secret) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
    }

    const soNumber = pick(req, "soNumber", "salesorder_number");
    const caseId = pick(req, "caseId");
    const ticketId = pick(req, "ticketId");
    const shippingMethod = pick(req, "shippingMethod", "delivery_method");
    const trackingNumber = pick(req, "trackingNumber", "tracking_number");
    const shipmentStatus = pick(req, "shippmentStatus", "shipmentStatus", "status");

    if (!soNumber) {
      return res
        .status(400)
        .json({ success: false, message: "soNumber is required" });
    }

    const db = await connectToDatabase();
    const col = db.collection(COLLECTION);
    const now = new Date();

    // Each webhook is the authoritative snapshot of the order's shipping, so a
    // repeat webhook for the same SO replaces the details wholesale — fields not
    // provided are cleared. E.g. switching to "Pick Up" with no tracking blanks
    // a previously-set tracking number.
    const set = {
      updatedAt: now,
      "zohoOrders.$[o].shippingUpdatedAt": now,
      "zohoOrders.$[o].shippingMethod": shippingMethod || null,
      "zohoOrders.$[o].trackingNumber": trackingNumber || null,
      "zohoOrders.$[o].shipmentStatus": shipmentStatus || null,
    };

    const orderFilter = { "zohoOrders.zohoSalesOrderNumber": soNumber };
    const opts = {
      arrayFilters: [{ "o.zohoSalesOrderNumber": soNumber }],
      returnDocument: "after",
    };

    // Prefer the case identified by caseId (a custom field on the SO); fall
    // back to ticketId; the SO number is globally unique, so if neither lines
    // up we still match on it alone.
    const scoped = { ...orderFilter };
    if (caseId) scoped.caseId = caseId;
    else if (ticketId) scoped.repairDeskTicketId = ticketId;

    let result = await col.findOneAndUpdate(scoped, { $set: set }, opts);
    let updated = result ? result.value || result : null;

    if (!updated && (caseId || ticketId)) {
      result = await col.findOneAndUpdate(orderFilter, { $set: set }, opts);
      updated = result ? result.value || result : null;
    }

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: `No sales order "${soNumber}" found on any case`,
      });
    }

    return res.json({
      success: true,
      message: `Shipment details attached to ${soNumber}`,
      caseId: updated.caseId || null,
      soNumber,
    });
  } catch (error) {
    console.error("Shipment webhook error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to record shipment" });
  }
}

// Accept whatever method Zoho Flow is configured with (GET or POST).
router.all("/", handleShipment);

module.exports = router;
