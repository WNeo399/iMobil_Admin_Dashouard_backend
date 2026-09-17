// The stock-universe exclusion criteria, shared by the daily snapshot
// (bin/stockSnapshot.js) and the stock-monitor routes so both sides agree
// on what counts as a "criteria" dormant item.
//
// Since 2026-09-15 criteria matches are NOT dropped from the snapshot —
// they are flagged `archived` and live in the Archive bucket, alongside
// items archived by hand (imb_stock_archive, mode "archive").
// A mode "keep" entry pins an item as never-archived, beating the criteria.

// Name fragments that mark service / bookkeeping / template rows rather
// than sellable SKUs. Matched case-insensitively as substrings.
const NAME_NOISE = [
  "( inch)",
  // "placeholde" (no trailing r) also catches the "Placeholde20947" rows.
  "placeholde",
  "buyback",
  "grade]",
  "accessoryholder",
  "test",
  "special",
  // The SKU-00000 catch-all bucket (stock in the thousands, not a SKU).
  "item no code",
  // Bookkeeping bucket for Exyon order cancellations, not a sellable SKU.
  "order cancelled item",
  // Service / bookkeeping items (2026-09-15): order mechanics, freight,
  // packaging and credit ledgers — not sellable SKUs.
  "custom order",
  "exchange",
  "package box",
  // Also covers "startrack shipment refund" and the "... Replacement /
  // Refund" service variants.
  "refund",
  "service charge",
  "shipping cost",
  "small box",
  "inflow order",
  // Only this instalment-variant family — NOT the iShield / FW-SD films
  // sold FOR the FORWARD cutting machines, which are real products.
  "forward case film cutting machine",
];

// Junk only when the WHOLE name matches — a substring would take real
// products down with it (e.g. "paper" vs the Paperlike protectors).
const NAME_NOISE_EXACT = new Set(["paper"]);

function isNoiseName(name) {
  const n = String(name == null ? "" : name).toLowerCase().trim();
  if (NAME_NOISE_EXACT.has(n)) return true;
  return NAME_NOISE.some((frag) => n.includes(frag));
}

// The manual-override collection: one doc per item.
//   { itemId, sku, name, mode: "archive" | "keep", reason, by, at }
const ARCHIVE_COLLECTION = "imb_stock_archive";

module.exports = { NAME_NOISE, NAME_NOISE_EXACT, isNoiseName, ARCHIVE_COLLECTION };
