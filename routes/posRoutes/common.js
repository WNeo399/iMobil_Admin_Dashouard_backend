// Shared helpers for the POS module. Distributors and their customers hold
// the same shaped contact/address data, so the parsing lives in one place.

const STATUSES = ["active", "inactive"];

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}

function status(v) {
  const s = str(v, 20).toLowerCase();
  return STATUSES.includes(s) ? s : "active";
}

// Structured rather than one blob so it can be posted to Zoho as a
// billing/shipping address later without re-parsing free text.
function address(v) {
  const a = v && typeof v === "object" ? v : {};
  return {
    line1: str(a.line1, 200),
    line2: str(a.line2, 200),
    city: str(a.city, 100),
    state: str(a.state, 60),
    postcode: str(a.postcode, 20),
  };
}

// Case-insensitive exact match, for the name/email uniqueness checks.
function exact(value) {
  return new RegExp("^" + escapeRegex(value) + "$", "i");
}

module.exports = { STATUSES, escapeRegex, str, status, address, exact };
