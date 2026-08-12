// Exploded Diagrams — admin CRUD (Mongo: exploded_diagrams).
//
// A diagram is one uploaded image (stored in S3, publicly readable) for a
// Brand + Model, carrying polygon hotspots that bind areas of the image to
// a Part Number + Title. Published diagrams are served to the embeddable
// widget via routes/widgetRoutes/explodedDiagram.js; this file is the
// authenticated management side.
//
//   GET    /exploded/diagrams              list
//   POST   /exploded/diagrams              create (multipart: image + fields)
//   GET    /exploded/diagrams/:id          one diagram with hotspots
//   PUT    /exploded/diagrams/:id          update meta (title/brand/model/status)
//   PUT    /exploded/diagrams/:id/hotspots replace the hotspot set
//   POST   /exploded/diagrams/:id/image    replace the image
//   DELETE /exploded/diagrams/:id          delete (S3 object best-effort)
//
// Gated by exploded:diagram:manage — held only by *:*:* (Admin) for now.
//
// Hotspot coordinates are NORMALIZED (0..1 fractions of image width and
// height) so they survive any display scaling in the editor and widget.

var express = require("express");
var router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const { ObjectId } = require("mongodb");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { connectToDatabase } = require("../../utils/mongodb");
const { requirePermission } = require("../../middleware/auth");

const MANAGE = requirePermission("exploded:diagram:manage");
const DIAGRAMS = "exploded_diagrams";
const STATUSES = ["draft", "published"];

// ── S3 (same lazy-singleton pattern as the other upload routes) ─────
let s3Client = null;
function getS3Client() {
  if (s3Client) return s3Client;
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) return null;
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  return s3Client;
}
function getBucketName() {
  return process.env.S3_WIDGET_BUCKET_NAME || process.env.S3_CREDIT_BUCKET_NAME || null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Only PNG, JPEG or WebP images are accepted"));
  },
});

function str(v, cap) {
  return String(v == null ? "" : v).trim().slice(0, cap);
}

function status(v) {
  const s = str(v, 20).toLowerCase();
  return STATUSES.includes(s) ? s : "draft";
}

// Upload one image buffer; returns the stored image descriptor. The key is
// deliberately space-free so the public URL needs no encoding games.
async function uploadImage(diagramId, file) {
  const s3 = getS3Client();
  const bucket = getBucketName();
  if (!s3 || !bucket) throw new Error("S3 is not configured on the server");

  const meta = await sharp(file.buffer).metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read the image dimensions");

  const ext = meta.format === "jpeg" ? "jpg" : meta.format || "png";
  const key = `exploded-diagrams/${diagramId}/${Date.now()}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      CacheControl: "public, max-age=86400",
    }),
  );
  return {
    key,
    url: `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`,
    width: meta.width,
    height: meta.height,
    size: file.size,
    contentType: file.mimetype,
  };
}

async function deleteImage(image) {
  if (!image || !image.key) return;
  try {
    const s3 = getS3Client();
    const bucket = getBucketName();
    if (s3 && bucket) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: image.key }));
    }
  } catch (e) {
    // The doc is the source of truth — a dangling S3 object is only waste.
    console.warn("Exploded diagram S3 delete failed:", (e && e.message) || e);
  }
}

// Validate + normalise the hotspot payload. Coordinates clamp into 0..1;
// a polygon needs at least 3 points, and each hotspot needs a part number
// or a title (usually both).
function parseHotspots(raw) {
  if (!Array.isArray(raw)) throw new Error("hotspots must be an array");
  if (raw.length > 300) throw new Error("Too many hotspots (max 300)");
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  return raw.map((h, i) => {
    const partNumber = str(h && h.partNumber, 80);
    const title = str(h && h.title, 160);
    if (!partNumber && !title) throw new Error(`Hotspot ${i + 1} needs a part number or a title`);
    const pts = Array.isArray(h && h.points) ? h.points : [];
    if (pts.length < 3 || pts.length > 200) {
      throw new Error(`Hotspot ${i + 1} needs 3–200 polygon points`);
    }
    let points = pts.map((p) => {
      const x = Number(Array.isArray(p) ? p[0] : p && p.x);
      const y = Number(Array.isArray(p) ? p[1] : p && p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`Hotspot ${i + 1} has an invalid point`);
      }
      return [Number(clamp01(x).toFixed(5)), Number(clamp01(y).toFixed(5))];
    });
    // Drop repeated identical points (adjacent duplicates + a closing point
    // equal to the first) — degenerate leftovers from the editor.
    points = points.filter((p, ix) => {
      const prev = points[ix - 1];
      return !(prev && prev[0] === p[0] && prev[1] === p[1]);
    });
    while (
      points.length > 1 &&
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1]
    ) {
      points.pop();
    }
    if (points.length < 3) {
      throw new Error(`Hotspot ${i + 1} needs at least 3 distinct points`);
    }
    // Linked shop products: picked in the editor via the Zoho Commerce
    // search, with the Inventory item id resolved by SKU at link time.
    const rawProducts = Array.isArray(h && h.products) ? h.products : [];
    if (rawProducts.length > 50) throw new Error(`Hotspot ${i + 1} has too many linked products (max 50)`);
    const products = rawProducts
      .map((p) => ({
        title: str(p && p.title, 200),
        sku: str(p && p.sku, 80),
        commerceId: str(p && p.commerceId, 40),
        variantId: str(p && p.variantId, 40),
        inventoryId: str(p && p.inventoryId, 40),
        // Relative storefront path from Zoho search ("/products/<handle>/<id>")
        // — the widget prefixes the shop domain to build the click-through.
        url: str(p && p.url, 500),
        // Optional photo uploaded in the editor (separate from the shop
        // thumbnail), hosted on S3 via /diagrams/:id/product-image.
        imageUrl: str(p && p.imageUrl, 500),
        imageKey: str(p && p.imageKey, 300),
      }))
      .filter((p) => p.sku || p.title);
    return {
      id: str(h && h.id, 40) || `h${i + 1}-${Date.now().toString(36)}`,
      partNumber,
      title,
      points,
      products,
    };
  });
}

// Multer errors (size/MIME) should come back as a clean 400, not a 500.
function handleUpload(req, res) {
  return new Promise((resolve) => {
    upload.single("image")(req, res, (err) => resolve(err || null));
  });
}

// ── GET /exploded/diagrams ──────────────────────────────────────────
router.get("/diagrams", MANAGE, async (req, res) => {
  try {
    const db = await connectToDatabase();
    const rows = await db
      .collection(DIAGRAMS)
      .find({}, { projection: { hotspots: 0 } })
      .sort({ brand: 1, model: 1, createdAt: -1 })
      .limit(500)
      .toArray();
    const counts = await db
      .collection(DIAGRAMS)
      .aggregate([{ $project: { n: { $size: { $ifNull: ["$hotspots", []] } } } }])
      .toArray();
    const countById = new Map(counts.map((c) => [String(c._id), c.n]));
    return res.json({
      success: true,
      rows: rows.map((r) => ({ ...r, hotspotCount: countById.get(String(r._id)) || 0 })),
    });
  } catch (e) {
    console.error("Exploded list error:", e);
    return res.status(500).json({ success: false, message: "Failed to load diagrams" });
  }
});

// ── POST /exploded/diagrams ─────────────────────────────────────────
router.post("/diagrams", MANAGE, async (req, res) => {
  try {
    const uploadErr = await handleUpload(req, res);
    if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
    if (!req.file) return res.status(400).json({ success: false, message: "An image file is required" });

    const brand = str(req.body.brand, 80);
    const model = str(req.body.model, 120);
    if (!brand || !model) {
      return res.status(400).json({ success: false, message: "Brand and Model are required" });
    }

    const _id = new ObjectId();
    const image = await uploadImage(_id, req.file);
    const now = new Date();
    const doc = {
      _id,
      brand,
      model,
      title: str(req.body.title, 120) || `${brand} ${model}`,
      status: status(req.body.status),
      image,
      hotspots: [],
      createdAt: now,
      updatedAt: now,
      createdBy: (req.user && req.user.username) || null,
    };
    const db = await connectToDatabase();
    await db.collection(DIAGRAMS).insertOne(doc);
    return res.json({ success: true, id: _id, diagram: doc });
  } catch (e) {
    console.error("Exploded create error:", e);
    return res.status(500).json({ success: false, message: e.message || "Failed to create the diagram" });
  }
});

async function loadDiagram(req, res) {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: "Bad id" });
    return null;
  }
  const db = await connectToDatabase();
  const diagram = await db.collection(DIAGRAMS).findOne({ _id: new ObjectId(req.params.id) });
  if (!diagram) {
    res.status(404).json({ success: false, message: "Diagram not found" });
    return null;
  }
  return { db, diagram };
}

// ── GET /exploded/diagrams/:id ──────────────────────────────────────
router.get("/diagrams/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    return res.json({ success: true, diagram: ctx.diagram });
  } catch (e) {
    console.error("Exploded get error:", e);
    return res.status(500).json({ success: false, message: "Failed to load the diagram" });
  }
});

// ── PUT /exploded/diagrams/:id ──────────────────────────────────────
router.put("/diagrams/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    const set = { updatedAt: new Date(), updatedBy: (req.user && req.user.username) || null };
    if (req.body.title !== undefined) set.title = str(req.body.title, 120);
    if (req.body.brand !== undefined) {
      const brand = str(req.body.brand, 80);
      if (!brand) return res.status(400).json({ success: false, message: "Brand can't be empty" });
      set.brand = brand;
    }
    if (req.body.model !== undefined) {
      const model = str(req.body.model, 120);
      if (!model) return res.status(400).json({ success: false, message: "Model can't be empty" });
      set.model = model;
    }
    if (req.body.status !== undefined) set.status = status(req.body.status);
    await ctx.db.collection(DIAGRAMS).updateOne({ _id: ctx.diagram._id }, { $set: set });
    return res.json({ success: true });
  } catch (e) {
    console.error("Exploded update error:", e);
    return res.status(500).json({ success: false, message: "Failed to update the diagram" });
  }
});

// ── PUT /exploded/diagrams/:id/hotspots ─────────────────────────────
router.put("/diagrams/:id/hotspots", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    let hotspots;
    try {
      hotspots = parseHotspots(req.body && req.body.hotspots);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }
    await ctx.db.collection(DIAGRAMS).updateOne(
      { _id: ctx.diagram._id },
      {
        $set: {
          hotspots,
          updatedAt: new Date(),
          updatedBy: (req.user && req.user.username) || null,
        },
      },
    );
    return res.json({ success: true, count: hotspots.length });
  } catch (e) {
    console.error("Exploded hotspots error:", e);
    return res.status(500).json({ success: false, message: "Failed to save hotspots" });
  }
});

// ── POST /exploded/diagrams/:id/image ───────────────────────────────
// Replacing the image keeps the hotspots — same model photographed the
// same way usually; the editor is the place to fix any drift.
router.post("/diagrams/:id/image", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    const uploadErr = await handleUpload(req, res);
    if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
    if (!req.file) return res.status(400).json({ success: false, message: "An image file is required" });

    const image = await uploadImage(ctx.diagram._id, req.file);
    await ctx.db.collection(DIAGRAMS).updateOne(
      { _id: ctx.diagram._id },
      { $set: { image, updatedAt: new Date(), updatedBy: (req.user && req.user.username) || null } },
    );
    await deleteImage(ctx.diagram.image);
    return res.json({ success: true, image });
  } catch (e) {
    console.error("Exploded image replace error:", e);
    return res.status(500).json({ success: false, message: e.message || "Failed to replace the image" });
  }
});

// ── POST /exploded/diagrams/:id/product-image ───────────────────────
// Photo for a linked product (separate from the shop thumbnail). Uploads
// to S3 and returns { url, key }; the editor stamps them onto the product
// entry and persists via the hotspots save. Processed down to a bounded
// JPEG so phone photos don't land at 8MB. A later re-upload just leaves
// the old object dangling in S3 — the doc is the source of truth.
router.post("/diagrams/:id/product-image", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    const uploadErr = await handleUpload(req, res);
    if (uploadErr) return res.status(400).json({ success: false, message: uploadErr.message });
    if (!req.file) return res.status(400).json({ success: false, message: "An image file is required" });

    const s3 = getS3Client();
    const bucket = getBucketName();
    if (!s3 || !bucket) throw new Error("S3 is not configured on the server");

    const processed = await sharp(req.file.buffer)
      .rotate()
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    const key = `exploded-diagrams/${ctx.diagram._id}/products/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.jpg`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: processed,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=86400",
      }),
    );
    return res.json({
      success: true,
      url: `https://${bucket}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`,
      key,
    });
  } catch (e) {
    console.error("Exploded product image error:", e);
    return res.status(500).json({ success: false, message: e.message || "Failed to upload the image" });
  }
});

// ── DELETE /exploded/diagrams/:id ───────────────────────────────────
router.delete("/diagrams/:id", MANAGE, async (req, res) => {
  try {
    const ctx = await loadDiagram(req, res);
    if (!ctx) return;
    await ctx.db.collection(DIAGRAMS).deleteOne({ _id: ctx.diagram._id });
    await deleteImage(ctx.diagram.image);
    return res.json({ success: true });
  } catch (e) {
    console.error("Exploded delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete the diagram" });
  }
});

module.exports = router;
