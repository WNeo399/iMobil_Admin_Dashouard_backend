// Embed Ordering — what the ordering widget holds, for the dashboard's Ordering
// Widget page: the catalogue counts (incl. in stock), the brand table, and
// each distributor's key + websites for the embed code and preview.
//
//   GET /embed-ordering/widget-summary        (embedOrdering:distributor:view)
//
// The widget itself reads the public feed (routes/embedOrderingRoutes/widget.js).

var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { getCatalog } = require("../../utils/sparePartsCatalog");

router.get("/", requirePermission("embedOrdering:distributor:view"), async (req, res) => {
  try {
    const db = await connectToDatabase();
    const [cat, dists] = await Promise.all([
      getCatalog(),
      db
        .collection("embed_ordering_distributors")
        .find({}, { projection: { name: 1, status: 1, origins: 1, publicKey: 1 } })
        .sort({ name: 1 })
        .toArray(),
    ]);
    const customers = await db
      .collection("embed_ordering_customers")
      .aggregate([{ $match: { status: { $ne: "inactive" } } }, { $group: { _id: "$distributorId", n: { $sum: 1 } } }])
      .toArray();
    const customerCount = new Map(customers.map((c) => [String(c._id), c.n]));
    return res.json({
      success: true,
      updatedAt: cat.at,
      counts: cat.counts,
      brands: cat.brands.map((b) => ({
        name: b.name,
        parts: b.parts,
        series: b.series.map((s) => ({ name: s.name, parts: s.parts, models: s.models.length })),
      })),
      distributors: dists.map((d) => ({
        _id: d._id,
        name: d.name || "",
        status: d.status || "active",
        origins: d.origins || [],
        publicKey: d.publicKey || "",
        customers: customerCount.get(String(d._id)) || 0,
      })),
    });
  } catch (e) {
    console.error("Embed Ordering widget summary error:", e);
    return res.status(500).json({ success: false, message: "Could not read the ordering widget's parts" });
  }
});

module.exports = router;
