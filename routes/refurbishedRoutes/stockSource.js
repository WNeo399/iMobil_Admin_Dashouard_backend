// Where a refurbished device came from.
//
// On a device recorded by hand it follows whoever recorded it: a phone
// supplier holds their own stock, so their profile's stock source is stamped
// on it, and everyone else is recording iMobile's own stock. On a device
// received against an incoming batch it's the source chosen when that batch
// was uploaded. Either way it is never taken from a request body — a client
// can't file stock under someone else's source.
const STOCK_SOURCES = ["HK", "iMobile", "DICO", "Exyon"];
const DEFAULT_STOCK_SOURCE = "iMobile";

// Accepts any casing so a value typed as "hk" still lands on "HK".
function normalizeStockSource(v, fallback = "") {
  const s = String(v == null ? "" : v).trim();
  const hit = STOCK_SOURCES.find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || fallback;
}

function stockSourceForUser(user) {
  if (user && user.role === "phone-supplier") {
    return normalizeStockSource(user.stockSource);
  }
  return DEFAULT_STOCK_SOURCE;
}

// Device status — where the unit stands, decided by who recorded it (same
// rule as the source: never client-supplied). A device a supplier records
// is still theirs ("Supplier Stock"); one recorded by our own staff, or
// received through Incoming Stocks, is ours ("In Stock").
const STATUS_IN_STOCK = "In Stock";
const STATUS_SUPPLIER_STOCK = "Supplier Stock";
// Received on Exyon's behalf — never sat in our stock.
const STATUS_ASSIGNED_EXYON = "Assigned To Exyon";

function statusForUser(user) {
  return user && user.role === "phone-supplier" ? STATUS_SUPPLIER_STOCK : STATUS_IN_STOCK;
}

module.exports = {
  STOCK_SOURCES,
  DEFAULT_STOCK_SOURCE,
  normalizeStockSource,
  stockSourceForUser,
  STATUS_IN_STOCK,
  STATUS_SUPPLIER_STOCK,
  STATUS_ASSIGNED_EXYON,
  statusForUser,
};
