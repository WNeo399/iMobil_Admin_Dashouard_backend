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
  fetchStockShapedItems,
  getSalesTotals,
} = require("../../utils/zohoStock");
const { getItemCategories } = require("../../utils/itemCategories");
// Collection membership is a filter over the stock register (2026-09-22).
const { resolveCollectionItemIds, SCOPE_BY_STORE } = require("../../utils/collectionFilter");

// Items hidden from the Stock Monitoring list by hand (page-level only —
// the snapshot dashboard, buy lists and Price Monitoring still count
// them; that stronger cross-page bucket is the Archive). One registry for
// both scopes, keyed by Zoho item id.
const STOCK_HIDDEN = "imb_stock_hidden";

router.get("/collectionStocks", requirePermission("zoho:stock:view"), async function (req, res, next) {
  try {
    const { collection } = req.query;
    // One id, or a comma-list — the tree's clickable parent nodes load a
    // whole branch (e.g. every iPhone Screen collection) in one request.
    const raw = Array.isArray(collection) ? collection.join(",") : String(collection || "");
    const collectionIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!collectionIds.length || collectionIds.some((id) => !ObjectId.isValid(id))) {
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
    const docs = await db
      .collection(store)
      .find({ _id: { $in: collectionIds.map((id) => new ObjectId(id)) } })
      .toArray();

    if (!docs.length) {
      return res.status(404).json({ success: false, message: "Collection not found" });
    }

    // Union of every requested collection — each one a register query.
    const memberOf = new Map();
    for (const doc of docs) {
      for (const id of await resolveCollectionItemIds(db, doc, SCOPE_BY_STORE[store])) {
        if (!memberOf.has(id)) memberOf.set(id, []);
        memberOf.get(id).push(String(doc._id));
      }
    }
    const itemIds = [...memberOf.keys()];
    if (itemIds.length === 0) {
      // Neither source produced anything (empty collection or a
      // criteria that matched nothing) — empty list rather than an
      // error so the UI degrades gracefully.
      return res.json([]);
    }

    const result = await fetchStockShapedItems(itemIds);
    // Branch requests tag each item with the collections it came from, so
    // the page can offer those as a filter over the merged list.
    if (docs.length > 1) {
      for (const item of result) {
        item.memberOf = memberOf.get(String(item.id)) || [];
      }
    }

    // Accessories carry a Zoho category (parts don't use them) — joined
    // in live from the Analytics items view for the meta line + filter.
    if (store === "accessoryCollections") {
      const categories = await getItemCategories(itemIds);
      for (const item of result) {
        item.category = categories.get(String(item.id)) || "";
      }
    }

    // Flag manually hidden items rather than dropping them, so the page
    // can offer a "N hidden — view" review with unhide.
    const hiddenDocs = await db
      .collection(STOCK_HIDDEN)
      .find({ itemId: { $in: result.map((i) => String(i.id)) } }, { projection: { itemId: 1 } })
      .toArray();
    if (hiddenDocs.length) {
      const hiddenIds = new Set(hiddenDocs.map((h) => h.itemId));
      for (const item of result) {
        if (hiddenIds.has(String(item.id))) item.hidden = true;
      }
    }

    // 海运 membership badge (spare parts only — the list is a parts concept).
    if (store === "productCollections") {
      const sea = await seaFreightDoc(db);
      const seaIds = new Set((sea.products || []).map((p) => String(p.itemId)));
      if (seaIds.size) {
        for (const item of result) {
          if (seaIds.has(String(item.id))) item.seaFreight = true;
        }
      }
    }
    return res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── 海运 (sea freight) list ─────────────────────────────────────────
// A real productCollections doc (pinned products only, no criteria) so it
// rides the existing machinery for free: resolveCollectionItemIds reads
// pinned ids straight from Mongo (instant, no Zoho call, no Analytics
// lag), and the nightly snapshot stamps its title into every member row's
// `collections`, which feeds the Dashboard's Collection filter. It is
// deliberately NOT in any collection group, so it stays out of the
// category tree — the page pins it as a tab instead.
const SEA_FREIGHT_TITLE = "海运";
async function seaFreightDoc(db) {
  const col = db.collection("productCollections");
  let doc = await col.findOne({ seaFreight: true });
  if (!doc) {
    // Adopt a hand-made collection of the same name rather than shadow it.
    doc = await col.findOne({ title: SEA_FREIGHT_TITLE });
    if (doc) await col.updateOne({ _id: doc._id }, { $set: { seaFreight: true } });
  }
  if (!doc) {
    const fresh = {
      title: SEA_FREIGHT_TITLE,
      seaFreight: true,
      note: "Sea-freight list — pinned tab on Stock Monitoring",
      type: "Selection",
      status: "active",
      rules: [],
      children: [],
      products: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const r = await col.insertOne(fresh);
    doc = { _id: r.insertedId, ...fresh };
  }
  return doc;
}

router.get("/seaFreight", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const db = await connectToDatabase();
    const doc = await seaFreightDoc(db);
    const itemIds = (doc.products || []).map((p) => String(p.itemId)).filter(Boolean);
    return res.json({ success: true, id: String(doc._id), itemIds });
  } catch (error) {
    console.error("seaFreight get error:", error);
    return res.status(500).json({ success: false, message: "Failed to load the 海运 list" });
  }
});

// Bulk add — body { items: [{ id, name, sku }] }. Already-listed items are
// skipped, so re-adding is a no-op.
router.post("/seaFreight/items", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const clean = items
      .map((i) => ({
        itemId: String((i && i.id) || "").trim(),
        name: String((i && i.name) || "").trim(),
        sku: String((i && i.sku) || "").trim(),
        imageUrl: "",
      }))
      .filter((i) => /^\d{5,25}$/.test(i.itemId));
    if (!clean.length) return res.status(400).json({ success: false, message: "No items to add." });
    if (clean.length > 500) return res.status(400).json({ success: false, message: "Too many items (max 500)." });

    const db = await connectToDatabase();
    const doc = await seaFreightDoc(db);
    const existing = new Set((doc.products || []).map((p) => String(p.itemId)));
    const fresh = clean.filter((i) => !existing.has(i.itemId));
    if (fresh.length) {
      await db.collection("productCollections").updateOne(
        { _id: doc._id },
        { $push: { products: { $each: fresh } }, $set: { updatedAt: new Date() } },
      );
    }
    return res.json({ success: true, added: fresh.length, already: clean.length - fresh.length, total: existing.size + fresh.length });
  } catch (error) {
    console.error("seaFreight add error:", error);
    return res.status(500).json({ success: false, message: "Failed to add to 海运" });
  }
});

router.delete("/seaFreight/items/:itemId", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || "").trim();
    if (!/^\d{5,25}$/.test(itemId)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    const db = await connectToDatabase();
    const doc = await seaFreightDoc(db);
    await db.collection("productCollections").updateOne(
      { _id: doc._id },
      { $pull: { products: { itemId } }, $set: { updatedAt: new Date() } },
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("seaFreight remove error:", error);
    return res.status(500).json({ success: false, message: "Failed to remove from 海运" });
  }
});

// ── POST /zoho/stockHidden ──────────────────────────────────────────
// Hide the given items from the Stock Monitoring list (bulk — the page's
// row selection). Body: { items: [{ id, name, sku }] }. Upserts, so
// re-hiding an already hidden item is a no-op.
router.post("/stockHidden", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const clean = items
      .map((i) => ({
        itemId: String((i && i.id) || "").trim(),
        name: String((i && i.name) || "").trim(),
        sku: String((i && i.sku) || "").trim(),
      }))
      .filter((i) => /^\d{5,25}$/.test(i.itemId));
    if (!clean.length) {
      return res.status(400).json({ success: false, message: "No items to hide." });
    }
    if (clean.length > 500) {
      return res.status(400).json({ success: false, message: "Too many items (max 500)." });
    }
    const db = await connectToDatabase();
    const now = new Date();
    const by = (req.user && req.user.username) || null;
    await db.collection(STOCK_HIDDEN).bulkWrite(
      clean.map((i) => ({
        updateOne: {
          filter: { itemId: i.itemId },
          update: {
            $setOnInsert: { itemId: i.itemId, hiddenAt: now, hiddenBy: by },
            $set: { name: i.name, sku: i.sku },
          },
          upsert: true,
        },
      })),
    );
    return res.json({ success: true, hidden: clean.length });
  } catch (error) {
    console.error("stockHidden hide error:", error);
    return res.status(500).json({ success: false, message: "Failed to hide the items" });
  }
});

// ── DELETE /zoho/stockHidden/:itemId ────────────────────────────────
router.delete("/stockHidden/:itemId", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || "").trim();
    if (!/^\d{5,25}$/.test(itemId)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    const db = await connectToDatabase();
    await db.collection(STOCK_HIDDEN).deleteOne({ itemId });
    return res.json({ success: true });
  } catch (error) {
    console.error("stockHidden unhide error:", error);
    return res.status(500).json({ success: false, message: "Failed to unhide the item" });
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

// ── GET /zoho/items/:id/image ───────────────────────────────────────
// Proxies the item's (first) product image out of Zoho Inventory, which
// only serves it with OAuth — the browser can't load it directly. "No
// image" is a 204, never an error, so the stock table can probe every
// row without producing toast spam client-side. Cached a day: images
// effectively never change.
const axios = require("axios");
router.get("/items/:id/image", requirePermission("zoho:stock:view"), async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!/^\d{5,25}$/.test(id)) {
      return res.status(400).json({ success: false, message: "Bad item id" });
    }
    let token = await refreshToken();
    const fetchOnce = () =>
      axios.get(
        `https://www.zohoapis.com/inventory/v1/items/${id}/image?organization_id=746138234`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          responseType: "arraybuffer",
          validateStatus: null,
        },
      );
    let resp = await fetchOnce();
    if (resp.status === 401) {
      token = await refreshToken(true);
      if (token) resp = await fetchOnce();
    }
    const type = String((resp.headers && resp.headers["content-type"]) || "");
    // Zoho answers a JSON body (item has no image / error) or the binary.
    if (resp.status !== 200 || !resp.data || !resp.data.length || type.includes("json")) {
      return res.status(204).end();
    }
    res.set("Content-Type", type || "image/jpeg");
    res.set("Cache-Control", "private, max-age=86400");
    return res.send(Buffer.from(resp.data));
  } catch (error) {
    console.error("Item image proxy error:", error.message);
    return res.status(204).end();
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
