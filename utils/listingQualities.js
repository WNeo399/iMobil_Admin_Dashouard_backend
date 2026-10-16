// The qualities each classification of part comes in (user ask 2026-10-16) —
// iMobile Listing → Qualities. One record per Zoho classification in
// imb_listing_qualities: { classification, qualities: [...in the order the
// dropdown shows them], updatedAt, updatedBy }. The create dialogs (New
// Products, and "Create in Zoho" on the Purchase Order page) offer only the
// item's classification's qualities; a classification without a list offers
// every quality, as before.

const COLL = "imb_listing_qualities";
// Zoho's Classification values for parts (the purchase module's "MacBook
// Screen" is a purchase category, not a Zoho classification)
const ZOHO_CLASSIFICATIONS = ["Screen", "Housing", "Middle Frame", "BackCover", "Battery", "Small Parts", "IC", "Tools", "Other"];

// { classification: [qualities] } — only the classifications that have a list
async function qualitiesByClassification(db) {
  const docs = await db.collection(COLL).find({}, { projection: { _id: 0, classification: 1, qualities: 1 } }).toArray();
  const out = {};
  for (const d of docs) if (Array.isArray(d.qualities) && d.qualities.length) out[d.classification] = d.qualities;
  return out;
}

module.exports = { COLL, ZOHO_CLASSIFICATIONS, qualitiesByClassification };
