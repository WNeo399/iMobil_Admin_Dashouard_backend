// Item → Zoho category name, live.
//
// Zoho's bulk itemdetails endpoint returns no category fields, but the
// Analytics items view carries each item's Category ID — so a page load
// costs one Analytics call (chunked IN criteria; a collection is usually
// one chunk). The id → name map comes from the Inventory categories
// endpoint (~1.3k rows), cached in memory for an hour since the category
// tree barely moves.
//
// Used by the Accessories Stock Monitoring page (spare parts don't use
// Zoho categories). Degrades gracefully: any Zoho hiccup just means
// missing categories on that load, never an error.

const { getViewData, handleZohoInventoryRequest } = require("./zohoRequest");

const ORG_ID = "746138234";
const WORKSPACE_ID = "1404913000003936002";
const ITEMS_VIEW_ID = "1404913000003936100";

// Comfortably under URL-length limits (the 414 ceiling sits in the
// thousands of ids; collections are hundreds at most).
const CHUNK = 300;
const NAME_TTL_MS = 60 * 60 * 1000;

let nameCache = { at: 0, map: new Map() };

async function categoryNames() {
  if (nameCache.map.size && Date.now() - nameCache.at < NAME_TTL_MS) {
    return nameCache.map;
  }
  const resp = await handleZohoInventoryRequest(
    `https://www.zohoapis.com/inventory/v1/categories?organization_id=${ORG_ID}`,
  );
  const list = (resp && (resp.categories || resp.item_categories)) || [];
  if (Array.isArray(list) && list.length) {
    nameCache = {
      at: Date.now(),
      map: new Map(
        list.map((c) => [String(c.category_id || c.id), c.name || c.category_name || ""]),
      ),
    };
  }
  return nameCache.map;
}

// itemId(s) → category name. Items without a category (or under ROOT)
// are simply absent from the returned map.
async function getItemCategories(itemIds) {
  const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const names = await categoryNames();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const config = {
        responseFormat: "json",
        selectedColumns: ["Item ID", "Category ID"],
        criteria: `"Item ID" IN (${chunk.join(",")})`,
      };
      const url =
        `https://analyticsapi.zoho.com/restapi/v2/workspaces/${WORKSPACE_ID}` +
        `/views/${ITEMS_VIEW_ID}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;
      const rows = await getViewData(url);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const name = names.get(String(row["Category ID"]));
        if (name && name !== "ROOT") out.set(String(row["Item ID"]), name);
      }
    }
  } catch (e) {
    console.error("Item categories lookup failed:", e.message);
  }
  return out;
}

module.exports = { getItemCategories };
