// Zoho Commerce admin store API (https://commerce.zoho.com/store/api/v1) —
// not the public storefront API that routes/zohoRoutes/product uses for
// search. Same OAuth token as Inventory: its scopes include
// ZohoCommerce.items.ALL (categories and products). The store is the
// Inventory organisation, so Commerce categories ARE the Inventory item
// categories (same ids).
//
// commerce(method, path, { params, data }) → Zoho's JSON body. Zoho's error
// bodies ({ code, message }) come back as values rather than throws, so
// callers check `code === 0`; an expired token is refreshed once and the
// call repeated.

const axios = require("axios");
const { refreshToken } = require("./zohoRequest");

const BASE = "https://commerce.zoho.com/store/api/v1";
const ORG = "746138234";

const isAuthError = (d) =>
  !!d && (d.code === 14 || d.code === 57 || d.summary === "INVALID_OAUTHTOKEN" || d.summary === "SECURITY_NEEDS_LOGIN");

async function commerce(method, path, { params, data } = {}) {
  const call = async (force) => {
    const token = await refreshToken(force);
    if (!token) throw new Error("Could not get a Zoho token");
    try {
      const r = await axios.request({
        method,
        url: BASE + path,
        params,
        data,
        timeout: 30000,
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          "X-com-zoho-store-organizationid": ORG,
          "Content-Type": "application/json",
        },
      });
      return r.data;
    } catch (e) {
      // Zoho answers errors with a JSON body and a 4xx — hand it back
      if (e.response && e.response.data && typeof e.response.data === "object") return e.response.data;
      throw e;
    }
  };
  let d = await call(false);
  if (isAuthError(d)) d = await call(true);
  return d;
}

// The store product of an Inventory item: its variant's variant_id is the
// item_id (a part is a one-variant product, product_id ≠ item_id). Found by
// a search on the SKU → { productId, name, status, shown } or null.
async function productOfItem(itemId, sku) {
  const d = await commerce("get", "/products", { params: { search_text: String(sku || ""), per_page: 25 } });
  if (!d || d.code !== 0) throw new Error(`Zoho Commerce: ${(d && d.message) || "the product search failed"}`);
  const p = (d.products || []).find((x) => (x.variants || []).some((v) => String(v.variant_id) === String(itemId)));
  return p ? { productId: String(p.product_id), name: p.name || "", status: p.status || "", shown: p.show_in_storefront === true } : null;
}

// "Show in store" on (Listing → New Products' Approve, 2026-10-21): the
// product's show_in_storefront, one partial PUT /products/{id}, then read back
// — Zoho can answer code 0 without keeping a field. → { productId, already } ;
// throws with Zoho's reason when it isn't shown afterwards.
async function showItemInStore(itemId, sku) {
  const p = await productOfItem(itemId, sku);
  if (!p) throw new Error("not found in the store (Zoho Commerce)");
  if (p.shown) return { productId: p.productId, already: true };
  const r = await commerce("put", `/products/${p.productId}`, { data: { show_in_storefront: true } });
  if (!r || r.code !== 0) throw new Error(`Zoho Commerce: ${(r && r.message) || "the update failed"}`);
  const after = await productOfItem(itemId, sku);
  if (!after || !after.shown) throw new Error("Zoho Commerce took the update but the product is still hidden");
  return { productId: p.productId, already: false };
}

module.exports = { commerce, productOfItem, showItemInStore, COMMERCE_BASE: BASE, COMMERCE_ORG: ORG };
