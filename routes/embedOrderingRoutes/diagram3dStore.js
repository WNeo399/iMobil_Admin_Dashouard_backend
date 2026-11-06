// Embed Ordering — 3D diagrams (Mongo: embed_ordering_3d_diagrams).
//
// One 3D exploded model (a .glb file) per catalogue Brand + Model (user,
// 2026-11-06: "I will provide the 3D files, only 3D diagram"). The file's
// parts are read from the file itself when it is uploaded; staff link each
// part to our items on the dashboard (Embed Ordering → 3D Diagrams), and
// the ordering widget's "3D view" shows a picked part's items with stock and
// Add to cart. Shown in the widget once Published.
//
// A document:
//   { brand, model,                 the widget catalogue's names (unique pair)
//     title, status: draft|published,
//     file: { key, bucket, name, bytes, gzBytes, version, uploadedAt, uploadedBy },
//     stats: { meshes, triangles, materials },
//     explode: file | mixed | auto,  where the parts' separation comes from
//     parts: [{ code, label, face: ""|front|back, items: [itemId] }],   file order
//     createdAt/By, updatedAt/By }
//
// The file is kept gzipped in S3 (9.6 MB → ~0.8 MB for the S24) and served
// through the backend (signed-in widget customers / dashboard staff), never
// by a public link.

const zlib = require("zlib");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const DIAGRAMS = "embed_ordering_3d_diagrams";
const STATUSES = ["draft", "published"];
const FACES = ["", "front", "back"];
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const MAX_PARTS = 300;
const MAX_ITEMS_PER_PART = 60;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);
const isVec3 = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === "number" && Number.isFinite(n));

// ── reading a .glb ────────────────────────────────────────────────────
// The same part rules as the viewer (public/widgets/embed-ordering/viewer3d.js):
// nodes with extras.code (top-most), else "<CODE>_<Label>" children of the
// root wrapper node. Only the JSON chunk is read — nothing in the file runs.
const UNSUPPORTED = {
  KHR_draco_mesh_compression: "Draco-compressed",
  EXT_meshopt_compression: "Meshopt-compressed",
  KHR_texture_basisu: "KTX2 / Basis textures",
};

function readGlbJson(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) throw new InputError("That isn't a .glb file");
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new InputError("That isn't a .glb file (export the model as binary glTF, .glb)");
  if (buf.readUInt32LE(4) !== 2) throw new InputError("Only glTF 2.0 .glb files are supported");
  const total = buf.readUInt32LE(8);
  if (total > buf.length) throw new InputError("The .glb file is incomplete");
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || 20 + len > buf.length) throw new InputError("The .glb file has no readable scene data");
  try {
    return JSON.parse(buf.slice(20, 20 + len).toString("utf8"));
  } catch (e) {
    throw new InputError("The .glb file's scene data couldn't be read");
  }
}

function parseGlb(buf) {
  const json = readGlbJson(buf);
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
  const bad = required.filter((x) => UNSUPPORTED[x]);
  if (bad.length) {
    throw new InputError(`${bad.map((x) => UNSUPPORTED[x]).join(", ")} files aren't supported yet — export the .glb without compression`);
  }
  const external = (list) => (Array.isArray(list) ? list : []).some((x) => x && x.uri && !/^data:/i.test(x.uri));
  if (external(json.buffers) || external(json.images)) {
    throw new InputError("The file points to other files (textures / .bin) — export everything inside one .glb");
  }
  const scene = Array.isArray(json.scenes) ? json.scenes[Number.isInteger(json.scene) ? json.scene : 0] : null;
  const roots = scene && Array.isArray(scene.nodes) ? scene.nodes : [];
  if (!roots.length) throw new InputError("The file has no scene");

  const kids = (i) => (nodes[i] && Array.isArray(nodes[i].children) ? nodes[i].children : []);
  const found = [];
  const seen = new Set();
  (function walk(list) {
    for (const i of list) {
      if (seen.has(i) || !nodes[i]) continue;
      seen.add(i);
      const ex = nodes[i].extras || {};
      const code = typeof ex.code === "string" ? str(ex.code, 40) : "";
      if (code) found.push({ i, code, label: str(ex.label, 120) || code, ex });
      else walk(kids(i));
    }
  })(roots);
  if (!found.length) {
    let top = roots.length === 1 ? roots[0] : null;
    let list = roots;
    while (top != null && kids(top).length === 1 && kids(kids(top)[0]).length) top = kids(top)[0];
    if (top != null) list = kids(top);
    for (const i of list) {
      const m = String((nodes[i] && nodes[i].name) || "").match(/^([A-Za-z0-9-]{2,40})_(.+)$/);
      if (m) found.push({ i, code: m[1], label: str(m[2].replace(/_/g, " "), 120) || m[1], ex: nodes[i].extras || {} });
    }
  }
  if (!found.length) {
    throw new InputError("No parts found — name each part's node \"<CODE>_<Label>\" (e.g. QBA01_Battery) or give it extras { code, label }");
  }
  if (found.length > MAX_PARTS) throw new InputError(`Too many parts (${found.length}, max ${MAX_PARTS})`);
  const codes = new Set();
  for (const f of found) {
    const k = f.code.toLowerCase();
    if (codes.has(k)) throw new InputError(`Two parts use the code ${f.code}`);
    codes.add(k);
  }

  // where each part's separation comes from
  const animated = new Set();
  for (const a of Array.isArray(json.animations) ? json.animations : []) {
    for (const c of Array.isArray(a.channels) ? a.channels : []) {
      if (c && c.target && c.target.path === "translation") animated.add(c.target.node);
    }
  }
  const fromFile = found.filter((f) => isVec3(f.ex.explode) || animated.has(f.i)).length;
  const explode = fromFile === found.length ? "file" : fromFile ? "mixed" : "auto";

  // weight: meshes (primitives) and triangles as placed in the scene
  let meshes = 0;
  let triangles = 0;
  const accessors = Array.isArray(json.accessors) ? json.accessors : [];
  const placed = new Set();
  (function walk(list) {
    for (const i of list) {
      if (placed.has(i) || !nodes[i]) continue;
      placed.add(i);
      const mesh = Number.isInteger(nodes[i].mesh) && json.meshes ? json.meshes[nodes[i].mesh] : null;
      for (const p of (mesh && mesh.primitives) || []) {
        meshes++;
        if ((p.mode == null ? 4 : p.mode) !== 4) continue;
        const acc = accessors[p.indices != null ? p.indices : p.attributes && p.attributes.POSITION];
        if (acc && acc.count) triangles += Math.floor(acc.count / 3);
      }
      walk(kids(i));
    }
  })(roots);

  return {
    parts: found.map((f) => ({
      code: f.code,
      label: f.label,
      face: f.ex.view === "front" || f.ex.view === "back" ? f.ex.view : "",
    })),
    explode,
    stats: { meshes, triangles, materials: Array.isArray(json.materials) ? json.materials.length : 0 },
  };
}

// ── file storage (S3, gzipped) ────────────────────────────────────────
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
function s3Ready() {
  const s3 = getS3Client();
  const bucket = getBucketName();
  if (!s3 || !bucket) throw new Error("S3 is not configured on the server");
  return { s3, bucket };
}

// The bucket is recorded with each file: a file uploaded from one server
// (local, Railway) stays readable when the other's bucket setting differs.
const s3Storage = {
  async put(key, gz) {
    const { s3, bucket } = s3Ready();
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: gz,
      ContentType: "model/gltf-binary",
      ContentEncoding: "gzip",
      CacheControl: "private, max-age=31536000",
    }));
    return bucket;
  },
  async get(key, where) {
    const { s3, bucket } = s3Ready();
    const out = await s3.send(new GetObjectCommand({ Bucket: where || bucket, Key: key }));
    return Buffer.from(await out.Body.transformToByteArray());
  },
  async del(key, where) {
    const { s3, bucket } = s3Ready();
    await s3.send(new DeleteObjectCommand({ Bucket: where || bucket, Key: key }));
  },
};
// Tests swap in an in-memory store.
const storage = { impl: s3Storage };

const fileKey = (id, version) => `embed-ordering-3d/${id}/${version}.glb.gz`;

// A few recent files stay in memory: each widget visit to a model's 3D view
// would otherwise read S3.
const memo = new Map(); // key → gz Buffer (Map order = least recently used first)
const MEMO_MAX = 24;
function remember(key, gz) {
  memo.delete(key);
  memo.set(key, gz);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
}

async function saveFile(id, buffer) {
  const version = Date.now();
  const gz = zlib.gzipSync(buffer, { level: 9 });
  const key = fileKey(id, version);
  const bucket = (await storage.impl.put(key, gz)) || null;
  remember(key, gz);
  return { key, bucket, version, bytes: buffer.length, gzBytes: gz.length };
}

async function readFile(file) {
  if (!file || !file.key) return null;
  if (memo.has(file.key)) {
    const gz = memo.get(file.key);
    remember(file.key, gz);
    return gz;
  }
  let gz = await storage.impl.get(file.key, file.bucket || null);
  // stored gzipped; anything else (a hand-placed file) is packed now
  if (!(gz.length > 2 && gz[0] === 0x1f && gz[1] === 0x8b)) gz = zlib.gzipSync(gz, { level: 9 });
  remember(file.key, gz);
  return gz;
}

async function deleteFile(file) {
  if (!file || !file.key) return;
  memo.delete(file.key);
  try {
    await storage.impl.del(file.key, file.bucket || null);
  } catch (e) {
    // the record is the source of truth — a stray S3 object is only waste
    console.warn("3D diagram file delete failed:", (e && e.message) || e);
  }
}

// Send a stored file: gzipped as it is to browsers that take gzip (all of them).
async function sendFile(req, res, diagram) {
  const gz = await readFile(diagram.file);
  if (!gz) return res.status(404).json({ success: false, message: "This 3D diagram has no file" });
  const etag = `"3d-${diagram._id}-${diagram.file.version}"`;
  res.set("Cache-Control", "private, max-age=86400");
  res.set("ETag", etag);
  res.set("Vary", "Accept-Encoding");
  if (req.get("If-None-Match") === etag) return res.status(304).end();
  res.type("model/gltf-binary");
  if (req.acceptsEncodings("gzip")) {
    res.set("Content-Encoding", "gzip");
    return res.send(gz);
  }
  return res.send(zlib.gunzipSync(gz));
}

// ── suggested items for a part (by its label) ─────────────────────────
// A first guess from the part's name — the link is still picked by staff.
// Item fields: { type, sub, name } as in utils/sparePartsCatalog.
const T = (re) => (i) => re.test(i.type);
const S = (re) => (i) => re.test(i.sub);
const N = (re) => (i) => re.test(i.name);
const any = (...fs) => (i) => fs.some((f) => f(i));
const all = (...fs) => (i) => fs.every((f) => f(i));
const not = (f) => (i) => !f(i);

function rearCamera(label) {
  const rear = any(S(/rear camera|back camera/i), all(N(/camera/i), N(/rear|back/i), not(N(/lens|bezel|glass/i))));
  if (/ultra/i.test(label)) return all(rear, N(/ultra/i));
  if (/tele|zoom|periscope/i.test(label)) return all(rear, N(/tele|zoom|periscope/i));
  if (/wide|main/i.test(label)) return all(rear, N(/main|wide/i), not(N(/ultra/i)));
  return rear;
}

const RULES = [
  [/rear camera|back camera|main camera/i, rearCamera],
  [/front camera|selfie/i, () => any(S(/front camera/i), all(N(/front camera/i)))],
  [/camera lens|lens|camera glass/i, () => S(/camera lens/i)],
  [/back cover|rear cover|back glass|battery cover|back housing/i,
    () => any(T(/^backcover$/i), all(S(/adhesive/i), N(/back cover|back glass/i)), S(/camera lens/i))],
  [/battery/i, () => any(T(/^battery$/i), all(S(/adhesive/i), N(/battery/i)))],
  [/screen|display|lcd|oled|digiti/i, () => any(T(/^screen$/i), all(S(/adhesive/i), N(/lcd|screen|display/i)))],
  [/charging port|charge port|usb|dock|sub ?board/i, () => S(/charging port/i)],
  [/top speaker|earpiece|ear speaker|receiver/i, () => S(/earpiece/i)],
  [/bottom speaker|loud ?speaker|buzzer/i, () => S(/loud ?speaker/i)],
  [/wireless|nfc|coil/i, () => S(/nfc|wireless/i)],
  [/\bsim\b/i, () => S(/\bsim\b/i)],
  [/main ?board|motherboard|logic board|\bpba\b/i, () => S(/connector/i)],
  [/main flex|mainboard flex|lcd flex|interconnect|main flex cable/i, () => S(/mainboard flex|lcd & mainboard/i)],
  [/volume|power|side button|button flex|button/i, () => S(/power|volume|button/i)],
  [/microphone|\bmic\b/i, () => S(/microphone|\bmic\b/i)],
  [/vibrat|taptic|motor/i, () => S(/vibrat|taptic/i)],
  [/middle frame|frame|housing|chassis/i, () => T(/frame|housing/i)],
  [/proximity|sensor/i, () => S(/proximity|sensor/i)],
];

function suggestFor(label, items) {
  for (const [re, make] of RULES) {
    if (re.test(label)) return items.filter(make(label)).map((i) => i.id);
  }
  return [];
}

module.exports = {
  DIAGRAMS,
  STATUSES,
  FACES,
  MAX_FILE_BYTES,
  MAX_ITEMS_PER_PART,
  InputError,
  parseGlb,
  saveFile,
  readFile,
  deleteFile,
  sendFile,
  suggestFor,
  storage,
  _memo: memo,
};
