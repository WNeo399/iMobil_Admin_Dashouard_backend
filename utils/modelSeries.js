// Derive the "series" a catalogue model belongs to from its display name.
//
// Series group models within a brand for the catalogue selectors:
//   Apple   → iPhone / iPad
//   Samsung → S Series / Note Series / Flip Series / Fold Series
//
// The catalogue's model names follow consistent patterns, so this mapping is
// reliable. Used as a fallback when a model is created without an explicit
// series (keeps older clients / direct API calls working), and by the
// bin/backfillModelSeries.js script. Returns the series display name, or null
// if nothing matched.
function deriveSeries(name) {
  const n = String(name || "");
  if (/ipad/i.test(n)) return "iPad";
  if (/iphone/i.test(n)) return "iPhone";
  if (/z\s*flip/i.test(n)) return "Flip Series";
  if (/z\s*fold/i.test(n)) return "Fold Series";
  if (/\bnote\b/i.test(n)) return "Note Series";
  if (/galaxy\s*s\s*\d/i.test(n)) return "S Series";
  return null;
}

module.exports = { deriveSeries };
