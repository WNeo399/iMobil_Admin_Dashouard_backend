// Cached lookup for the per-widget origin allowlist.
//
// The widget submission endpoints hit getAllowedOrigins(widgetName)
// on every preflight + POST. Going to Mongo each time would be fine
// performance-wise (single-doc lookup, sub-ms) but the cache lets us
// stay snappy under spam bursts and avoids load while staying
// transparent to admins — when they add or change an origin via the
// admin UI, the corresponding admin endpoint calls invalidateCache()
// so the next request sees the change immediately, no waiting for
// the TTL.
//
// Cache shape: `widget name → { origins: Set<string>, expiresAt: ms }`.
// `Set` because the hot path is `.has(origin)` membership checks.
//
// Schema for imb_widget_origins (the underlying collection):
//   {
//     _id,
//     widget:     string,   // e.g. "special-order"
//     origin:     string,   // canonical origin URL, no trailing slash
//     label:      string,   // optional friendly name
//     enabled:    boolean,  // false = keep the row but stop honouring
//     createdAt:  Date,
//     updatedAt:  Date,
//     createdBy:  string,   // user id from the JWT
//     updatedBy:  string,
//   }
// Compound unique index on (widget, origin) so adding the same origin
// twice for a widget surfaces as a 409 instead of silently duplicating
// — the route handler enforces that via createIndex on first request.

const { connectToDatabase } = require("./mongodb");

const COLLECTION = "imb_widget_origins";
const CACHE_TTL_MS = 60 * 1000;

// widget → { origins: Set<string>, expiresAt: number }
const cache = new Map();

let _indexEnsured = false;
async function ensureIndex(db) {
  if (_indexEnsured) return;
  await db
    .collection(COLLECTION)
    .createIndex({ widget: 1, origin: 1 }, { unique: true });
  _indexEnsured = true;
}

/**
 * Origins currently allowed for the given widget. Reads from cache
 * when fresh, otherwise refreshes from Mongo.
 *
 * Always returns a `Set` (even when empty) so callers can blindly
 * `.has(origin)` without null-checking.
 */
async function getAllowedOrigins(widgetName) {
  if (!widgetName) return new Set();

  const cached = cache.get(widgetName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.origins;
  }

  const db = await connectToDatabase();
  await ensureIndex(db);
  const rows = await db
    .collection(COLLECTION)
    .find({ widget: widgetName, enabled: true })
    .project({ origin: 1, _id: 0 })
    .toArray();
  const origins = new Set(rows.map((r) => r.origin));
  cache.set(widgetName, {
    origins,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return origins;
}

/**
 * Drop the cached entry for a widget so the next lookup hits Mongo.
 * Called by the admin endpoints after any write so admins see their
 * changes propagate without waiting for the TTL.
 *
 * Pass no argument to clear every cached widget (useful in tests).
 */
function invalidateCache(widgetName) {
  if (widgetName) {
    cache.delete(widgetName);
  } else {
    cache.clear();
  }
}

/**
 * Normalise a user-supplied origin to the canonical form Mongo stores
 * (and that the submission endpoint matches against). Drops the path,
 * lowercases the host via WHATWG URL parsing, strips the trailing
 * slash. Returns null when the input isn't a parseable URL.
 *
 * Used by the admin endpoints to keep storage consistent regardless
 * of how the admin typed the value.
 */
function normalizeOrigin(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    // .origin is already protocol + lowercased host + port (no path,
    // no trailing slash).
    return url.origin;
  } catch {
    return null;
  }
}

module.exports = {
  COLLECTION,
  getAllowedOrigins,
  invalidateCache,
  normalizeOrigin,
};
