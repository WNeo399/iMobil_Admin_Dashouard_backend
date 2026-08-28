var express = require("express");
var router = express.Router();
var productRouter = require("./product/index");
var salesOrderRouter = require("./salesOrder/index");
var buzztechRouter = require("./buzztech/index");
var locationRouter = require("./location/index");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");

const { requirePermission } = require("../../middleware/auth");

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
    return res.json(result);
  } catch (error) {
    next(error);
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
