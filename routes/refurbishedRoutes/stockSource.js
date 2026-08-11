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

// Device location — where the unit physically sits. Set by who recorded it
// (a supplier's device stays at the supplier), or picked from a whitelist
// when receiving through Incoming Stocks. Never free text from the client.
const LOCATION_IMOBILE = "iMobile";
const LOCATION_SUPPLIER = "Supplier Stock";
const LOCATION_EXYON = "Assigned To Exyon";
// What the receive dialog may choose from.
const RECEIVE_LOCATIONS = [LOCATION_IMOBILE, LOCATION_EXYON];

function locationForUser(user) {
  return user && user.role === "phone-supplier" ? LOCATION_SUPPLIER : LOCATION_IMOBILE;
}

function normalizeReceiveLocation(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return RECEIVE_LOCATIONS.find((x) => x.toLowerCase() === s) || LOCATION_IMOBILE;
}

module.exports = {
  STOCK_SOURCES,
  DEFAULT_STOCK_SOURCE,
  normalizeStockSource,
  stockSourceForUser,
  LOCATION_IMOBILE,
  LOCATION_SUPPLIER,
  LOCATION_EXYON,
  RECEIVE_LOCATIONS,
  locationForUser,
  normalizeReceiveLocation,
};
