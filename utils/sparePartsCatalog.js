// The spare parts catalogue behind the Spare Parts widget (iMobile website,
// user ask 2026-09-30): every live spare part that the online store shows,
// browsable Brand → Series → Model → part type, from the stock register
// (imb_stock_items — Zoho's Device Brand / Device Series / Compatible Model /
// Classification custom fields). No prices by the user's choice; a part
// links to https://www.imobilestore.com.au/products/<Zoho item id> (the
// store redirects that to the product page). Images are the store's public
// ones by Zoho image id (utils/productImage), so browsing never calls Zoho.
//
// Built in memory from Mongo and kept 10 minutes. Used by the public widget
// feed (routes/widgetRoutes/spareParts.js) and the dashboard's Spare Parts
// Widget page (routes/websiteRoutes).

const { connectToDatabase } = require("./mongodb");

const ITEMS = "imb_stock_items";
const CACHE_MS = 10 * 60 * 1000;
const PRODUCT_BASE = "https://www.imobilestore.com.au/products/";

// Part types in the order the widget shows them.
const TYPES = ["Screen", "Battery", "BackCover", "Housing", "Middle Frame", "Small Parts", "Tools", "Other"];
const TYPE_LABELS = { BackCover: "Back Cover" };
const typeRank = (t) => {
  const i = TYPES.indexOf(t);
  return i < 0 ? TYPES.length : i;
};

let cache = null; // { at, ... }
let building = null;

// iPads and Apple Watches are named too unevenly for a generation number
// (sizes, "4th Gen", years), so they sort by release year; names without
// one are looked up here.
const IPAD_YEARS = {
  "iPad 1": 2010, "iPad 2": 2011, "iPad 3": 2012, "iPad 4": 2012.5,
  "iPad Mini 1": 2012, "iPad Mini 2": 2013, "iPad Mini 3": 2014, "iPad Mini 4": 2015, "iPad Mini 5": 2019, "iPad Mini 8": 2026,
  "iPad Air 1": 2013, "iPad Air 2": 2014, "iPad Air 3": 2019,
  "iPad Pro 9.7": 2016, "iPad Pro 10.5": 2017, "iPad Pro 12.9": 2015, "iPad Pro 11": 2018, "iPad Pro 13": 2024,
};
function releaseYear(m) {
  const year = m.match(/\b(20\d\d)\b/);
  if (/^iPad/.test(m)) return year ? +year[1] : IPAD_YEARS[m.trim()] || 2010;
  let n;
  if ((n = m.match(/iWatch Series (\d+)/))) return +n[1] <= 2 ? 2016 : 2014 + +n[1];
  if ((n = m.match(/iWatch SE (\d+)/))) return { 1: 2020, 2: 2022, 3: 2025 }[n[1]] || 2020;
  if ((n = m.match(/iWatch Ultra (\d+)/))) return { 1: 2022, 2: 2023, 3: 2025 }[n[1]] || 2022;
  if (/iWatch 1st Gen/.test(m)) return 2015;
  return null;
}

// Newest first: the generation number in the model name. Codes, sizes and
// years in brackets are ignored ("Galaxy S25 FE (S731)" → 25); a few Apple
// names say their generation another way.
function generation(model) {
  const m = String(model);
  const y = releaseYear(m);
  if (y != null) return y;
  const a = m.match(/\bA(\d{4})\b/); // MacBook: the A-number rises over time
  if (a) return +a[1];
  if (/iPhone X/.test(m)) return 10 + (/XS Max/.test(m) ? 0.3 : /XS/.test(m) ? 0.2 : /XR/.test(m) ? 0.1 : 0);
  const year = m.match(/\b(20\d\d)\b/);
  if (/iPhone SE/.test(m)) return { 2016: 6.5, 2020: 11.5, 2022: 13.5 }[year && year[1]] || 6;
  const gen = m.match(/(\d+)(?:st|nd|rd|th) Gen/i);
  if (gen) return +gen[1];
  const bare = m.replace(/\([^)]*\)/g, " ").replace(/\d+(\.\d+)?\s*("|inch|mm)/gi, " ");
  const whole = bare.match(/(?:^|[^\d.])(\d+)(?![\d.])/); // a whole number, not a screen size like 12.9
  if (whole) return +whole[1];
  const any = bare.match(/(\d+(?:\.\d+)?)/);
  return any ? parseFloat(any[1]) : -1;
}
const byNewest = (a, b) => generation(b.name) - generation(a.name) ||
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function shapeItem(r) {
  return {
    id: String(r.itemId),
    name: r.name || "",
    sku: r.sku || "",
    type: r.classification || "Other",
    sub: r.subClassification || "",
    quality: r.quality || "",
    imageId: r.imageId || null,
    brand: r.deviceBrand || "",
    models: Array.isArray(r.compatibleModels) ? r.compatibleModels.filter(Boolean) : [],
  };
}

async function build() {
  const db = await connectToDatabase();
  const rows = await db.collection(ITEMS)
    .find(
      { active: true, archived: false, scope: "parts", showInStore: true },
      { projection: { _id: 0, itemId: 1, name: 1, sku: 1, classification: 1, subClassification: 1, quality: 1, imageId: 1, deviceBrand: 1, deviceSeries: 1, compatibleModels: 1 } },
    )
    .toArray();

  const items = [];
  const votes = new Map(); // "brand|model" → Map(series → count)
  const modelItems = new Map(); // "brand|model" → [item index]
  for (const r of rows) {
    if (!TYPES.includes(r.classification)) continue; // stray classifications stay out
    const it = shapeItem(r);
    const idx = items.push(it) - 1;
    if (!it.brand) continue;
    const series = String(r.deviceSeries || "").split(";").map((s) => s.trim()).filter(Boolean);
    for (const model of it.models) {
      const key = `${it.brand}|${model}`;
      if (!modelItems.has(key)) modelItems.set(key, []);
      modelItems.get(key).push(idx);
      // an item with one series says where its models belong
      if (series.length === 1) {
        if (!votes.has(key)) votes.set(key, new Map());
        const v = votes.get(key);
        v.set(series[0], (v.get(series[0]) || 0) + 1);
      }
    }
  }

  // brand → series → models
  const brandMap = new Map();
  for (const [key, idxs] of modelItems) {
    const [brand, model] = key.split(/\|(.*)/s);
    const v = votes.get(key);
    const series = v ? [...v.entries()].sort((a, b) => b[1] - a[1])[0][0] : "";
    if (!brandMap.has(brand)) brandMap.set(brand, new Map());
    const sm = brandMap.get(brand);
    if (!sm.has(series)) sm.set(series, []);
    sm.get(series).push({ name: model, parts: idxs.length, idxs });
  }
  const brands = [];
  for (const [brand, sm] of brandMap) {
    const brandItems = new Set();
    const series = [];
    for (const [name, models] of sm) {
      const seriesItems = new Set();
      models.forEach((m) => m.idxs.forEach((i) => { seriesItems.add(i); brandItems.add(i); }));
      models.sort(byNewest);
      series.push({ name, parts: seriesItems.size, models: models.map((m) => ({ name: m.name, parts: m.parts })) });
    }
    // named series by size; models without one last, as "Other models"
    series.sort((a, b) => (!a.name) - (!b.name) || b.parts - a.parts);
    if (series.length > 1 || series[0].name) series.forEach((s) => { if (!s.name) s.name = "Other models"; });
    brands.push({ name: brand, parts: brandItems.size, series });
  }
  // "Other" (small makers) goes last whatever its size
  brands.sort((a, b) => (a.name === "Other") - (b.name === "Other") || b.parts - a.parts);

  const tools = items.filter((i) => i.type === "Tools");
  return {
    at: new Date(),
    items,
    modelItems,
    brands,
    tools,
    counts: {
      parts: items.length,
      browsable: new Set([...modelItems.values()].flat()).size,
      models: modelItems.size,
      brands: brands.length,
      tools: tools.length,
      withImage: items.filter((i) => i.imageId).length,
    },
  };
}

async function getCatalog() {
  if (cache && Date.now() - cache.at.getTime() < CACHE_MS) return cache;
  if (!building) {
    building = build()
      .then((c) => { cache = c; })
      .finally(() => { building = null; });
  }
  try {
    await building;
  } catch (e) {
    if (cache) return cache; // the last catalogue beats an error
    throw e;
  }
  return cache;
}

const sortParts = (list) => [...list].sort((a, b) => typeRank(a.type) - typeRank(b.type) ||
  a.sub.localeCompare(b.sub) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

// What the widget gets for a part — models dropped (the page already knows).
const publicItem = (i) => ({ id: i.id, name: i.name, sku: i.sku, type: i.type, sub: i.sub, quality: i.quality, imageId: i.imageId });

function partsForModel(cat, brand, model) {
  const idxs = cat.modelItems.get(`${brand}|${model}`) || [];
  return sortParts(idxs.map((i) => cat.items[i])).map(publicItem);
}

function toolParts(cat) {
  return sortParts(cat.tools).map(publicItem);
}

const wordsOf = (text) => String(text || "").toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);

// Does a search word match a list of words? Letters match the start of a
// word ("bat" → battery); a number must be a whole word, so "13" finds
// iPhone 13 and not iPhone 11 parts whose SKU starts 13….
function wordHit(w, list) {
  return /^\d+$/.test(w) ? list.includes(w) : list.some((x) => x.startsWith(w));
}

// Every word must match the name or a compatible model; a lone word may also
// be the start of a SKU.
function search(cat, q) {
  const raw = String(q || "").trim().toLowerCase();
  const words = wordsOf(raw).slice(0, 8);
  if (!words.length) return { models: [], items: [], total: 0 };
  const found = [];
  for (const i of cat.items) {
    const sku = i.sku.toLowerCase();
    if (sku && (sku === raw || (words.length === 1 && sku.startsWith(raw)))) { found.push(i); continue; }
    const list = wordsOf(`${i.name} ${i.models.join(" ")}`);
    if (words.every((w) => wordHit(w, list))) found.push(i);
  }

  // models: the words that name a model ("iphone 13 pro screen" → iPhone 13
  // Pro, iPhone 13 Pro Max), leaving out part words like "screen"
  const all = [];
  for (const b of cat.brands) {
    for (const s of b.series) for (const m of s.models) all.push({ brand: b.name, series: s.name, name: m.name, parts: m.parts, list: wordsOf(`${b.name} ${m.name}`) });
  }
  const modelWords = words.filter((w) => all.some((m) => wordHit(w, m.list)));
  const models = modelWords.length
    ? all.filter((m) => modelWords.every((w) => wordHit(w, m.list)))
      // the closest names first: fewest extra words, then the most parts
      .sort((a, b) => a.list.length - b.list.length || b.parts - a.parts)
      .slice(0, 12)
      .map(({ list, ...m }) => m)
    : [];

  return { models, items: sortParts(found).slice(0, 60).map(publicItem), total: found.length };
}

module.exports = { getCatalog, partsForModel, toolParts, search, TYPES, TYPE_LABELS, PRODUCT_BASE, generation };
