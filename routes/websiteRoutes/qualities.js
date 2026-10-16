// iMobile Listing → Qualities (user ask 2026-10-16): the qualities each
// classification of part comes in (utils/listingQualities), so the create
// dialogs offer only the ones that fit.
//
//   GET /website/qualities                    every classification: its list, and the qualities its
//                                             live Zoho items use (with counts), plus every known quality
//   PUT /website/qualities/:classification    { qualities: [...] } — the list, in dropdown order
//
// listing:quality:view reads, listing:quality:manage writes (Admin, iMobile
// Warehouse, iMobile Purchase hold listing:*:*).

const express = require("express");
const router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { connectToDatabase } = require("../../utils/mongodb");
const { COLL, ZOHO_CLASSIFICATIONS } = require("../../utils/listingQualities");
const { cleanQuality, qualityOptions } = require("../../utils/zohoNewItem");

const VIEW = requirePermission("listing:quality:view");
const MANAGE = requirePermission("listing:quality:manage");
const MAX = 60;

router.get("/", VIEW, async (req, res, next) => {
  try {
    const db = await connectToDatabase();
    const [docs, usage, known] = await Promise.all([
      db.collection(COLL).find({}).toArray(),
      // what the register's live parts use today, per classification
      db.collection("imb_stock_items").aggregate([
        { $match: { active: { $ne: false }, scope: "parts", classification: { $in: ZOHO_CLASSIFICATIONS }, quality: { $nin: [null, ""] } } },
        { $group: { _id: { c: "$classification", q: "$quality" }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]).toArray(),
      qualityOptions(db),
    ]);
    const byClass = new Map(docs.map((d) => [d.classification, d]));
    const classifications = ZOHO_CLASSIFICATIONS.map((c) => {
      const d = byClass.get(c);
      return {
        classification: c,
        qualities: (d && d.qualities) || [],
        usage: usage.filter((u) => u._id.c === c).map((u) => ({ quality: u._id.q, count: u.n })),
        updatedAt: (d && d.updatedAt) || null,
        updatedBy: (d && d.updatedBy) || null,
      };
    });
    // every quality anyone has used or listed, most used first
    const all = [...new Set([...known, ...docs.flatMap((d) => d.qualities || [])])];
    return res.json({ success: true, classifications, all });
  } catch (error) {
    next(error);
  }
});

router.put("/:classification", MANAGE, async (req, res, next) => {
  try {
    const classification = String(req.params.classification || "");
    if (!ZOHO_CLASSIFICATIONS.includes(classification)) return res.status(400).json({ success: false, message: "Unknown classification" });
    const asked = req.body && req.body.qualities;
    if (!Array.isArray(asked)) return res.status(400).json({ success: false, message: "Send the list of qualities" });
    if (asked.length > MAX) return res.status(400).json({ success: false, message: `At most ${MAX} qualities` });
    const qualities = [];
    const seen = new Set();
    for (const q of asked) {
      const { quality, error } = cleanQuality(q);
      if (error) return res.status(400).json({ success: false, message: `${String(q).slice(0, 60)}: ${error}` });
      if (!quality || seen.has(quality.toLowerCase())) continue;
      seen.add(quality.toLowerCase());
      qualities.push(quality);
    }
    const by = (req.user && (req.user.username || req.user.email)) || null;
    const now = new Date();
    const db = await connectToDatabase();
    await db.collection(COLL).updateOne(
      { classification },
      { $set: { classification, qualities, updatedAt: now, updatedBy: by }, $setOnInsert: { createdAt: now, createdBy: by } },
      { upsert: true },
    );
    return res.json({ success: true, classification, qualities, updatedAt: now, updatedBy: by });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
