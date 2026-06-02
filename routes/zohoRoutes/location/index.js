// Location Monitoring — search inventory by physical Location custom field
// and move items between locations. Backs the /tools/locationMonitoring page.
//
// Three endpoints:
//   GET  /zoho/location/list                 — distinct Location values
//   GET  /zoho/location/items                — items at a given Location
//                                              (?location=X[&search=Y])
//   PUT  /zoho/location/items/:itemId        — update an item's Location
//                                              (body: { location: "..." })

var express = require("express");
var router = express.Router();
const {
  getViewData,
  handleZohoInventoryRequest,
  handleZohoInventoryPutRequest,
} = require("../../../utils/zohoRequest");
const { requirePermission } = require("../../../middleware/auth");

const ZOHO_ORG_ID = "746138234";
const WORKSPACE_ID = "1404913000003936002";
const ITEMS_VIEW_ID = "1404913000003936100";
const BATCH_SIZE = 100;

// Same Tools-page permission used by /zoho/salesOrder/create — Admin via
// *:*:* and iMobile Admin via zoho:*:* both qualify.
const GATE = requirePermission("zoho:salesOrder:create");

function buildAnalyticsUrl(viewId, config) {
  return `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${viewId}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;
}

function chunk(arr, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Custom-field ID resolution for "Location" ─────────────────────────────
// Zoho Inventory's item-update PUT needs the customfield_id (not the label).
// We discover it by reading one item's full record and caching the result
// for the process lifetime. If you swap the field's id you'll just need to
// bounce the server.

let cachedLocationFieldId = null;

async function resolveLocationFieldId(seedItemId) {
  if (cachedLocationFieldId) return cachedLocationFieldId;
  if (!seedItemId) return null;
  const url = `https://www.zohoapis.com/inventory/v1/items/${seedItemId}?organization_id=${ZOHO_ORG_ID}`;
  const resp = await handleZohoInventoryRequest(url);
  const item = resp && resp.item;
  if (!item || !Array.isArray(item.custom_fields)) return null;
  const field = item.custom_fields.find((f) => f && f.label === "Location");
  if (field && field.customfield_id) {
    cachedLocationFieldId = String(field.customfield_id);
    return cachedLocationFieldId;
  }
  return null;
}

// ── GET /zoho/location/list ──────────────────────────────────────────────
// Returns the unique non-empty Location values present on items in the
// Analytics view. Sorted alphabetically.
router.get("/list", GATE, async function (req, res) {
  try {
    const url = buildAnalyticsUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ["Location"],
    });
    const rows = await getViewData(url);
    if (!Array.isArray(rows)) {
      return res.json({ success: true, data: [] });
    }
    const set = new Set();
    for (const r of rows) {
      const v = String((r && r.Location) || "").trim();
      if (v) set.add(v);
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b));
    return res.json({ success: true, data: list });
  } catch (error) {
    console.error("Location list error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Failed to load locations: ${error.message || error}` });
  }
});

// ── GET /zoho/location/items?location=X[&search=Y] ───────────────────────
// Items at the given Location, hydrated with live stock from the Inventory
// itemdetails endpoint. `search` is a case-insensitive substring filter
// on name + SKU applied AFTER the Location match (Zoho Analytics doesn't
// give us a nice LIKE/CONTAINS operator we can rely on across columns).
//
// The criteria mirrors the production filter used in the reference
// /getItemsByLocation endpoint: only Active items, excluding Special Order
// / Internal Sales Use Only entries, blank or placeholder SKUs, and the
// "item no code" catch-all.
router.get("/items", GATE, async function (req, res) {
  try {
    const location = String(req.query.location || "").trim();
    const search = String(req.query.search || "").trim().toLowerCase();
    if (!location) {
      return res.status(400).json({ success: false, message: "location is required" });
    }
    const safe = location.replace(/'/g, "''");

    // Pull Item IDs from Analytics where Location matches and the row
    // passes the exclusion filter.
    const url = buildAnalyticsUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ["Item ID", "SKU", "Item Name", "Status"],
      criteria:
        `"Status" = 'Active' ` +
        `AND "Location" = '${safe}' ` +
        `AND "Item Name" NOT LIKE '%Special Order%' ` +
        `AND "Item Name" NOT LIKE '%Internal Sales Use Only%' ` +
        `AND "SKU" IS NOT NULL ` +
        `AND "SKU" != '00000' ` +
        `AND "Item Name" != 'item no code'`,
    });
    const rows = await getViewData(url);
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.json({ success: true, data: { location, items: [] } });
    }

    // Optional in-memory filter so we don't have to bulk-fetch items the
    // user is clearly not interested in.
    let candidates = rows;
    if (search) {
      candidates = rows.filter((r) => {
        const name = String(r["Item Name"] || "").toLowerCase();
        const sku = String(r.SKU || "").toLowerCase();
        return name.includes(search) || sku.includes(search);
      });
    }
    if (candidates.length === 0) {
      return res.json({ success: true, data: { location, items: [] } });
    }

    const itemIds = [
      ...new Set(candidates.map((c) => c["Item ID"]).filter(Boolean)),
    ];

    // Hydrate via Inventory itemdetails (batched). Gives us live stock
    // numbers + the canonical Location custom-field value, which we use
    // as the displayed location (the Analytics value can briefly lag).
    const batches = chunk(itemIds, BATCH_SIZE);
    const responses = await Promise.all(
      batches.map((batch) => {
        const idsParam = batch.join(",");
        const detailsUrl =
          `https://www.zohoapis.com/inventory/v1/itemdetails` +
          `?item_ids=${encodeURIComponent(idsParam)}` +
          `&organization_id=${ZOHO_ORG_ID}`;
        return handleZohoInventoryRequest(detailsUrl);
      }),
    );
    const allItems = responses.flatMap((r) =>
      Array.isArray(r && r.items) ? r.items : [],
    );

    const items = allItems
      .map((item) => {
        const loc = (item.custom_fields || []).find((c) => c.label === "Location");
        // Inventory items expose the primary image as `image_document_id`.
        // The zbfs URL is served by Zoho with the org id as a query param —
        // works for both authenticated and unauthenticated callers as long
        // as the org's image privacy settings allow it.
        const imageUrl = item.image_document_id
          ? `https://inventory.zoho.com/DocTemplates_ItemImage_${item.image_document_id}.zbfs?organization_id=${ZOHO_ORG_ID}`
          : "";
        return {
          itemId: item.item_id,
          name: item.name,
          sku: item.sku,
          status: item.status,
          imageUrl,
          location: (loc && loc.value) || "",
          // Use the API's actual_available_for_sale_stock as-is — it already
          // accounts for commitments under the hood, so we don't subtract
          // the committed-stock value a second time.
          stock: Number(item.actual_available_for_sale_stock || 0),
        };
      })
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    return res.json({ success: true, data: { location, items } });
  } catch (error) {
    console.error("Location items error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Failed to load items: ${error.message || error}` });
  }
});

// NB: Product *search* lives at /zoho/product/searchProduct — Location
// Monitoring reuses that endpoint (via `searchProducts` from
// @/api/zoho/products/product) rather than maintaining a parallel Commerce
// caller here. Once the user picks a result, /productLocation below
// resolves the SKU to an Inventory item + Location.

// ── GET /zoho/location/productLocation?sku=X ─────────────────────────────
// Resolve a Commerce-sourced product (by SKU) to its Inventory item id +
// current Location custom-field value. Two-hop through the Inventory API:
//   1. /items?sku=X            → discover the item_id (Commerce product_id
//                                 doesn't match Inventory item_id)
//   2. /itemdetails?item_ids=X → fetch the full record (custom_fields are
//                                 only on the detail endpoint, not the
//                                 list endpoint)
// We deliberately read Location from Inventory rather than the Analytics
// view because Analytics lags by several minutes — opening a panel for a
// stale location would scroll past the item the user just searched for.
router.get("/productLocation", GATE, async function (req, res) {
  try {
    const sku = String(req.query.sku || "").trim();
    if (!sku) {
      return res
        .status(400)
        .json({ success: false, message: "sku is required" });
    }

    const listUrl =
      `https://www.zohoapis.com/inventory/v1/items` +
      `?organization_id=${ZOHO_ORG_ID}` +
      `&sku=${encodeURIComponent(sku)}`;
    const listResp = await handleZohoInventoryRequest(listUrl);
    const items = Array.isArray(listResp && listResp.items) ? listResp.items : [];
    if (items.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No inventory item found for SKU "${sku}"`,
      });
    }
    const itemId = items[0].item_id ? String(items[0].item_id) : "";
    if (!itemId) {
      return res.status(404).json({
        success: false,
        message: `Item ID missing for SKU "${sku}"`,
      });
    }

    const detailsUrl =
      `https://www.zohoapis.com/inventory/v1/itemdetails` +
      `?item_ids=${itemId}` +
      `&organization_id=${ZOHO_ORG_ID}`;
    const detailsResp = await handleZohoInventoryRequest(detailsUrl);
    const detail = Array.isArray(detailsResp && detailsResp.items)
      ? detailsResp.items[0]
      : null;
    if (!detail) {
      return res.status(404).json({
        success: false,
        message: `Item details unavailable for SKU "${sku}"`,
      });
    }

    const locField = (detail.custom_fields || []).find(
      (c) => c && c.label === "Location",
    );
    const location = locField && locField.value ? String(locField.value) : "";

    return res.json({
      success: true,
      data: {
        itemId,
        sku: detail.sku || sku,
        name: detail.name || items[0].name || "",
        location,
        status: detail.status || items[0].status || "",
      },
    });
  } catch (error) {
    console.error("Location productLocation error:", error);
    return res.status(500).json({
      success: false,
      message: `Failed to resolve product location: ${error.message || error}`,
    });
  }
});

// ── PUT /zoho/location/items/:itemId ─────────────────────────────────────
// Update the Location custom field on an item. Body: { location: "..." }.
// On first call we resolve the Location custom-field's customfield_id by
// reading the target item and caching it for the process lifetime.
router.put("/items/:itemId", GATE, async function (req, res) {
  try {
    const itemId = String(req.params.itemId || "").trim();
    const newLocation = String((req.body && req.body.location) || "").trim();
    if (!itemId) {
      return res.status(400).json({ success: false, message: "itemId is required" });
    }
    if (!newLocation) {
      return res
        .status(400)
        .json({ success: false, message: "location is required (use a non-empty string)" });
    }

    const fieldId = await resolveLocationFieldId(itemId);
    if (!fieldId) {
      return res.status(500).json({
        success: false,
        message:
          "Could not resolve the Location custom-field id from Zoho. Check that the item has a 'Location' custom field.",
      });
    }

    const url = `https://www.zohoapis.com/inventory/v1/items/${itemId}?organization_id=${ZOHO_ORG_ID}`;
    const body = {
      custom_fields: [{ customfield_id: fieldId, value: newLocation }],
    };
    const resp = await handleZohoInventoryPutRequest(url, body);

    if (!resp || resp.code !== 0) {
      const msg =
        (resp && (resp.message || (resp.error && resp.error.message))) ||
        "Zoho did not accept the location update";
      console.error("Location update failed:", resp);
      return res
        .status(502)
        .json({ success: false, message: `Zoho: ${msg}`, data: resp || null });
    }

    return res.json({
      success: true,
      message: `Moved to ${newLocation}`,
      data: {
        itemId,
        location: newLocation,
        item: resp.item || null,
      },
    });
  } catch (error) {
    console.error("Location PUT error:", error);
    return res.status(500).json({
      success: false,
      message: `Failed to update location: ${error.message || error}`,
    });
  }
});

module.exports = router;
