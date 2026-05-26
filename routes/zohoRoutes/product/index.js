var express = require("express");
var axios = require("axios");
var router = express.Router();
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../../utils/mongodb");

const {
  getViewData,
  handleZohoInventoryRequest,
} = require("../../../utils/zohoRequest");
const { requirePermission } = require("../../../middleware/auth");

var productCollectionRoute = require("./routes/collections");

// Collections management belongs to the zoho Inventory area
router.use("/collections", requirePermission("zoho:collection:view"), productCollectionRoute);

// Resolve a SKU to its real Zoho Inventory item_id (Commerce product_id ≠
// Inventory item_id) and pull the Wholesale-pricebook rate. Used by the SQT
// Send Parts picker after the user selects a product from search.
router.get("/skuLookup", requirePermission("sqt:case:sendParts"), async function (req, res, next) {
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

// Product search powers the SQT "Send Parts" picker (TechElite/Admin)
router.get("/searchProduct", requirePermission("sqt:case:sendParts"), async function (req, res, next) {
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
        data: data.payload.products,
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
