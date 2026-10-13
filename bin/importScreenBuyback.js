// Load the "ABCD grade price list" workbook into imb_screen_buyback (the
// iMobile → Screen Buyback page). Dry run by default; --apply writes.
//
//   node bin/importScreenBuyback.js "<path to .xlsx>" [--apply]
//
// Phones sheet: one column of models per brand (header = brand), top-down
// order kept (newest first). Price sheet: Models | A Grade … D Grade. A
// priced model missing from the Phones sheet takes the brand its name
// implies (iPhone…, iPad…, Pixel… → Google, S/Note/Fold|Flip/A… →
// Samsung_*) and goes to the TOP of that brand (they were the newest).
// Model names are whitespace-trimmed on both sheets (the file carries
// trailing spaces). Existing rows (same model, case-insensitive) are
// updated, not duplicated, so the import can be re-run.
require("dotenv").config();
const XLSX = require("xlsx-js-style");
const { connectToDatabase } = require("../utils/mongodb");

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('usage: node bin/importScreenBuyback.js "<xlsx>" [--apply]'); process.exit(1); }
const APPLY = flag === "--apply";
const MODELS = "imb_screen_buyback";
const META = "imb_screen_buyback_meta";
const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const money = (v) => { if (v === "" || v == null) return null; const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const guessBrand = (m) =>
  /^iPhone/i.test(m) ? "iPhone" : /^iPad/i.test(m) ? "iPad" : /^Pixel/i.test(m) ? "Google"
    : /^S\d/i.test(m) ? "Samsung_S" : /^Note/i.test(m) ? "Samsung_Note" : /^(Fold|Flip)/i.test(m) ? "Samsung_F" : /^A\d/i.test(m) ? "Samsung_A" : "";

(async () => {
  const wb = XLSX.readFile(file);
  const phones = XLSX.utils.sheet_to_json(wb.Sheets.Phones, { header: 1, defval: "" });
  const price = XLSX.utils.sheet_to_json(wb.Sheets.Price, { header: 1, defval: "", raw: true });
  const brands = phones[0].map(norm).filter(Boolean);
  const place = new Map(); // model → { brand, idx }
  phones.slice(1).forEach((row, i) => row.forEach((cell, c) => { const m = norm(cell); if (m && brands[c] && !place.has(m)) place.set(m, { brand: brands[c], idx: i }); }));

  const rows = new Map(); // model → doc
  for (const r of price.slice(1)) {
    const model = norm(r[0]);
    if (!model) continue;
    const prices = { A: money(r[1]), B: money(r[2]), C: money(r[3]), D: money(r[4]) };
    const p = place.get(model);
    const brand = p ? p.brand : guessBrand(model);
    if (!brand) { console.log("skipped (no brand):", model); continue; }
    rows.set(model, { brand, model, prices, idx: p ? p.idx : -1 });
  }
  for (const [model, p] of place) if (!rows.has(model)) rows.set(model, { brand: p.brand, model, prices: { A: null, B: null, C: null, D: null }, idx: p.idx });

  // order inside a brand: Price-only models first (newest, in Price order),
  // then the Phones column order
  const docs = [...rows.values()];
  const perBrand = new Map();
  for (const d of docs) (perBrand.get(d.brand) || perBrand.set(d.brand, []).get(d.brand)).push(d);
  for (const list of perBrand.values()) {
    const extra = list.filter((d) => d.idx < 0);
    const listed = list.filter((d) => d.idx >= 0).sort((a, b) => a.idx - b.idx);
    [...extra, ...listed].forEach((d, i) => { d.sort = i; });
  }
  const order = [...brands, ...[...perBrand.keys()].filter((b) => !brands.includes(b)).sort()];
  console.log(`${docs.length} models across ${perBrand.size} brands:`, order.map((b) => `${b} ${(perBrand.get(b) || []).length}`).join(" | "));
  console.log("brand inferred for:", docs.filter((d) => d.idx < 0).map((d) => `${d.model} → ${d.brand}`).join("; "));
  if (!APPLY) { console.log("\ndry run — add --apply to write"); process.exit(0); }

  const db = await connectToDatabase();
  const col = db.collection(MODELS);
  const now = new Date();
  let inserted = 0, updated = 0;
  for (const d of docs) {
    const re = new RegExp(`^${d.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const r = await col.updateOne(
      { model: re, deleted: { $ne: true } },
      { $set: { brand: d.brand, model: d.model, prices: d.prices, sort: d.sort, updatedAt: now, updatedBy: "import" },
        $setOnInsert: { note: "", deleted: false, createdAt: now, createdBy: "import" } },
      { upsert: true },
    );
    if (r.upsertedCount) inserted++; else if (r.matchedCount) updated++;
  }
  await db.collection(META).updateOne({ _id: "brands" }, { $set: { order, updatedAt: now } }, { upsert: true });
  console.log(`done: ${inserted} inserted, ${updated} updated; brand order saved`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
