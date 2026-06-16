var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../../utils/mongodb");

const {
  getViewData,
  handleZohoInventoryRequest,
  refreshToken,
} = require("../../../utils/zohoRequest");
const { requirePermission, requireAnyPermission } = require("../../../middleware/auth");

var productCollectionRoute = require("./routes/collections");

// Collections management belongs to the zoho Inventory area
router.use("/collections", requirePermission("zoho:collection:view"), productCollectionRoute);

// Resolve a SKU to its real Zoho Inventory item_id (Commerce product_id ≠
// Inventory item_id) and pull the Wholesale-pricebook rate. Used by the SQT
// Send Parts picker after the user selects a product from search.
// Shared by Send Parts (TechElite/Admin via sqt:case:sendParts) and Selection
// collections editing (iMobile Admin/Admin via zoho:collection:edit).
router.get("/skuLookup", requireAnyPermission("sqt:case:sendParts", "zoho:collection:edit"), async function (req, res, next) {
  try {
    const skuRaw = String(req.query.sku || "").trim();
    if (!skuRaw) {
      return res.status(400).json({ success: false, message: "sku is required" });
    }

    const WORKSPACE_ID = "1404913000003936002";
    const ITEMS_VIEW_ID = "1404913000003936100";
    const PRICES_VIEW_ID = "1404913000003936194";
    const WHOLESALE_PRICEBOOK_ID = "2591985000000103011";

    const buildUrl = (viewId, config) =>
      `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${viewId}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;

    // Escape single quotes for Zoho Analytics criteria
    const esc = (v) => String(v).replace(/'/g, "''");
    const safeSku = esc(skuRaw);

    // 1) SKU → Item ID
    const itemRows = await getViewData(buildUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ["Item ID", "SKU"],
      criteria: `"SKU" = '${safeSku}'`,
    }));
    if (!Array.isArray(itemRows) || itemRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No inventory item found for SKU "${skuRaw}"`,
      });
    }
    const itemId = itemRows[0]["Item ID"];
    if (!itemId) {
      return res.status(404).json({
        success: false,
        message: `Item ID missing for SKU "${skuRaw}"`,
      });
    }

    // 2) Item ID + Wholesale pricebook → PriceList Rate (may be empty)
    const priceRows = await getViewData(buildUrl(PRICES_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: ["PriceList Rate"],
      criteria: `"Product ID" = '${esc(itemId)}' AND "PriceList ID" = '${WHOLESALE_PRICEBOOK_ID}'`,
    }));
    let wholesalePrice = null;
    if (Array.isArray(priceRows) && priceRows.length > 0) {
      const raw = priceRows[0]["PriceList Rate"];
      // Values come back as either a number or a string like "AUD 123.45"
      const n = parseFloat(String(raw == null ? "" : raw).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) wholesalePrice = n;
    }

    return res.json({
      success: true,
      data: {
        itemId: String(itemId),
        sku: skuRaw,
        wholesalePrice,
      },
    });
  } catch (error) {
    console.error("SKU lookup error:", error);
    return res
      .status(500)
      .json({ success: false, message: `SKU lookup failed: ${error.message || error}` });
  }
});

// Bulk SKU → Item ID resolver. Exact match (unlike /skuMatches which is
// a LIKE search), one Analytics query per chunk of 100 SKUs rather than
// one per SKU — so the Create Oz Order flow can resolve a whole order's
// worth of matched SKUs to Zoho item_ids without an N-round-trip storm.
// Pre-warms the access token before fanning out for the same reason the
// /skuMatches endpoint does.
//
// Body: { skus: ["21280", "13261", ...] }
// Resp: { success, data: { "21280": { itemId, sku }, "missing": null, ... } }
//        — a sku with no inventory match maps to null so the caller can
//          flag it rather than silently dropping the line.
router.post(
  "/skuLookupBulk",
  requireAnyPermission("zoho:salesOrder:create", "zoho:collection:edit"),
  async function (req, res) {
    try {
      const incoming = Array.isArray(req.body && req.body.skus) ? req.body.skus : [];
      const unique = [
        ...new Set(
          incoming
            .filter((s) => s != null)
            .map((s) => String(s).trim())
            .filter(Boolean),
        ),
      ];
      if (unique.length === 0) {
        return res.json({ success: true, data: {} });
      }

      const WORKSPACE_ID = "1404913000003936002";
      const ITEMS_VIEW_ID = "1404913000003936100";
      const esc = (v) => String(v).replace(/'/g, "''");
      const buildUrl = (config) =>
        `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${ITEMS_VIEW_ID}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;

      // Proactive refresh so the parallel chunk queries below don't each
      // trip their own 7309-refresh and get throttled.
      try {
        await refreshToken();
      } catch (e) {
        console.warn("skuLookupBulk token pre-warm failed:", e.message || e);
      }

      // Chunk into IN clauses of 100 so the Analytics criteria stays a
      // sane length for large orders.
      const chunks = [];
      for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));

      const data = {};
      // Seed every requested sku to null so unmatched ones are explicit.
      for (const s of unique) data[s] = null;

      const responses = await Promise.all(
        chunks.map((chunk) => {
          const inList = chunk.map((s) => `'${esc(s)}'`).join(",");
          return getViewData(
            buildUrl({
              responseFormat: "json",
              selectedColumns: ["Item ID", "SKU"],
              criteria: `"SKU" IN (${inList})`,
            }),
          );
        }),
      );

      for (const rows of responses) {
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          const sku = r && r.SKU != null ? String(r.SKU) : "";
          const itemId = r && r["Item ID"] != null ? String(r["Item ID"]) : "";
          if (sku && itemId && Object.prototype.hasOwnProperty.call(data, sku)) {
            data[sku] = { itemId, sku };
          }
        }
      }

      return res.json({ success: true, data });
    } catch (error) {
      console.error("Bulk SKU lookup error:", error);
      return res
        .status(500)
        .json({ success: false, message: `Bulk SKU lookup failed: ${error.message || error}` });
    }
  },
);

// Resolve a scanned code (SKU or barcode) to its Zoho Inventory item.
// Tries the SKU column first; if no match, falls back to the Barcode
// column (vendor / manufacturer barcode). Returns the matched item plus
// a `matchedBy` flag so the caller knows which column hit — useful when
// the same string is being treated as either a SKU or a barcode and you
// want to keep that distinction in audit data.
router.get("/scanLookup", requireAnyPermission("sqt:case:sendParts", "zoho:collection:edit"), async function (req, res, next) {
  try {
    const codeRaw = String(req.query.code || "").trim();
    if (!codeRaw) {
      return res.status(400).json({ success: false, message: "code is required" });
    }

    const WORKSPACE_ID = "1404913000003936002";
    const ITEMS_VIEW_ID = "1404913000003936100";

    const buildUrl = (viewId, config) =>
      `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${viewId}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;
    const esc = (v) => String(v).replace(/'/g, "''");
    const safe = esc(codeRaw);
    const columns = ["Item ID", "SKU", "Item Name", "Status"];

    // 1) Try SKU first — most scans of our own product labels match here.
    let rows = await getViewData(buildUrl(ITEMS_VIEW_ID, {
      responseFormat: "json",
      selectedColumns: columns,
      criteria: `"SKU" = '${safe}'`,
    }));
    let matchedBy = "sku";

    // 2) Fall back to the Barcode column (vendor / manufacturer barcode).
    //    If the view doesn't have a Barcode column, this query errors —
    //    swallow it and treat as "no match" rather than 500.
    if (!Array.isArray(rows) || rows.length === 0) {
      try {
        rows = await getViewData(buildUrl(ITEMS_VIEW_ID, {
          responseFormat: "json",
          selectedColumns: columns,
          criteria: `"Barcode" = '${safe}'`,
        }));
        matchedBy = "barcode";
      } catch (e) {
        // No Barcode column — leave rows as-is.
      }
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No product found for code "${codeRaw}"`,
      });
    }

    const item = rows[0];
    return res.json({
      success: true,
      data: {
        itemId: item["Item ID"] ? String(item["Item ID"]) : "",
        sku: item.SKU || "",
        name: item["Item Name"] || "",
        status: item.Status || "",
        scanCode: codeRaw,
        matchedBy,
      },
    });
  } catch (error) {
    console.error("Scan lookup error:", error);
    return res
      .status(500)
      .json({ success: false, message: `Scan lookup failed: ${error.message || error}` });
  }
});

// Bulk SKU LIKE-search for the Credit Note review dialog. Takes a list
// of OCR-extracted SKUs and returns, per input SKU, every Active Zoho
// item whose SKU contains it as a substring. The dialog uses these to
// populate per-row pickers so the user can disambiguate when OCR gives
// a partial (e.g. "5470" → "5470-RED", "5470-BLU", …).
//
// Same Tools-page permission gate as the credit-note submit flow —
// admin and iMobile Admin both already qualify.
router.post(
  "/skuMatches",
  requirePermission("zoho:salesOrder:create"),
  async function (req, res) {
    try {
      const incoming = Array.isArray(req.body && req.body.skus)
        ? req.body.skus
        : [];
      // De-dupe + drop empty / non-string entries up front so we don't
      // fire identical queries multiple times for a duplicated OCR row.
      const unique = [
        ...new Set(
          incoming
            .filter((s) => typeof s === "string")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (unique.length === 0) {
        return res.json({ success: true, data: {} });
      }

      // Proactively refresh the Zoho access token before fanning out.
      // The reactive refresh inside getViewData has a race window: the
      // first call's 7309 triggers a refresh, the refresh completes
      // and clears the in-flight gate, then slower parallel calls
      // (still in flight with the stale token) return 7309 too and
      // each trigger their own refresh — Zoho's OAuth endpoint
      // throttles the burst with "Access Denied". One refresh up
      // front means every parallel call below sees a fresh token.
      // Best-effort: if the refresh fails the per-call handlers still
      // retry with their own dedupe, so the worst case is the
      // original behaviour.
      try {
        await refreshToken();
      } catch (e) {
        console.warn("skuMatches token pre-warm failed:", e.message || e);
      }

      const WORKSPACE_ID = "1404913000003936002";
      const ITEMS_VIEW_ID = "1404913000003936100";
      // Cap so a one-letter substring like "a" doesn't return thousands
      // of rows — el-select with `filterable` will still let the user
      // narrow further on the client.
      const MAX_MATCHES_PER_SKU = 25;

      // Escape Zoho Analytics single-quote literal syntax.
      const esc = (v) => String(v).replace(/'/g, "''");

      const buildUrl = (config) =>
        `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${ITEMS_VIEW_ID}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;

      const lookupOne = async (sku) => {
        const safe = esc(sku);
        try {
          const rows = await getViewData(
            buildUrl({
              responseFormat: "json",
              selectedColumns: ["Item ID", "SKU", "Item Name", "Status"],
              // Active-only so the dropdown isn't polluted with
              // discontinued items the user can't actually use.
              criteria: `"SKU" LIKE '%${safe}%' AND "Status" = 'Active'`,
            }),
          );
          if (!Array.isArray(rows)) return [];
          return rows
            .slice(0, MAX_MATCHES_PER_SKU)
            .map((r) => ({
              itemId: r["Item ID"] ? String(r["Item ID"]) : "",
              sku: r.SKU || "",
              name: r["Item Name"] || "",
              status: r.Status || "",
            }))
            .filter((m) => m.itemId);
        } catch (e) {
          // One bad lookup shouldn't kill the whole batch — log it and
          // return an empty list so the dialog can still render the
          // other rows.
          console.warn(
            `[skuMatches] lookup failed for sku=${sku}:`,
            e.message || e,
          );
          return [];
        }
      };

      // Fan out — Zoho Analytics handles small parallel bursts fine and
      // the dialog blocks on this anyway, so faster is better.
      const matches = await Promise.all(unique.map(lookupOne));
      const data = {};
      unique.forEach((sku, i) => {
        data[sku] = matches[i];
      });
      return res.json({ success: true, data });
    } catch (error) {
      console.error("skuMatches error:", error);
      return res.status(500).json({
        success: false,
        message: `SKU match lookup failed: ${error.message || error}`,
      });
    }
  },
);

// Product search powers the SQT "Send Parts" picker (TechElite/Admin) and the
// Selection collections picker (iMobile Admin/Admin).
router.get("/searchProduct", requireAnyPermission("sqt:case:sendParts", "zoho:collection:edit"), async function (req, res, next) {
  const keyword = req.query.keyword;
  const domainName = process.env.DOMAIN_NAME;
  if (!keyword || !domainName) {
    res.status(200).send(
      JSON.stringify({
        code: -1,
        success: false,
        mgs: "Missing parameter",
      }),
    );
    return;
  }
  const searchUrl = `https://commerce.zoho.com/storefront/api/v1/search-products?q=${keyword}`;
  const searchResult = await axios.get(searchUrl, {
    headers: { "domain-name": domainName },
  });
  const data = searchResult.data;
  if (data.status_code == 0) {
    //success
    res.send(
      JSON.stringify({
        code: 0,
        success: true,
        msg: "",
        // Expand multi-variant products into one row per variant so
        // the autocomplete picker shows each shoppable SKU
        // independently. See expandProductVariants() below.
        data: expandProductVariants(data.payload && data.payload.products),
      }),
    );
  } else {
    res.status(200).send(
      JSON.stringify({
        code: -1,
        success: false,
        mgs: "Something is wrong.",
      }),
    );
  }
});

// Zoho Commerce returns one row per PRODUCT, with multi-variant
// products carrying their per-variant SKUs in `variants[]`. Variants
// are distinct items on the Zoho Inventory side (different
// item_ids, different stock levels), so the picker has to surface
// them as separate options — otherwise "iPhone 13" lands as one row
// and the user can only ever pick the first variant's SKU.
//
// Flatten the response: products with no variants pass through
// unchanged; products with variants emit one row per variant. Each
// expanded row carries the variant's SKU as the top-level `sku`
// (so existing consumers reading `p.sku` Just Work), a combined
// product+variant display name, and a `variant_id` for any caller
// that needs to round-trip back to the original variant. Other
// product-level fields (`documents`, `images`, `product_id`, etc.)
// are preserved verbatim so the picker thumbnails still render.
function expandProductVariants(products) {
  const out = [];
  if (!Array.isArray(products)) return out;
  for (const p of products) {
    if (!p) continue;
    const variants = Array.isArray(p.variants) ? p.variants : [];
    if (variants.length === 0) {
      // No variants — pass through. Drop the empty variants array
      // to keep the response shape consistent with expanded rows.
      const { variants: _v, ...rest } = p;
      out.push(rest);
      continue;
    }
    for (const v of variants) {
      if (!v) continue;
      const variantSku = String(
        v.sku || v.variant_sku || ""
      ).trim();
      // Skip variants without an actual SKU — they can't be picked /
      // ordered anyway, and emitting an empty-sku row would confuse
      // the downstream filter chain.
      if (!variantSku) continue;
      // Strip the full variants array off each expanded row — it'd
      // otherwise repeat the same array on every expanded sibling
      // and bloat the response.
      const { variants: _v, ...productRest } = p;
      out.push({
        ...productRest,
        sku: variantSku,
        name: combinedDisplayName(p.name, v.name || v.variant_name),
        variant_id: v.variant_id || v.id || null,
        // Keep the variant payload itself in case a consumer wants
        // attribute info (size / colour / etc.) without re-fetching.
        variant: v,
      });
    }
  }
  return out;
}

// Build a display name that fuses product + variant without ending
// up with "iPhone 13 — iPhone 13" when Zoho returned the same
// string for both. Conservative: when the variant name is empty,
// identical to the product, or already starts with the product
// name, we trust whatever's longest rather than concatenating.
function combinedDisplayName(productName, variantName) {
  const p = String(productName || "").trim();
  const v = String(variantName || "").trim();
  if (!v) return p;
  if (!p) return v;
  if (v === p) return p;
  if (v.startsWith(p + " ")) return v;
  if (p.includes(v)) return p;
  return `${p} — ${v}`;
}


const priceListIdMap = {
  VIP: "2591985000000103001",
  SVIP: "2591985000078196985",
  Platinum: "2591985000001439015",
  WholeSale: "2591985000000103011",
};

router.get("/getProductDetail/:id", requirePermission("zoho:stock:view"), async function (req, res, next) {
  const { id } = req.params;
  const url = `https://www.zohoapis.com/inventory/v1/items/${id}?organization_id=746138234`;

  const productDetail = await handleZohoInventoryRequest(url);
const item = productDetail.item
const customFieldsMapped = Object.fromEntries(
  item.custom_fields.map(f => [f.label, f.value])
)

   const getPriceConfig = {
        responseFormat: "json",
        criteria: `"Product ID" = '${id}'`,
        selectedColumns: ["PriceList ID", "Product ID", "PriceList Rate"],
      };
      const encodedConfig = encodeURIComponent(JSON.stringify(getPriceConfig));
      const getPriceUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936194/data?CONFIG=${encodedConfig}`;

      const priceListData = await getViewData(getPriceUrl);
const prices = Object.entries(priceListIdMap).reduce((acc, [key, id]) => {
  const found = priceListData.find(item => item["PriceList ID"] === id)

  acc[key.toLowerCase()] = found
    ? Number(
        found["PriceList Rate"]
          .replace("AUD", "")
          .replace(/,/g, "")
          .trim()
      )
    : null

  return acc
}, {})

  const date = new Date();
  date.setDate(date.getDate() - 90);
  const formattedDate = date.toISOString().split("T")[0];

 const zohoSalesconfig = {
    responseFormat: "json",
    selectedColumns: [ "Quantity", "Created Time"],
    criteria: `"Product ID" = '${id}' AND "Created Time" >= '${formattedDate}'`,
  };

  const zohoSalesEncoded = encodeURIComponent(JSON.stringify(zohoSalesconfig));
  const zohoSalesUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936103/data?CONFIG=${zohoSalesEncoded}`;

  const zohoSalesData = await getViewData(zohoSalesUrl);

  // Inflow (offline) sales — same approach as /zoho/salesTotal but for a single
  // product: fetch adjustment rows, look up their reasons, keep only the two
  // reasons that represent real consumption, and flip the sign so consumption
  // shows as a positive quantity (matching the zoho-sales shape).
  const VALID_INFLOW_REASONS = new Set([
    "iMobile Repair Team",
    "Inflow Recurring Adjustment",
  ]);

  const inflowConfig = {
    responseFormat: "json",
    selectedColumns: [
      "Inventory Adjustment ID",
      "Quantity Adjusted",
      "Created Time",
    ],
    criteria: `"Product ID" = '${id}' AND "Created Time" >= '${formattedDate}'`,
  };
  const inflowEncoded = encodeURIComponent(JSON.stringify(inflowConfig));
  const inflowUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936206/data?CONFIG=${inflowEncoded}`;
  const inflowRaw = await getViewData(inflowUrl);

  let inflowSales = [];
  if (Array.isArray(inflowRaw) && inflowRaw.length > 0) {
    const adjustmentIds = [
      ...new Set(
        inflowRaw.map((r) => r["Inventory Adjustment ID"]).filter(Boolean)
      ),
    ];

    let reasonMap = {};
    if (adjustmentIds.length > 0) {
      const inClause = adjustmentIds
        .map((aid) => `'${String(aid).replace(/'/g, "''")}'`)
        .join(",");
      const reasonConfig = {
        responseFormat: "json",
        selectedColumns: ["Inventory Adjustment ID", "Reason"],
        criteria: `"Inventory Adjustment ID" IN (${inClause})`,
      };
      const reasonEncoded = encodeURIComponent(JSON.stringify(reasonConfig));
      const reasonUrl = `https://analyticsapi.zoho.com/restapi/v2/workspaces/1404913000003936002/views/1404913000003936086/data?CONFIG=${reasonEncoded}`;
      const reasonData = await getViewData(reasonUrl);
      reasonMap = Object.fromEntries(
        (reasonData || []).map((r) => [r["Inventory Adjustment ID"], r.Reason])
      );
    }

    inflowSales = inflowRaw
      .filter((r) =>
        VALID_INFLOW_REASONS.has(reasonMap[r["Inventory Adjustment ID"]])
      )
      .map((r) => ({
        "Created Time": r["Created Time"],
        Quantity: (Number(r["Quantity Adjusted"]) || 0) * -1,
      }));
  }

const result = {
    item_id: item.item_id,
    name: item.name,
    sku: item.sku,
    imgUrl: item.documents[0]?`https://www.imobilestore.com.au/product-images/${item.documents[0].file_name}/${item.documents[0].document_id}/600x600`:"",
    status: item.status,
    physicalStock: {
          stockOnHand: item.actual_available_stock,
        commitedStock: item.actual_committed_stock,
        avaliableStock: item.actual_available_for_sale_stock,

    },
    priceList: prices,
    sales: zohoSalesData,
    inflowSales,
    ...customFieldsMapped


}
  return res.json(result);
});

module.exports = router;
