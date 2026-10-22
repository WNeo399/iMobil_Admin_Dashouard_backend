// The envelope an Exyon accessory order ships in — Small / Medium / Large —
// from its product names and quantities (user 2026-10-20). The rules are the
// warehouse's Maropost userscript ("Maropost Automated Label Filler" 2.3):
//   Large  — an iPad / tablet accessory, a large item (car mount, holder,
//            speaker, tripod…), or 3+ phone cases
//   Medium — any phone case, or 4+ screen protectors
//   Small  — the rest
// with these changes, agreed with the user:
//   · "Other" — an order holding a product none of the keywords recognise
//     (power bank, charger, watch band…): the packer picks the envelope
//   · a ring holder is a small item, not a large "HOLDER"
//   · Goospery iJelly and Mercury Blue Moon are phone cases
//   · "SHIELD" counts as a case only as a word of its own — not the iShield
//     brand, nor WINDSHIELD
// Reasons come back as codes so the page can word (and translate) them.
// An item's envelope can also be chosen by hand on the Dispatch page
// (2026-10-22): it replaces the rules for that item (reason code "set").

const SIZES = ["small", "medium", "large", "other"];

// a keyword: a phrase found anywhere in the name, or a RegExp
const SCREEN_PROTECTOR = ["SCREEN PROTECTOR", "PRIVACY GLASS", "TEMPERED GLASS", "GLASS SCREEN"];
const PHONE_CASE = ["CASE", "COVER", /\bSHIELD\b/, "WALLET", "FOLIO", "ARMOR", "CLEAR ARMOR", "FLIP CASE", "IJELLY", "BLUE MOON"];
const IPAD = ["IPAD", "TABLET", "SAMSUNG TAB", "TAB S"];
const LARGE_ITEM = ["WINDSHIELD", "DASH", "CAR MOUNT", "HOLDER", "SPEAKER", "TRIPOD"];
// recognised, and small whatever else their name says
const SMALL_ITEM = ["RING HOLDER"];

const hits = (keywords, name) => keywords.some((k) => (k instanceof RegExp ? k.test(name) : name.includes(k)));

// What one product counts as.
function classify(productName) {
  const name = String(productName || "").toUpperCase().replace(/\s+/g, " ");
  const small = hits(SMALL_ITEM, name);
  const sp = hits(SCREEN_PROTECTOR, name);
  const phoneCase = !sp && hits(PHONE_CASE, name); // a screen protector is never a case
  const ipad = hits(IPAD, name);
  // a ring holder's "HOLDER" doesn't make it large
  const largeName = small ? SMALL_ITEM.reduce((n, k) => n.split(k).join(" "), name) : name;
  const large = hits(LARGE_ITEM, largeName);
  return { sp, phoneCase, ipad, large, small, recognised: sp || phoneCase || ipad || large || small };
}

const RANK = { small: 0, medium: 1, large: 2, other: 3 };
const skuKeyOf = (sku) => String(sku || "").trim().toLowerCase();

// items: [{ sku, productName, quantity }], overrides: Map(sku lower-cased → size)
//   → { size, reasons: [{ code, n?, names? }] }
//   codes: ipad · largeItem · cases (n) · screenProtectors (n) · unknown (names) · set (names)
// An item chosen by hand counts as its size; the other items go through the
// rules together; the order takes the bigger ("other" the biggest).
function envelopeOf(items, overrides) {
  const set = [];
  const rest = [];
  for (const it of items || []) {
    const size = overrides && overrides.get(skuKeyOf(it && it.sku));
    if (size && SIZES.includes(size)) set.push({ size, name: String((it && it.productName) || "").trim() || String((it && it.sku) || "") });
    else rest.push(it);
  }
  if (!set.length) return byRules(rest);
  const chosen = set.reduce((m, x) => (RANK[x.size] > RANK[m] ? x.size : m), "small");
  const reasons = [{ code: "set", names: [...new Set(set.map((x) => x.name))] }];
  if (!rest.length) return { size: chosen, reasons };
  const auto = byRules(rest);
  return RANK[auto.size] > RANK[chosen] ? { size: auto.size, reasons: [...auto.reasons, ...reasons] } : { size: chosen, reasons: [...reasons, ...auto.reasons] };
}

// the rules alone
function byRules(items) {
  let screenProtectors = 0;
  let cases = 0;
  let ipad = false;
  let large = false;
  const unknown = [];
  for (const it of items || []) {
    const qty = Math.max(1, parseInt(it && it.quantity, 10) || 1);
    const k = classify(it && it.productName);
    if (k.sp) screenProtectors += qty;
    else if (k.phoneCase) cases += qty;
    if (k.ipad) ipad = true;
    if (k.large) large = true;
    if (!k.recognised) unknown.push(String((it && it.productName) || "").trim() || "(no name)");
  }
  if (unknown.length) return { size: "other", reasons: [{ code: "unknown", names: [...new Set(unknown)] }] };
  if (large || ipad || cases >= 3) {
    const reasons = [];
    if (ipad) reasons.push({ code: "ipad" });
    if (large) reasons.push({ code: "largeItem" });
    if (cases >= 3) reasons.push({ code: "cases", n: cases });
    return { size: "large", reasons };
  }
  if (cases > 0 || screenProtectors >= 4) {
    const reasons = [];
    if (cases > 0) reasons.push({ code: "cases", n: cases });
    if (screenProtectors >= 4) reasons.push({ code: "screenProtectors", n: screenProtectors });
    return { size: "medium", reasons };
  }
  return { size: "small", reasons: screenProtectors ? [{ code: "screenProtectors", n: screenProtectors }] : [] };
}

module.exports = { SIZES, classify, envelopeOf, skuKeyOf };
