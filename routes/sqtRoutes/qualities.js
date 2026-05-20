var express = require("express");
var router = express.Router();
const { connectToDatabase } = require("../../utils/mongodb");

const COLLECTION = "sqt_qualities";

const SEED = [
  {
    slug: "aftermarket",
    name: "AfterMarket",
    description: "Third-party compatible parts",
    identifierType: "sku",
    active: true,
  },
  {
    slug: "service-pack",
    name: "Service Pack",
    description: "Manufacturer service pack parts",
    identifierType: "partNumber",
    active: true,
  },
  {
    slug: "oem",
    name: "OEM",
    description: "Original equipment manufacturer parts",
    identifierType: "both",
    active: true,
  },
  {
    slug: "refurbished",
    name: "Refurbished",
    description: "Refurbished parts",
    identifierType: "both",
    active: true,
  },
];

async function ensureSeeded(db) {
  const collection = db.collection(COLLECTION);
  const count = await collection.countDocuments();
  if (count > 0) return;

  const now = new Date();
  await collection.insertMany(
    SEED.map((s) => ({ ...s, createdAt: now, updatedAt: now })),
  );
}

router.get("/list", async function (req, res, next) {
  try {
    const db = await connectToDatabase();
    await ensureSeeded(db);

    const data = await db
      .collection(COLLECTION)
      .find({ active: true })
      .sort({ name: 1 })
      .toArray();

    return res.json({ success: true, data });
  } catch (error) {
    console.error("List qualities error:", error);
    return res.status(500).json({ success: false, message: "Failed to list qualities" });
  }
});

module.exports = router;
