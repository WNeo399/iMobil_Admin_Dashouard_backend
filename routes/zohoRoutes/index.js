var express = require("express");
var router = express.Router();
var productRouter = require("./product/index");
var salesOrderRouter = require("./salesOrder/index");
var buzztechRouter = require("./buzztech/index");
var locationRouter = require("./location/index");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const { requirePermission } = require("../../middleware/auth");
const { handleZohoInventoryPutRequest, refreshToken } = require("../../utils/zohoRequest");

/* GET home page. */
router.get("/", function (req, res, next) {
  res.render("index", { title: "Express" });
});

router.use("/product", productRouter);
router.use("/salesOrder", salesOrderRouter);
router.use("/buzztech", buzztechRouter);
router.use("/location", locationRouter);

// The stock and sales reads these two endpoints are built on now live in
// utils/zohoStock.js, so the daily snapshot job can ask the same questions
// without going through HTTP. Both routes below are thin wrappers over it.
const {
  resolveCollectionItemIds,
  fetchStockShapedItems,
  getSalesTotals,
} = require("../../utils/zohoStock");
const { getItemCategories } = require("../../utils/itemCategories");

router.get("/collectionStocks", requirePermission("zoho:stock:view"), async function (req, res, next) {
  try {
    const { collection } = req.query;
    const collectionId = Array.isArray(collection) ? collection[0] : collection;

    if (!collectionId || !ObjectId.isValid(collectionId)) {
      return res.status(400).json({ success: false, message: "Invalid collection id" });
    }

    // scope=accessories reads the Accessories collection set instead of the
    // Spare Parts one — same page logic, separate data. Whitelisted rather
    // than taking a raw collection name from the client.
    const store =
      String(req.query.scope || "") === "accessories"
        ? "accessoryCollections"
        : "productCollections";

    const db = await connectToDatabase();
    const collectionData = await db
      .collection(store)
      .findOne({ _id: new ObjectId(collectionId) });

    if (!collectionData) {
      return res.status(404).json({ success: false, message: "Collection not found" });
    }

    const itemIds = await resolveCollectionItemIds(collectionData);
    if (itemIds.length === 0) {
      // Neither source produced anything (empty collection or a
      // criteria that matched nothing) — empty list rather than an
      // error so the UI degrades gracefully.
      return res.json([]);
    }

    const result = await fetchStockShapedItems(itemIds);

    // Accessories carry a Zoho category (parts don't use them) — joined
    // in live from the Analytics items view for the meta line + filter.
    if (store === "accessoryCollections") {
      const categories = await getItemCategories(itemIds);
      for (const item of result) {
        item.category = categories.get(String(item.id)) || "";
      }
    }
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── PUT /zoho/items/:id/reorderLevel ────────────────────────────────
// Inline reorder-point edit on the Accessories page: writes straight to
// Zoho Inventory (the item's Reorder Point field), so Zoho stays the
// single source of truth. zoho:stock:edit = admin + iMobile Admin
// (zoho:*:*); no narrower role holds it.
router.put("/items/:id/reorderLevel", requirePermission("zoho:stock:edit"), async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!/^\d{5,25}$/.test(id)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    const level = Number(req.body && req.body.reorderLevel);
    if (!Number.isFinite(level) || level < 0 || level > 1000000) {
      return res.status(400).json({ success: false, message: "Reorder point must be 0 or a positive number" });
    }
    // Pre-warm the token: a write should not burn its first attempt on
    // discovering an expired one.
    await refreshToken();
    const resp = await handleZohoInventoryPutRequest(
      `https://www.zohoapis.com/inventory/v1/items/${id}?organization_id=746138234`,
      { reorder_level: Math.floor(level) },
    );
    if (!resp || resp.code !== 0) {
      return res
        .status(502)
        .json({ success: false, message: (resp && resp.message) || "Zoho rejected the update" });
    }
    return res.json({
      success: true,
      reorderLevel: Number((resp.item && resp.item.reorder_level) || 0),
    });
  } catch (error) {
    console.error("Reorder level update error:", error);
    return res.status(500).json({ success: false, message: "Failed to update the reorder point" });
  }
});

router.post("/salesTotal", requirePermission("zoho:stock:view"), async function (req, res, next) {
  try {
    const { itemIds, duration = 30 } = req.body;
    const result = await getSalesTotals(itemIds, duration);
    return res.json({ result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
