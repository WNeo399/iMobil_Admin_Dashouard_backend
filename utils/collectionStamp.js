// Keep the stock register's collection tags in step when a collection is
// saved, so the Stock Monitoring list — which reads membership from the
// register, not from Zoho — shows the change at once instead of after the
// next refresh.
//
// A register row carries the TITLES of the collections it belongs to:
// `collections` for the spare-parts set, `accessoryCollections` for the
// accessories set (bin/stockSnapshot.js stamps them all each refresh). A
// save resolves the collection's members the same way the refresh does
// (its filter as a Mongo query over the register, plus pinned products),
// drops the old title from every row and adds the current one to the
// members. `groups` (the folder each collection sits in) is left to the
// refresh — it only feeds the dashboard's Collection filter.
const { connectToDatabase } = require("./mongodb");
const { resolveCollectionItemIds, SCOPE_BY_STORE, TAG_FIELD_BY_STORE } = require("./collectionFilter");
const { ITEMS } = require("./stockItems");

const FIELD_BY_STORE = TAG_FIELD_BY_STORE;

// `doc` is the collection as saved; `previousTitle` its title before the
// save (a rename drops that tag too). doc = null just removes
// `previousTitle` (a delete). Never throws: a failed re-stamp means the tags
// wait for the refresh, which is where they came from before.
async function restampCollection(storeName, doc, previousTitle) {
  const field = FIELD_BY_STORE[storeName];
  if (!field) return { restamped: false, reason: "unknown collection store" };
  try {
    const db = await connectToDatabase();
    const items = db.collection(ITEMS);
    const titles = [...new Set([previousTitle, doc && doc.title].filter(Boolean))];
    if (titles.length) {
      await items.updateMany({ [field]: { $in: titles } }, { $pull: { [field]: { $in: titles } } });
    }
    if (!doc || !doc.title) return { restamped: true, members: 0 };
    const ids = await resolveCollectionItemIds(db, doc, SCOPE_BY_STORE[storeName]);
    if (ids.length) {
      await items.updateMany({ itemId: { $in: ids } }, { $addToSet: { [field]: doc.title } });
    }
    return { restamped: true, members: ids.length };
  } catch (e) {
    console.error(`collection re-stamp failed (${storeName} / ${(doc && doc.title) || previousTitle}):`, e.message);
    return { restamped: false, reason: e.message };
  }
}

module.exports = { restampCollection };
