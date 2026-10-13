// iMobile → Screen Buyback: the "ABCD grade price list" — what we pay back
// for a returned screen, per model and condition grade (A/B/C/D; iPads A/B
// only). Kept in the dashboard (user ask 2026-10-13) instead of the shared
// workbook, with that workbook re-generated on demand so the buyback sheet
// keeps working: a Phones sheet (one column of models per brand, each a
// named range), a Price sheet (model × grade) and a Buyback sheet whose
// Model dropdown follows the Brand (INDIRECT on the named range) and whose
// Price looks the model + grade up on the Price sheet.
//
//   GET    /screen-buyback/models            every live model, brand order
//   POST   /screen-buyback/models            add one (tops its brand)
//   PUT    /screen-buyback/models/:id        edit one
//   PUT    /screen-buyback/brands/:brand/order { ids } — the brand's order, saved in one go
//   DELETE /screen-buyback/models/:id        soft delete
//   GET    /screen-buyback/export            the workbook (.xlsx)
//
// Collections: imb_screen_buyback (one doc per model: brand, model, prices
// { A, B, C, D }, sort, note, deleted) and imb_screen_buyback_meta
// ({ _id: "brands", order: [...] } — the brand order, which is the column
// order of the Phones sheet).
const express = require("express");
const { ObjectId } = require("mongodb");
const ExcelJS = require("exceljs");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const router = express.Router();
const VIEW = requirePermission("buyback:price:view");
const MANAGE = requirePermission("buyback:price:manage");

const MODELS = "imb_screen_buyback";
const META = "imb_screen_buyback_meta";
const GRADES = ["A", "B", "C", "D"];
// A brand doubles as an Excel defined name (the Model dropdown resolves
// INDIRECT(brand)), so it must be a valid one: letters, digits, _ ; not a
// cell reference.
const BRAND_RE = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
const CELL_LIKE = /^[A-Za-z]{1,3}\d{1,7}$/;

const str = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const who = (req) => (req.user && (req.user.username || req.user.name)) || null;

function cleanPrices(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  for (const g of GRADES) {
    const raw = src[g];
    if (raw === "" || raw == null) { out[g] = null; continue; }
    const n = Number(String(raw).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: `${g} grade price must be a number from 0 to 100,000` };
    out[g] = Math.round(n * 100) / 100;
  }
  return { prices: out };
}

function cleanBrand(v) {
  const b = str(v, 31);
  if (!b) return { error: "Brand is required" };
  if (!BRAND_RE.test(b) || CELL_LIKE.test(b)) return { error: "Brand may hold letters, digits and _ only (it names the Excel dropdown)" };
  return { brand: b };
}

async function brandOrder(db) {
  const meta = await db.collection(META).findOne({ _id: "brands" });
  return (meta && Array.isArray(meta.order)) ? meta.order : [];
}
// a brand new to the list goes to the end of the order
async function ensureBrand(db, brand) {
  await db.collection(META).updateOne(
    { _id: "brands" },
    { $addToSet: { order: brand }, $set: { updatedAt: new Date() } },
    { upsert: true },
  );
}
// the live rows in brand order, newest (lowest sort) first inside a brand
async function liveRows(db) {
  const order = await brandOrder(db);
  const rank = new Map(order.map((b, i) => [b, i]));
  const rows = await db.collection(MODELS).find({ deleted: { $ne: true } }).toArray();
  rows.sort((a, b) => {
    const ra = rank.has(a.brand) ? rank.get(a.brand) : order.length;
    const rb = rank.has(b.brand) ? rank.get(b.brand) : order.length;
    return ra - rb || String(a.brand).localeCompare(String(b.brand)) || (a.sort || 0) - (b.sort || 0) || String(a.model).localeCompare(String(b.model));
  });
  return { rows, order: [...order, ...[...new Set(rows.map((r) => r.brand))].filter((b) => !rank.has(b)).sort()] };
}
const shape = (r) => ({
  id: String(r._id), brand: r.brand, model: r.model, prices: { ...r.prices }, note: r.note || "",
  sort: r.sort || 0, updatedAt: r.updatedAt, updatedBy: r.updatedBy || null,
});
async function duplicate(db, model, exceptId) {
  const re = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const q = { model: re, deleted: { $ne: true } };
  if (exceptId) q._id = { $ne: exceptId };
  return db.collection(MODELS).findOne(q, { projection: { _id: 1 } });
}

// ── read ────────────────────────────────────────────────────────────
router.get("/models", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const { rows, order } = await liveRows(db);
    return res.json({ success: true, rows: rows.map(shape), brands: order });
  } catch (e) {
    console.error("screen buyback list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the price list" });
  }
});

// ── add ─────────────────────────────────────────────────────────────
router.post("/models", MANAGE, async (req, res) => {
  try {
    const body = req.body || {};
    const b = cleanBrand(body.brand);
    if (b.error) return res.status(400).json({ success: false, message: b.error });
    const model = str(body.model, 60);
    if (!model) return res.status(400).json({ success: false, message: "Model is required" });
    const p = cleanPrices(body.prices);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    const db = await connectToDatabase();
    if (await duplicate(db, model)) return res.status(409).json({ success: false, message: `"${model}" is already on the list` });
    await ensureBrand(db, b.brand);
    // newest first: the new model tops its brand
    const top = await db.collection(MODELS).find({ brand: b.brand, deleted: { $ne: true } }).sort({ sort: 1 }).limit(1).next();
    const now = new Date();
    const doc = {
      brand: b.brand, model, prices: p.prices, note: str(body.note, 200),
      sort: top ? (top.sort || 0) - 1 : 0, deleted: false,
      createdAt: now, createdBy: who(req), updatedAt: now, updatedBy: who(req),
    };
    const r = await db.collection(MODELS).insertOne(doc);
    return res.json({ success: true, row: shape({ _id: r.insertedId, ...doc }) });
  } catch (e) {
    console.error("screen buyback add error:", e);
    return res.status(500).json({ success: false, message: "Failed to add the model" });
  }
});

// ── edit ────────────────────────────────────────────────────────────
router.put("/models/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const _id = new ObjectId(req.params.id);
    const body = req.body || {};
    const b = cleanBrand(body.brand);
    if (b.error) return res.status(400).json({ success: false, message: b.error });
    const model = str(body.model, 60);
    if (!model) return res.status(400).json({ success: false, message: "Model is required" });
    const p = cleanPrices(body.prices);
    if (p.error) return res.status(400).json({ success: false, message: p.error });
    const db = await connectToDatabase();
    const cur = await db.collection(MODELS).findOne({ _id, deleted: { $ne: true } });
    if (!cur) return res.status(404).json({ success: false, message: "Model not found" });
    if (await duplicate(db, model, _id)) return res.status(409).json({ success: false, message: `"${model}" is already on the list` });
    await ensureBrand(db, b.brand);
    const set = { brand: b.brand, model, prices: p.prices, note: str(body.note, 200), updatedAt: new Date(), updatedBy: who(req) };
    if (b.brand !== cur.brand) {
      const top = await db.collection(MODELS).find({ brand: b.brand, deleted: { $ne: true } }).sort({ sort: 1 }).limit(1).next();
      set.sort = top ? (top.sort || 0) - 1 : 0;
    }
    await db.collection(MODELS).updateOne({ _id }, { $set: set });
    return res.json({ success: true, row: shape({ ...cur, ...set, _id }) });
  } catch (e) {
    console.error("screen buyback edit error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the model" });
  }
});

// ── the order inside a brand (the Phones column / dropdown order) ───
// body { ids } — the brand's live models in the wanted order (the page's
// drag-and-drop, saved in one go). Any the list leaves out keep their
// place after the listed ones.
router.put("/brands/:brand/order", MANAGE, async (req, res) => {
  try {
    const b = cleanBrand(req.params.brand);
    if (b.error) return res.status(400).json({ success: false, message: b.error });
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).filter((id) => ObjectId.isValid(id)) : [];
    const db = await connectToDatabase();
    const col = db.collection(MODELS);
    const rows = await col.find({ brand: b.brand, deleted: { $ne: true } }).sort({ sort: 1, model: 1 }).toArray();
    const live = new Set(rows.map((r) => String(r._id)));
    const ordered = ids.filter((id, i) => live.has(id) && ids.indexOf(id) === i);
    const rest = rows.map((r) => String(r._id)).filter((id) => !ordered.includes(id));
    const finalIds = [...ordered, ...rest];
    if (finalIds.length) {
      await col.bulkWrite(finalIds.map((id, i) => ({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $set: { sort: i, updatedAt: new Date(), updatedBy: who(req) } } } })));
    }
    return res.json({ success: true, count: finalIds.length });
  } catch (e) {
    console.error("screen buyback order error:", e);
    return res.status(500).json({ success: false, message: "Failed to save the order" });
  }
});

// ── delete (soft) ───────────────────────────────────────────────────
router.delete("/models/:id", MANAGE, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Bad id" });
    const db = await connectToDatabase();
    const r = await db.collection(MODELS).updateOne(
      { _id: new ObjectId(req.params.id), deleted: { $ne: true } },
      { $set: { deleted: true, deletedAt: new Date(), deletedBy: who(req) } },
    );
    if (!r.matchedCount) return res.status(404).json({ success: false, message: "Model not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("screen buyback delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the model" });
  }
});

// ── the workbook ────────────────────────────────────────────────────
// Three sheets, the shape of the original file:
//   Phones  — one column per brand (header = brand), its models top-down,
//             each column a defined name = the brand (the Model dropdown's
//             INDIRECT target)
//   Price   — Models | A Grade … D Grade; N2 = COUNTA(A:A) and N3 = the last
//             model (the Buyback lookups size themselves on N2, so rows
//             typed straight into this sheet still count); J2:J5 the grades
//   Buyback — the entry sheet: Brand → Model (dropdown follows the brand) →
//             Grade → Price (looked up) × QTY = Total, with a totals row
const ENTRY_ROWS = 40;
const MONEY = '"$"#,##0.00';
function excelName(brand) { return brand; } // validated on the way in (BRAND_RE)

async function buildWorkbook(db) {
  const { rows, order } = await liveRows(db);
  const wb = new ExcelJS.Workbook();
  wb.creator = "iMobile Dashboard";
  wb.created = new Date();
  const head = { font: { bold: true }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } }, alignment: { vertical: "middle", wrapText: true } };

  // ── Phones ──
  const phones = wb.addWorksheet("Phones");
  const byBrand = new Map(order.map((b) => [b, []]));
  for (const r of rows) (byBrand.get(r.brand) || byBrand.set(r.brand, []).get(r.brand)).push(r.model);
  const brands = [...byBrand.keys()].filter((b) => byBrand.get(b).length);
  brands.forEach((b, c) => {
    const col = c + 1;
    phones.getCell(1, col).value = b;
    phones.getCell(1, col).style = head;
    const models = byBrand.get(b);
    models.forEach((m, i) => { phones.getCell(i + 2, col).value = m; });
    phones.getColumn(col).width = Math.min(34, Math.max(14, ...models.map((m) => m.length + 2)));
    const colLetter = phones.getColumn(col).letter;
    wb.definedNames.add(`Phones!$${colLetter}$2:$${colLetter}$${models.length + 1}`, excelName(b));
  });
  phones.views = [{ state: "frozen", ySplit: 1 }];
  const lastBrandCol = phones.getColumn(Math.max(1, brands.length)).letter;

  // ── Price ──
  const price = wb.addWorksheet("Price");
  ["Models", "A Grade", "B Grade", "C Grade", "D Grade"].forEach((h, i) => { price.getCell(1, i + 1).value = h; price.getCell(1, i + 1).style = head; });
  rows.forEach((r, i) => {
    const row = i + 2;
    price.getCell(row, 1).value = r.model;
    GRADES.forEach((g, k) => {
      const v = r.prices && r.prices[g];
      if (v != null) { price.getCell(row, k + 2).value = v; price.getCell(row, k + 2).numFmt = MONEY; }
    });
  });
  price.getColumn(1).width = 26;
  for (let c = 2; c <= 5; c++) price.getColumn(c).width = 11;
  // the grade list (the Buyback sheet's Grade dropdown) and the row count
  price.getCell("J1").value = "Grades"; price.getCell("J1").style = head;
  GRADES.forEach((g, i) => { price.getCell(i + 2, 10).value = `${g} Grade`; });
  price.getCell("M2").value = "Last Cell:";
  price.getCell("N2").value = { formula: "COUNTA($A:$A)", result: rows.length + 1 };
  price.getCell("N3").value = { formula: 'INDIRECT("A"&N2)', result: rows.length ? rows[rows.length - 1].model : "" };
  price.getColumn(14).width = 18;
  price.views = [{ state: "frozen", ySplit: 1 }];

  // ── Buyback ──
  const sheet = wb.addWorksheet("Buyback");
  const headers = ["Brand\n（品牌）", "Model\n（型号）", "Models not listed\n（其他型号）", "Grade\n（等级）", "Price （价格）", "QTY\n（数量）", "Total （总价）", "Return\n(退回)", "Received\n（数量）", "Quantity\n(数量)", "备注"];
  headers.forEach((h, i) => { sheet.getCell(1, i + 1).value = h; sheet.getCell(1, i + 1).style = { ...head, alignment: { vertical: "middle", horizontal: "center", wrapText: true } }; });
  sheet.getRow(1).height = 34;
  [14, 24, 22, 15, 12, 10, 12, 10, 10, 10, 24].forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  const first = 2;
  const last = first + ENTRY_ROWS - 1;
  for (let r = first; r <= last; r++) {
    // the price: the model's row on the Price sheet × the grade's column
    sheet.getCell(r, 5).value = { formula: `IFERROR(INDEX(INDIRECT("Price!$A$2:$E"&Price!$N$2),MATCH(B${r},INDIRECT("Price!$A$2:$A"&Price!$N$2),0),MATCH(D${r},Price!$B$1:$E$1,0)+1),"")`, result: "" };
    sheet.getCell(r, 5).numFmt = MONEY;
    sheet.getCell(r, 7).value = { formula: `IF(E${r}="","",E${r}*F${r})`, result: "" };
    sheet.getCell(r, 7).numFmt = MONEY;
    sheet.getCell(r, 7).font = { bold: true };
  }
  const totalRow = last + 2;
  sheet.getCell(totalRow, 4).value = "Total";
  sheet.getCell(totalRow, 4).font = { bold: true };
  for (const c of [5, 6, 7, 8, 9, 10]) {
    const L = sheet.getColumn(c).letter;
    sheet.getCell(totalRow, c).value = { formula: `SUM(${L}${first}:${L}${last})`, result: 0 };
    sheet.getCell(totalRow, c).font = { bold: true };
    if (c === 5 || c === 7) sheet.getCell(totalRow, c).numFmt = MONEY;
  }
  // the dropdowns: Brand from the Phones header, Model from the brand's
  // named range, Grade from the Price sheet's list
  for (let r = first; r <= last; r++) {
    sheet.getCell(r, 1).dataValidation = { type: "list", allowBlank: true, formulae: [`=Phones!$A$1:$${lastBrandCol}$1`], showErrorMessage: false };
    sheet.getCell(r, 2).dataValidation = { type: "list", allowBlank: true, formulae: [`=INDIRECT($A${r})`], showErrorMessage: false };
    sheet.getCell(r, 4).dataValidation = { type: "list", allowBlank: true, formulae: ["=Price!$J$2:$J$5"], showErrorMessage: false };
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 2, activeTab: 2, visibility: "visible" }];
  return wb;
}

router.get("/export", VIEW, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const wb = await buildWorkbook(db);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="ABCD grade price list ${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("screen buyback export error:", e);
    if (!res.headersSent) res.status(500).json({ success: false, message: "Failed to build the workbook" });
  }
});

module.exports = router;
module.exports.buildWorkbook = buildWorkbook;
