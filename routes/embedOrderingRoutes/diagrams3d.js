// Embed Ordering — 3D Diagrams, the dashboard side (Embed Ordering → 3D Diagrams).
// Storage, file reading and part suggestions live in ./diagram3dStore.js;
// the widget's read-only endpoints are in ./widget.js.
//
//   GET    /embed-ordering/diagrams-3d                 list
//   GET    /embed-ordering/diagrams-3d/models          the widget catalogue's brands → series → models (+ which have one)
//   GET    /embed-ordering/diagrams-3d/items?q=        search all parts (to link one that isn't listed for the model)
//   POST   /embed-ordering/diagrams-3d                 create — multipart: file (.glb), brand, model, title?
//   GET    /embed-ordering/diagrams-3d/:id             one, + the model's items, linked items, suggestions
//   GET    /embed-ordering/diagrams-3d/:id/model.glb   the file (for the preview)
//   PUT    /embed-ordering/diagrams-3d/:id             { title?, status?, brand?, model?, parts?: [{ code, items, face }] }
//   POST   /embed-ordering/diagrams-3d/:id/file        replace the file — multipart: file (links kept by part code)
//   POST   /embed-ordering/diagrams-3d/:id/copy-links  { fromId, overwrite? } links from another model, by part code
//   DELETE /embed-ordering/diagrams-3d/:id
//
// Reading needs embedOrdering:diagram:view, changing embedOrdering:diagram:manage —
// both held only by *:*:* (Admin) today.

var express = require("express");
var router = express.Router();
const multer = require("multer");
const { ObjectId } = require("mongodb");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");
const { getCatalog, partsForModel, search } = require("../../utils/sparePartsCatalog");
const { str } = require("./common");
const D = require("./diagram3dStore");

const VIEW = requirePermission("embedOrdering:diagram:view");
const MANAGE = requirePermission("embedOrdering:diagram:manage");

const byOf = (req) => (req.user && req.user.username) || null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: D.MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.glb$/i.test(file.originalname || "")) return cb(null, true);
    cb(new D.InputError("Upload a .glb file (binary glTF)"));
  },
});
function takeFile(req, res) {
  return new Promise((resolve) => {
    upload.single("file")(req, res, (err) => {
      if (err && err.code === "LIMIT_FILE_SIZE") return resolve(new D.InputError(`The file is over ${D.MAX_FILE_BYTES / 1024 / 1024} MB`));
      resolve(err || null);
    });
  });
}

let indexed = false;
async function db() {
  const d = await connectToDatabase();
  if (!indexed) {
    await d.collection(D.DIAGRAMS).createIndex({ brand: 1, model: 1 }, { unique: true });
    indexed = true;
  }
  return d;
}

function fail(res, e, what) {
  if (e && e.status === 400) return res.status(400).json({ success: false, message: e.message });
  if (e && e.code === 11000) return res.status(409).json({ success: false, message: "That model already has a 3D diagram" });
  console.error(`3D diagram ${what} error:`, e);
  return res.status(500).json({ success: false, message: (e && e.message) || `Failed to ${what}` });
}

// ── catalogue helpers ──
const byIdCache = new WeakMap(); // catalogue → Map(id → item)
function itemsById(cat) {
  if (!byIdCache.has(cat)) byIdCache.set(cat, new Map(cat.items.map((i) => [i.id, i])));
  return byIdCache.get(cat);
}
// staff see the quantity, not just in / out of stock
const staffItem = (i) => ({ id: i.id, name: i.name, sku: i.sku, type: i.type, sub: i.sub, quality: i.quality, imageId: i.imageId, available: i.available });

// The catalogue's own spelling of a brand + model (the widget matches on it).
function catalogueModel(cat, brand, model) {
  const b = cat.brands.find((x) => x.name.toLowerCase() === String(brand).toLowerCase());
  if (!b) return null;
  for (const s of b.series) {
    const m = s.models.find((x) => x.name.toLowerCase() === String(model).toLowerCase());
    if (m) return { brand: b.name, series: s.name, model: m.name };
  }
  return null;
}

function listRow(d, cat) {
  const parts = d.parts || [];
  return {
    id: d._id,
    brand: d.brand,
    model: d.model,
    title: d.title,
    status: d.status,
    parts: parts.length,
    linkedParts: parts.filter((p) => p.items && p.items.length).length,
    links: parts.reduce((n, p) => n + ((p.items && p.items.length) || 0), 0),
    file: d.file ? { name: d.file.name, bytes: d.file.bytes, gzBytes: d.file.gzBytes, version: d.file.version } : null,
    stats: d.stats || null,
    explode: d.explode || "",
    inCatalog: !!catalogueModel(cat, d.brand, d.model),
    updatedAt: d.updatedAt,
    updatedBy: d.updatedBy || d.createdBy || null,
  };
}

async function loadDiagram(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Bad id" });
    return null;
  }
  const d = await (await db()).collection(D.DIAGRAMS).findOne({ _id: new ObjectId(req.params.id) });
  if (!d) {
    res.status(404).json({ success: false, message: "3D diagram not found" });
    return null;
  }
  return d;
}

// ── GET / ──
router.get("/", VIEW, async (req, res) => {
  try {
    const [rows, cat] = await Promise.all([
      (await db()).collection(D.DIAGRAMS).find({}).sort({ brand: 1, model: 1 }).toArray(),
      getCatalog(),
    ]);
    return res.json({ success: true, items: rows.map((d) => listRow(d, cat)) });
  } catch (e) {
    return fail(res, e, "list");
  }
});

// ── GET /models ──
router.get("/models", VIEW, async (req, res) => {
  try {
    const [cat, rows] = await Promise.all([
      getCatalog(),
      (await db()).collection(D.DIAGRAMS).find({}, { projection: { brand: 1, model: 1 } }).toArray(),
    ]);
    return res.json({
      success: true,
      brands: cat.brands.map((b) => ({
        name: b.name,
        series: b.series.map((s) => ({ name: s.name, models: s.models.map((m) => ({ name: m.name, parts: m.parts })) })),
      })),
      taken: rows.map((d) => ({ brand: d.brand, model: d.model, id: d._id })),
    });
  } catch (e) {
    return fail(res, e, "load the models");
  }
});

// ── GET /items?q= ──
router.get("/items", VIEW, async (req, res) => {
  try {
    const q = str(req.query.q, 80);
    if (q.length < 2) return res.json({ success: true, items: [], total: 0 });
    const r = search(await getCatalog(), q, staffItem);
    return res.json({ success: true, items: r.items, total: r.total });
  } catch (e) {
    return fail(res, e, "search");
  }
});

// ── POST / ──
router.post("/", MANAGE, async (req, res) => {
  try {
    const err = await takeFile(req, res);
    if (err) return fail(res, err.status ? err : new D.InputError(err.message), "upload");
    if (!req.file) throw new D.InputError("Choose the model's .glb file");
    const cat = await getCatalog();
    const hit = catalogueModel(cat, str(req.body.brand, 80), str(req.body.model, 160));
    if (!hit) throw new D.InputError("Pick a brand and model from the list");
    const info = D.parseGlb(req.file.buffer);
    const d = await db();
    if (await d.collection(D.DIAGRAMS).findOne({ brand: hit.brand, model: hit.model }, { projection: { _id: 1 } })) {
      return res.status(409).json({ success: false, message: `${hit.model} already has a 3D diagram` });
    }
    const _id = new ObjectId();
    const saved = await D.saveFile(_id, req.file.buffer);
    const now = new Date();
    const doc = {
      _id,
      brand: hit.brand,
      model: hit.model,
      title: str(req.body.title, 120) || `${hit.brand} ${hit.model}`,
      status: "draft",
      file: { ...saved, name: str(req.file.originalname, 200), uploadedAt: now, uploadedBy: byOf(req) },
      stats: info.stats,
      explode: info.explode,
      parts: info.parts.map((p) => ({ ...p, items: [] })),
      createdAt: now,
      createdBy: byOf(req),
      updatedAt: now,
      updatedBy: byOf(req),
    };
    try {
      await d.collection(D.DIAGRAMS).insertOne(doc);
    } catch (e) {
      await D.deleteFile(doc.file);
      throw e;
    }
    return res.json({ success: true, id: _id, diagram: listRow(doc, cat) });
  } catch (e) {
    return fail(res, e, "create the 3D diagram");
  }
});

// ── GET /:id ──
router.get("/:id", VIEW, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    const cat = await getCatalog();
    const items = partsForModel(cat, d.brand, d.model, staffItem);
    const listed = new Set(items.map((i) => i.id));
    const byId = itemsById(cat);
    const linked = {}; // linked items not listed for this model (or gone from the store)
    for (const p of d.parts || []) {
      for (const id of p.items || []) {
        if (listed.has(id) || linked[id]) continue;
        const it = byId.get(id);
        linked[id] = it ? { ...staffItem(it), elsewhere: true } : { id, missing: true };
      }
    }
    const suggestions = {};
    for (const p of d.parts || []) suggestions[p.code] = D.suggestFor(p.label, items);
    return res.json({
      success: true,
      diagram: {
        ...listRow(d, cat),
        parts: d.parts || [],
        createdAt: d.createdAt,
        createdBy: d.createdBy || null,
        // where it is stored stays on the server
        file: d.file ? { name: d.file.name, bytes: d.file.bytes, gzBytes: d.file.gzBytes, version: d.file.version, uploadedAt: d.file.uploadedAt, uploadedBy: d.file.uploadedBy } : null,
      },
      items,
      linked: Object.values(linked),
      suggestions,
    });
  } catch (e) {
    return fail(res, e, "load the 3D diagram");
  }
});

// ── GET /:id/model.glb ──
router.get("/:id/model.glb", VIEW, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    return await D.sendFile(req, res, d);
  } catch (e) {
    return fail(res, e, "read the file");
  }
});

// ── PUT /:id ──
function cleanParts(raw, current, cat) {
  if (!Array.isArray(raw)) throw new D.InputError("parts must be a list");
  const byCode = new Map(raw.filter((p) => p && typeof p.code === "string").map((p) => [p.code, p]));
  const byId = itemsById(cat);
  return current.map((p) => {
    const next = byCode.get(p.code);
    if (!next) return p;
    let items = p.items || [];
    if (next.items !== undefined) {
      if (!Array.isArray(next.items)) throw new D.InputError(`${p.code}: items must be a list`);
      items = [...new Set(next.items.map((x) => str(x, 40)).filter(Boolean))];
      if (items.length > D.MAX_ITEMS_PER_PART) throw new D.InputError(`${p.label}: at most ${D.MAX_ITEMS_PER_PART} items per part`);
      const unknown = items.filter((id) => !byId.has(id) && !(p.items || []).includes(id));
      if (unknown.length) throw new D.InputError(`${p.label}: item ${unknown[0]} isn't in the store`);
    }
    let face = p.face || "";
    if (next.face !== undefined) {
      face = str(next.face, 10);
      if (!D.FACES.includes(face)) throw new D.InputError(`${p.label}: view must be front, back or automatic`);
    }
    return { ...p, items, face };
  });
}

router.put("/:id", MANAGE, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    const body = req.body || {};
    const cat = await getCatalog();
    const set = {};
    if (body.title !== undefined) {
      set.title = str(body.title, 120);
      if (!set.title) throw new D.InputError("The title can't be empty");
    }
    if (body.status !== undefined) {
      if (!D.STATUSES.includes(body.status)) throw new D.InputError("Status must be draft or published");
      if (body.status === "published" && !(d.file && d.file.key)) throw new D.InputError("Upload the 3D file first");
      set.status = body.status;
    }
    if (body.brand !== undefined || body.model !== undefined) {
      const hit = catalogueModel(cat, body.brand !== undefined ? body.brand : d.brand, body.model !== undefined ? body.model : d.model);
      if (!hit) throw new D.InputError("Pick a brand and model from the list");
      const other = await (await db()).collection(D.DIAGRAMS).findOne(
        { brand: hit.brand, model: hit.model, _id: { $ne: d._id } },
        { projection: { _id: 1 } },
      );
      if (other) return res.status(409).json({ success: false, message: `${hit.model} already has a 3D diagram` });
      set.brand = hit.brand;
      set.model = hit.model;
    }
    if (body.parts !== undefined) set.parts = cleanParts(body.parts, d.parts || [], cat);
    if (!Object.keys(set).length) return res.json({ success: true, unchanged: true });
    set.updatedAt = new Date();
    set.updatedBy = byOf(req);
    await (await db()).collection(D.DIAGRAMS).updateOne({ _id: d._id }, { $set: set });
    const fresh = { ...d, ...set };
    return res.json({ success: true, diagram: { ...listRow(fresh, cat), parts: fresh.parts || [] } });
  } catch (e) {
    return fail(res, e, "save the 3D diagram");
  }
});

// ── POST /:id/file ──
router.post("/:id/file", MANAGE, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    const err = await takeFile(req, res);
    if (err) return fail(res, err.status ? err : new D.InputError(err.message), "upload");
    if (!req.file) throw new D.InputError("Choose the new .glb file");
    const info = D.parseGlb(req.file.buffer);
    const saved = await D.saveFile(d._id, req.file.buffer);
    const old = new Map((d.parts || []).map((p) => [p.code, p]));
    // links and views follow the part code into the new file
    const parts = info.parts.map((p) => {
      const was = old.get(p.code);
      return { ...p, face: was && was.face ? was.face : p.face, items: was ? was.items || [] : [] };
    });
    const now = new Date();
    const set = {
      file: { ...saved, name: str(req.file.originalname, 200), uploadedAt: now, uploadedBy: byOf(req) },
      stats: info.stats,
      explode: info.explode,
      parts,
      updatedAt: now,
      updatedBy: byOf(req),
    };
    await (await db()).collection(D.DIAGRAMS).updateOne({ _id: d._id }, { $set: set });
    if (d.file && d.file.key !== saved.key) await D.deleteFile(d.file);
    const codes = new Set(info.parts.map((p) => p.code));
    return res.json({
      success: true,
      added: info.parts.filter((p) => !old.has(p.code)).map((p) => p.code),
      removed: (d.parts || []).filter((p) => !codes.has(p.code)).map((p) => ({ code: p.code, label: p.label, items: (p.items || []).length })),
    });
  } catch (e) {
    return fail(res, e, "replace the file");
  }
});

// ── POST /:id/copy-links ──
router.post("/:id/copy-links", MANAGE, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    const fromId = str(req.body && req.body.fromId, 40);
    if (!ObjectId.isValid(fromId) || fromId === String(d._id)) throw new D.InputError("Pick another 3D diagram to copy from");
    const from = await (await db()).collection(D.DIAGRAMS).findOne({ _id: new ObjectId(fromId) });
    if (!from) throw new D.InputError("That 3D diagram no longer exists");
    const overwrite = !!(req.body && req.body.overwrite);
    const src = new Map((from.parts || []).map((p) => [p.code, p]));
    let copied = 0;
    const parts = (d.parts || []).map((p) => {
      const s = src.get(p.code);
      if (!s || !(s.items || []).length) return p;
      if ((p.items || []).length && !overwrite) return p;
      copied++;
      return { ...p, items: [...s.items], face: p.face || s.face || "" };
    });
    if (copied) {
      await (await db()).collection(D.DIAGRAMS).updateOne(
        { _id: d._id },
        { $set: { parts, updatedAt: new Date(), updatedBy: byOf(req) } },
      );
    }
    return res.json({ success: true, copied });
  } catch (e) {
    return fail(res, e, "copy the links");
  }
});

// ── DELETE /:id ──
router.delete("/:id", MANAGE, async (req, res) => {
  try {
    const d = await loadDiagram(req, res);
    if (!d) return;
    await (await db()).collection(D.DIAGRAMS).deleteOne({ _id: d._id });
    await D.deleteFile(d.file);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, e, "delete the 3D diagram");
  }
});

module.exports = router;
