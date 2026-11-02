// A link that lands in an <a href> on the storefront: only web links and
// site-relative paths pass — never javascript:/data: URLs.
function cleanLink(v) {
  const s = String(v == null ? "" : v).trim().slice(0, 1000);
  if (!s) return "";
  if (/^\/(?!\/)/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.href;
  } catch (e) { /* falls through */ }
  const err = new Error("The link must start with https://, http:// or / (a page on the same site)");
  err.status = 400;
  throw err;
}

module.exports = { cleanLink };
