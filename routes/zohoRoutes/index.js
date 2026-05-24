var express = require("express");
var router = express.Router();
var productRouter = require("./product/index");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const { categoriesQueryMap } = require("../../constants");
const {
  getViewData,
  handleZohoInventoryRequest,
} = require("../../utils/zohoRequest");
const { requirePermission } = require("../../middleware/auth");

/* GET home page. */
router.get("/", function (req, res, next) {
  res.render("index", { title: "Express" });
});

router.use("/product", productRouter);

router.get("/collectionStocks", requirePermission("zoho:stock:view"), async function (req, res, next) {
  try {
    const { collection } = req.query;

    const collectionId = Array.isArray(collection) ? collection[0] : collection;

    if (!collectionId || !ObjectId.isValid(collectionId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid collection id",
      });
    }

    const db = await connectToDatabase();
    const productCollections = db.collection("productCollections");

    const collectionData = await productCollections.findOne({
      _id: new ObjectId(collectionId),
    });

    if (!collectionData) {
      return res.status(404).json({
        success: false,
        message: "Collection not found",
      });
    }

    if (collectionData.type !== "Criteria") {
      return res.json([]);
    }

    const criteria = collectionData?.rules?.[0]?.criteria?.equals;

    if (!criteria) {
      return res.status(400).json({
        success: false,
        message: "Collection criteria not found",
      });
    }

    const WORKSPACE_ID = "1404913000003936002";
    const VIEW_ID = "1404913000003936100";
    const ORGANIZATION_ID = "746138234";
    const BATCH_SIZE = 100;

    const chunkArray = (arr, size = 100) => {
      const chunks = [];

      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }

      return chunks;
    };

    const buildZohoAnalyticsUrl = (viewId, config) => {
      const encoded = encodeURIComponent(JSON.stringify(config));

      return `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}/views/${viewId}/data?CONFIG=${encoded}`;
    };

    const config = {
      responseFormat: "json",
      selectedColumns: ["Item ID"],
      criteria,
    };

    const url = buildZohoAnalyticsUrl(VIEW_ID, config);

    const viewData = await getViewData(url);

    if (!Array.isArray(viewData) || viewData.length === 0) {
      return res.json([]);
    }

    const itemIds = [
      ...new Set(viewData.map((item) => item["Item ID"]).filter(Boolean)),
    ];

    if (itemIds.length === 0) {
      return res.json([]);
    }

    const itemIdBatches = chunkArray(itemIds, BATCH_SIZE);

    const productDetailResponses = await Promise.all(
      itemIdBatches.map((batchIds) => {
        const itemIdsParam = batchIds.join(",");

        const url =
          `https://www.zohoapis.com/inventory/v1/itemdetails` +
          `?item_ids=${encodeURIComponent(itemIdsParam)}` +
          `&organization_id=${ORGANIZATION_ID}`;

        return handleZohoInventoryRequest(url);
      }),
    );

    const allItems = productDetailResponses.flatMap((resp) =>
      Array.isArray(resp?.items) ? resp.items : [],
    );

    const result = allItems
      .map((item) => {
        const locationField = item.custom_fields?.find(
          (c) => c.label === "Location",
        );

        return {
          id: item.item_id,
          sku: item.sku,
          productName: item.name,
          location: locationField?.value || "",
          stock:
            Number(item.actual_available_for_sale_stock || 0) -
            Number(item.actual_committed_stock || 0),
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName));

    return res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/salesTotal", requirePermission("zoho:stock:view"), async function (req, res, next) {
  try {
    const { itemIds, duration = 30 } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.json({ result: [] });
    }

    const BATCH_SIZE = 100;
    const workspaceId = "1404913000003936002";

    const formattedDate = new Date(Date.now() - duration * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const chunkArray = (arr, size = 100) => {
      const chunks = [];

      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }

      return chunks;
    };

    const buildInClause = (ids) =>
      ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(",");

    const buildZohoUrl = (viewId, config) => {
      const encoded = encodeURIComponent(JSON.stringify(config));

      return `https://analyticsapi.zoho.com/restapi/v2/workspaces/${workspaceId}/views/${viewId}/data?CONFIG=${encoded}`;
    };

    const itemIdBatches = chunkArray(itemIds, BATCH_SIZE);

    let zohoSalesData = [];
    let offLineSalesData = [];

    // fetch all batches
    for (const batchIds of itemIdBatches) {
      const inClause = buildInClause(batchIds);

      const salesUrl = buildZohoUrl("1404913000003936103", {
        responseFormat: "json",
        selectedColumns: ["Product ID", "Quantity", "Created Time"],
        criteria: `("Product ID" IN (${inClause})) AND ("Created Time" >= '${formattedDate}')`,
      });

      const offlineUrl = buildZohoUrl("1404913000003936206", {
        responseFormat: "json",
        selectedColumns: [
          "Product ID",
          "Inventory Adjustment ID",
          "Quantity Adjusted",
          "Created Time",
        ],
        criteria: `("Product ID" IN (${inClause})) AND ("Created Time" >= '${formattedDate}')`,
      });

      const [salesBatch, offlineBatch] = await Promise.all([
        getViewData(salesUrl),
        getViewData(offlineUrl),
      ]);

      zohoSalesData.push(...salesBatch);
      offLineSalesData.push(...offlineBatch);
    }

    const adjustmentIds = [
      ...new Set(
        offLineSalesData
          .map((item) => item["Inventory Adjustment ID"])
          .filter(Boolean),
      ),
    ];

    let reasonMap = {};

    if (adjustmentIds.length > 0) {
      const adjustmentBatches = chunkArray(adjustmentIds, BATCH_SIZE);

      let adjustmentData = [];

      for (const batchIds of adjustmentBatches) {
        const inClause = buildInClause(batchIds);

        const adjustmentUrl = buildZohoUrl("1404913000003936086", {
          responseFormat: "json",
          selectedColumns: ["Inventory Adjustment ID", "Reason"],
          criteria: `"Inventory Adjustment ID" IN (${inClause})`,
        });

        const batchData = await getViewData(adjustmentUrl);

        adjustmentData.push(...batchData);
      }

      reasonMap = Object.fromEntries(
        adjustmentData.map((item) => [
          item["Inventory Adjustment ID"],
          item.Reason,
        ]),
      );
    }

    const validOfflineReasons = new Set([
      "iMobile Repair Team",
      "Inflow Recurring Adjustment",
    ]);

    const resultMap = {};

    // zoho sales
    for (const item of zohoSalesData) {
      const id = item["Product ID"];
      const qty = Number(item["Quantity"]) || 0;

      if (!resultMap[id]) {
        resultMap[id] = {
          id,
          zohoSales: 0,
          offlineSales: 0,
        };
      }

      resultMap[id].zohoSales += qty;
    }

    // offline sales
    for (const item of offLineSalesData) {
      const id = item["Product ID"];
      const adjustmentId = item["Inventory Adjustment ID"];

      const reason = reasonMap[adjustmentId];

      if (!validOfflineReasons.has(reason)) continue;

      const qty = (Number(item["Quantity Adjusted"]) || 0) * -1;

      if (!resultMap[id]) {
        resultMap[id] = {
          id,
          zohoSales: 0,
          offlineSales: 0,
        };
      }

      resultMap[id].offlineSales += qty;
    }

    res.json({
      result: Object.values(resultMap),
    });
  } catch (error) {
    next(error);
  }
});
module.exports = router;
