// Collection filters — a collection's rule, evaluated against the stock
// register (imb_stock_items) instead of Zoho Analytics (2026-09-22).
//
// A collection document carries
//   filter:   { rows: [{ field, op, value, join }] }
//   products: [{ itemId, … }]                         (pinned by hand)
// and its members are the register rows the filter matches, plus the
// pinned ones. Rows join with AND / OR the way the builder shows them:
// consecutive ANDs form a group, OR starts a new group, groups are ORed.
// The vocabulary below is the single source of truth — the dialog reads it
// from GET …/collections/filter-options, so a field added here appears in
// the builder with its operators and the register's current values.
//
// Why the register: it holds every active item with Zoho's catalogue
// custom fields (classification, quality, device brand / series / models,
// shown in store …), so a rule can say what it means ("Sub Classification
// is Rear Camera") instead of guessing at words in the name, and it is
// evaluated in milliseconds on every read — no Analytics call, no lag, no
// raw criteria strings.

const { ITEMS } = require("./stockItems");

// type: how a value is entered and matched.
//   text — free text, matched case-insensitively (contains / starts / is …)
//   pick — one of the register's current values (still free text underneath)
//   list — a field holding several values per item (Compatible Model)
//   bool — yes / no
const FIELDS = [
  { key: "name", label: "Product Name", type: "text", path: "name" },
  { key: "sku", label: "SKU", type: "text", path: "sku" },
  { key: "classification", label: "Classification", type: "pick", path: "classification" },
  { key: "subClassification", label: "Sub Classification", type: "pick", path: "subClassification" },
  { key: "quality", label: "Quality", type: "pick", path: "quality" },
  { key: "deviceBrand", label: "Device Brand", type: "pick", path: "deviceBrand" },
  { key: "deviceSeries", label: "Device Series", type: "pick", path: "deviceSeries" },
  { key: "compatibleModels", label: "Compatible Model", type: "list", path: "compatibleModels" },
  { key: "zohoBrand", label: "Brand (Zoho)", type: "pick", path: "zohoBrand" },
  { key: "zohoCategory", label: "Category (Zoho)", type: "pick", path: "zohoCategory" },
  { key: "preferVendor", label: "Prefer Vendor", type: "pick", path: "preferVendor" },
  { key: "location", label: "Shelf", type: "text", path: "location" },
  { key: "showInStore", label: "Shown in Store", type: "bool", path: "showInStore" },
];
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

// value: "one" = a single value, "many" = a list, "none" = no value.
const OPS = {
  text: [
    { key: "contains", label: "contains", value: "one" },
    { key: "ncontains", label: "doesn't contain", value: "one" },
    { key: "containsAny", label: "contains any of", value: "many" },
    { key: "starts", label: "starts with", value: "one" },
    { key: "eq", label: "is", value: "one" },
    { key: "ne", label: "is not", value: "one" },
    { key: "set", label: "is set", value: "none" },
    { key: "notset", label: "is not set", value: "none" },
  ],
  pick: [
    { key: "eq", label: "is", value: "one" },
    { key: "ne", label: "is not", value: "one" },
    { key: "in", label: "is any of", value: "many" },
    { key: "nin", label: "is none of", value: "many" },
    { key: "contains", label: "contains", value: "one" },
    { key: "set", label: "is set", value: "none" },
    { key: "notset", label: "is not set", value: "none" },
  ],
  list: [
    { key: "has", label: "includes", value: "one" },
    { key: "nhas", label: "doesn't include", value: "one" },
    { key: "hasAny", label: "includes any of", value: "many" },
    { key: "contains", label: "any model contains", value: "one" },
    { key: "set", label: "is set", value: "none" },
    { key: "notset", label: "is not set", value: "none" },
  ],
  bool: [
    { key: "yes", label: "is yes", value: "none" },
    { key: "no", label: "is no", value: "none" },
  ],
};

const SCOPE_BY_STORE = { productCollections: "parts", accessoryCollections: "accessory" };
const TAG_FIELD_BY_STORE = { productCollections: "collections", accessoryCollections: "accessoryCollections" };

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Real RegExp values, not { $regex } documents: only those are legal inside
// $in / $nin, and the driver sends them as BSON regexes everywhere.
const rx = (pattern) => new RegExp(pattern, "i");
const exact = (v) => rx(`^${escapeRegex(v)}$`);

// Trim, drop empties, and give every op the value shape it expects.
function cleanValue(op, raw) {
  const many = Array.isArray(raw) ? raw : raw == null ? [] : String(raw).split(/\r?\n/);
  const values = many.map((v) => String(v).trim()).filter(Boolean);
  if (op.value === "none") return null;
  if (op.value === "many") return values;
  return values.length ? values[0] : "";
}

// Rows as stored → validated rows, or a thrown Error naming the problem.
// Rows with no usable value are dropped (the dialog filters them the same
// way), so a half-typed row never silently matches everything.
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const field = FIELD_BY_KEY.get(String(r.field || ""));
    if (!field) throw new Error(`Unknown filter field "${r.field}"`);
    const op = OPS[field.type].find((o) => o.key === String(r.op || ""));
    if (!op) throw new Error(`"${op ? op.key : r.op}" is not a condition for ${field.label}`);
    const value = cleanValue(op, r.value);
    if (op.value === "one" && !value) continue;
    if (op.value === "many" && !value.length) continue;
    const row = { field: field.key, op: op.key, join: r.join === "or" ? "or" : "and" };
    if (op.value !== "none") row.value = value;
    out.push(row);
  }
  if (out.length) out[0].join = "and";
  return out;
}

// One row → one Mongo predicate on the register.
function clause(row) {
  const f = FIELD_BY_KEY.get(row.field);
  const p = f.path;
  const v = row.value;
  switch (row.op) {
    case "contains": return { [p]: rx(escapeRegex(v)) };
    case "ncontains": return { [p]: { $not: rx(escapeRegex(v)) } };
    case "containsAny": return { [p]: rx(`(${v.map(escapeRegex).join("|")})`) };
    case "starts": return { [p]: rx(`^${escapeRegex(v)}`) };
    case "eq": case "has": return { [p]: exact(v) };
    case "ne": case "nhas": return { [p]: { $not: exact(v) } };
    case "in": case "hasAny": return { [p]: { $in: v.map(exact) } };
    case "nin": return { [p]: { $nin: v.map(exact) } };
    // $in with null also matches a missing field.
    case "set": return { [p]: { $nin: ["", null, []] } };
    case "notset": return { [p]: { $in: ["", null, []] } };
    case "yes": return { [p]: true };
    case "no": return { [p]: { $ne: true } };
    default: throw new Error(`Unknown condition "${row.op}"`);
  }
}

// Validated rows → a Mongo predicate, or null when there are no rows (a
// collection with no rule matches nothing by rule — only its pinned items).
function compileRows(rows) {
  const clean = sanitizeRows(rows);
  if (!clean.length) return null;
  const groups = [[]];
  clean.forEach((r, i) => {
    if (i > 0 && r.join === "or") groups.push([]);
    groups[groups.length - 1].push(clause(r));
  });
  const one = (g) => (g.length === 1 ? g[0] : { $and: g });
  return groups.length === 1 ? one(groups[0]) : { $or: groups.map(one) };
}

// The register rows a collection holds: its rule within its own business
// (parts or accessories, never the Archive bucket), plus whatever was
// pinned by hand — pinned items count wherever they sit.
function collectionMatch(doc, scope) {
  const rule = compileRows(doc && doc.filter && doc.filter.rows);
  const pinned = ((doc && doc.products) || []).map((p) => String(p && p.itemId)).filter(Boolean);
  const ruleMatch = rule ? { scope, archived: { $ne: true }, ...rule } : null;
  const pinMatch = pinned.length ? { itemId: { $in: pinned } } : null;
  if (ruleMatch && pinMatch) return { active: true, $or: [ruleMatch, pinMatch] };
  if (ruleMatch) return { active: true, ...ruleMatch };
  if (pinMatch) return { active: true, ...pinMatch };
  return { itemId: { $in: [] } };
}

async function resolveCollectionItemIds(db, doc, scope) {
  const rows = await db.collection(ITEMS).find(collectionMatch(doc, scope), { projection: { _id: 0, itemId: 1 } }).toArray();
  return rows.map((r) => r.itemId);
}

// What a rule can be built from: the fields with their operators, and the
// register's current values for every pick / list field in this scope.
// A minute's cache — the dialog asks on every open.
const optionsCache = new Map();
async function filterOptions(db, scope) {
  const hit = optionsCache.get(scope);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const items = db.collection(ITEMS);
  const options = {};
  for (const f of FIELDS) {
    if (f.type !== "pick" && f.type !== "list") continue;
    const stages = [{ $match: { active: true, scope, archived: { $ne: true } } }];
    if (f.type === "list") stages.push({ $unwind: `$${f.path}` });
    stages.push({ $group: { _id: `$${f.path}` } });
    const rows = await items.aggregate(stages).toArray();
    options[f.key] = rows
      .map((r) => r._id)
      .filter((v) => typeof v === "string" && v.trim())
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  const value = { fields: FIELDS.map(({ key, label, type }) => ({ key, label, type })), ops: OPS, options };
  optionsCache.set(scope, { at: Date.now(), value });
  return value;
}

// "Matches N items" for the dialog, with a few names to sanity-check the
// rule by. Pinned products are deliberately left out: the count is what
// the rule alone catches.
async function previewRows(db, rows, scope, { sample = 8 } = {}) {
  const match = collectionMatch({ filter: { rows }, products: [] }, scope);
  const items = db.collection(ITEMS);
  const [count, names] = await Promise.all([
    items.countDocuments(match),
    items.find(match, { projection: { _id: 0, sku: 1, name: 1 } }).sort({ name: 1 }).limit(sample).toArray(),
  ]);
  return { count, sample: names };
}

module.exports = {
  FIELDS,
  OPS,
  SCOPE_BY_STORE,
  TAG_FIELD_BY_STORE,
  sanitizeRows,
  compileRows,
  collectionMatch,
  resolveCollectionItemIds,
  filterOptions,
  previewRows,
};
