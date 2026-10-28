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
const FormData = require("form-data");
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
  return p ? { productId: String(p.product_id), name: p.name || "", status: p.status || "", shown: p.show_in_storefront === true, variants: (p.variants || []).length } : null;
}

// The same, first by the id Zoho gives the product of a part — item_id − 1
// (one GET, so a brand-new item needs no search index); else the SKU search.
async function storeProductOf(itemId, sku) {
  const id = String(itemId || "");
  if (/^\d{6,25}$/.test(id)) {
    const d = await commerce("get", `/products/${(BigInt(id) - 1n).toString()}`);
    const p = d && d.code === 0 && d.product;
    if (p && (p.variants || []).some((v) => String(v.variant_id) === id)) {
      return { productId: String(p.product_id), name: p.name || "", status: p.status || "", shown: p.show_in_storefront === true, variants: p.variants.length };
    }
  }
  return productOfItem(id, sku);
}

// Images onto a store PRODUCT (POST /products/{id}/images, one multipart
// "image" per file, scope items.CREATE). For a one-variant product Zoho files
// each as ONE document shared by the product, its variant and the Inventory
// item (tested on SKU 21847, 2026-10-28) — the product's image is what the
// storefront's listing and search pages show. → Zoho's body (code 0 = taken).
async function uploadProductImages(productId, files) {
  const call = async (force) => {
    const token = await refreshToken(force);
    if (!token) throw new Error("Could not get a Zoho token");
    const form = new FormData();
    for (const f of files) form.append("image", f.buffer, { filename: f.originalname || "image.jpg", contentType: f.mimetype });
    try {
      const r = await axios.post(`${BASE}/products/${encodeURIComponent(productId)}/images`, form, {
        timeout: 120000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers: { ...form.getHeaders(), Authorization: `Zoho-oauthtoken ${token}`, "X-com-zoho-store-organizationid": ORG },
      });
      return r.data;
    } catch (e) {
      if (e.response && e.response.data && typeof e.response.data === "object") return e.response.data;
      throw e;
    }
  };
  let d = await call(false);
  if (isAuthError(d)) d = await call(true);
  return d;
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

module.exports = { commerce, productOfItem, storeProductOf, uploadProductImages, showItemInStore, COMMERCE_BASE: BASE, COMMERCE_ORG: ORG };
