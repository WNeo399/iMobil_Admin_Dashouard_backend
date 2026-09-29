// Display settings of the website banner carousel (Mongo: imb_web_settings,
// one doc keyed "bannerCarousel"). Set on the dashboard's Banner page,
// served to the widget with the banners, so the website never needs its
// embed code touched to change them.
//
//   maxHeight  px — the carousel stops growing taller; on wider screens the
//              image is trimmed equally at top and bottom. null = follow the
//              image's shape at any width.
//   maxWidth   px — the carousel stops growing wider and sits centred.
//              null = the full width of its spot on the page.

const SETTINGS = "imb_web_settings";
const ID = "bannerCarousel";

async function getCarouselSettings(db) {
  const doc = await db.collection(SETTINGS).findOne({ _id: ID });
  return {
    maxHeight: (doc && doc.maxHeight) || null,
    maxWidth: (doc && doc.maxWidth) || null,
  };
}

// A size in px, or null for "no limit". Throws a 400-flagged error.
function sizeOrNull(v, label) {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 200 || n > 4000) {
    const err = new Error(`${label} must be between 200 and 4000 px, or empty for no limit`);
    err.status = 400;
    throw err;
  }
  return n;
}

async function saveCarouselSettings(db, body, user) {
  const set = {
    maxHeight: sizeOrNull(body && body.maxHeight, "Max height"),
    maxWidth: sizeOrNull(body && body.maxWidth, "Max width"),
    updatedAt: new Date(),
    updatedBy: user || null,
  };
  await db.collection(SETTINGS).updateOne({ _id: ID }, { $set: set }, { upsert: true });
  return { maxHeight: set.maxHeight, maxWidth: set.maxWidth };
}

module.exports = { getCarouselSettings, saveCarouselSettings };
