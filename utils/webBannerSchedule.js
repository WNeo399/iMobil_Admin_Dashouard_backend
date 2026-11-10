// When a website banner shows (user ask 2026-11-10): an optional start and
// end on each banner (imb_web_banners.startAt / endAt, Dates or null).
// Empty = no limit on that side; the Active switch still has the last word.
// The Banner page sets them; the carousel feed (routes/widgetRoutes/
// bannerCarousel.js) serves only the banners inside their period, decided on
// the server's clock.

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// undefined = not sent (leave as is); "" / null = clear; else a Date.
// Multipart bodies carry strings, so "null" counts as clear too.
function dateOrNull(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return null;
  const d = new Date(v);
  if (isNaN(d)) throw badRequest(`${label} is not a valid date`);
  return d;
}

// The startAt / endAt to $set from a request body, checked together with
// what is saved (an edit may send only one of them). {} when neither was sent.
function scheduleOf(body, saved) {
  const b = body || {};
  const out = {};
  const startAt = dateOrNull(b.startAt, "The start");
  const endAt = dateOrNull(b.endAt, "The end");
  if (startAt !== undefined) out.startAt = startAt;
  if (endAt !== undefined) out.endAt = endAt;
  const s = "startAt" in out ? out.startAt : (saved && saved.startAt) || null;
  const e = "endAt" in out ? out.endAt : (saved && saved.endAt) || null;
  if (s && e && e <= s) throw badRequest("The end must be after the start");
  return out;
}

// Mongo filter: active and inside its period at `now`. A missing field
// matches null, so banners saved before this existed show as before.
function showingNowFilter(now) {
  return {
    active: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gt: now } }] },
    ],
  };
}

module.exports = { scheduleOf, showingNowFilter };
