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

module.exports = { commerce, COMMERCE_BASE: BASE, COMMERCE_ORG: ORG };
