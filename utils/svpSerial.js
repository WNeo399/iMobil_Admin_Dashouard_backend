// Normalize an Apple part serial for storage + lookup. MUST match the lookup
// site's normalization so a serial matches regardless of how it's typed
// (spaces, lower-case, etc.). Stored serials use this as their _id.
function normalizeSerial(serial) {
  return String(serial || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

module.exports = { normalizeSerial };
