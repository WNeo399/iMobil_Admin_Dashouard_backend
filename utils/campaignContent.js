// Campaign email content → ready for Zoho Campaigns (Campaign page + agent
// endpoint). Zoho only takes content from a public URL, so the HTML and its
// images are hosted in the public widget bucket under
// email-campaigns/<campaign id>/ (the same bucket the banner images use).
//
// Accepts a design-tool zip (an .html file + images/ + an optional .txt, like
// the first "Lid Sensor" email), a single HTML file / string, or HTML plus
// separate image files. Then:
//   · images are uploaded and every relative reference (src, href,
//     background, CSS url()) is pointed at its hosted copy;
//   · other tools' unsubscribe placeholders become Zoho's $[LI:UNSUBSCRIBE]$
//     (Zoho refuses external unsubscribe links);
//   · <script> blocks and on…= handlers are removed (email clients drop
//     them anyway, and the dashboard previews this HTML);
//   · anything a reviewer should know comes back as warnings.

const path = require("path");
const AdmZip = require("adm-zip");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const LIMITS = {
  zipBytes: 15 * 1024 * 1024,
  unzippedBytes: 40 * 1024 * 1024,
  htmlBytes: 2 * 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  images: 60,
};
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const UNSUBSCRIBE_TAG = "$[LI:UNSUBSCRIBE]$";
// placeholders other tools use for the unsubscribe link
const OTHER_UNSUBSCRIBE = [/\{\{\s*unsubscribe(_url|_link)?\s*\}\}/gi, /\*\|UNSUB\|\*/g, /%unsubscribe(_url|_link)?%/gi, /\[unsubscribe(_url|_link)?\]/gi];

let s3 = null;
function s3Client() {
  if (s3) return s3;
  const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !S3_REGION) throw new Error("S3 is not configured");
  s3 = new S3Client({ region: S3_REGION, credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } });
  return s3;
}
function bucket() {
  const b = process.env.S3_WIDGET_BUCKET_NAME || process.env.S3_CREDIT_BUCKET_NAME;
  if (!b) throw new Error("No public S3 bucket configured");
  return b;
}
const publicUrl = (key) => `https://${bucket()}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;

async function put(key, body, contentType, cache) {
  await s3Client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, CacheControl: cache }));
  return publicUrl(key);
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const cleanRel = (p) => String(p || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").split(/[?#]/)[0];
// a safe S3 file name that keeps the extension
const safeFile = (p) => {
  const ext = path.extname(p).toLowerCase();
  const base = path.basename(p, path.extname(p)).replace(/[^\w.-]+/g, "-").slice(0, 80) || "image";
  return base + ext;
};

// The parts of a zip: the HTML (email.html / index.html / the first .html),
// a .txt version, and the images.
function readZip(buffer) {
  if (buffer.length > LIMITS.zipBytes) throw bad("The zip is larger than 15 MB");
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { throw bad("That file isn't a readable zip"); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.)/.test(e.entryName));
  const total = entries.reduce((t, e) => t + (e.header && e.header.size ? e.header.size : 0), 0);
  if (total > LIMITS.unzippedBytes) throw bad("The zip unpacks to more than 40 MB");
  const htmls = entries.filter((e) => /\.html?$/i.test(e.entryName));
  if (!htmls.length) throw bad("The zip has no .html file");
  const pick = htmls.find((e) => /(^|\/)(email|index)\.html?$/i.test(e.entryName)) || htmls.sort((a, b) => a.entryName.split("/").length - b.entryName.split("/").length)[0];
  const root = path.posix.dirname(pick.entryName) === "." ? "" : path.posix.dirname(pick.entryName) + "/";
  const html = pick.getData().toString("utf8");
  const txt = entries.find((e) => /\.txt$/i.test(e.entryName));
  const images = entries
    .filter((e) => IMAGE_TYPES[path.extname(e.entryName).toLowerCase()])
    .map((e) => ({ rel: e.entryName.startsWith(root) ? e.entryName.slice(root.length) : e.entryName, buffer: e.getData() }));
  return { html, text: txt ? txt.getData().toString("utf8") : "", images };
}

// Point every relative reference that matches an uploaded image at its URL;
// returns the references left unmatched.
function rewriteRefs(html, urlFor) {
  const missing = new Set();
  const swap = (val) => {
    const v = String(val).trim();
    if (!v || /^(https?:|data:|mailto:|tel:|#|\$\[|\{\{|cid:)/i.test(v)) return null;
    const rel = cleanRel(v);
    const hit = urlFor(rel);
    if (hit) return hit;
    if (IMAGE_TYPES[path.extname(rel).toLowerCase()]) missing.add(rel);
    return null;
  };
  let out = html.replace(/\b(src|href|background)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
    const hit = swap(val);
    return hit ? `${attr}=${q}${hit}${q}` : m;
  });
  out = out.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, val) => {
    const hit = swap(val);
    return hit ? `url(${q}${hit}${q})` : m;
  });
  return { html: out, missing: [...missing] };
}

/**
 * @param {object} input  { zip?: Buffer, html?: string, text?: string, images?: [{ name, buffer }] }
 * @param {object} where  { campaignId, rev }
 * @returns {{ html, text, contentUrl, assets: [{ name, url, size }], warnings: string[] }}
 */
async function prepareContent(input, { campaignId, rev }) {
  let html = "";
  let text = input.text || "";
  let images = [];
  if (input.zip) {
    const z = readZip(input.zip);
    html = z.html;
    text = text || z.text;
    images = z.images;
  } else if (input.html) {
    html = String(input.html);
  } else {
    throw bad("Add the email content — a zip from the design tool, or an HTML file");
  }
  for (const im of input.images || []) {
    if (!IMAGE_TYPES[path.extname(im.name || "").toLowerCase()]) throw bad(`${im.name}: only png, jpg, gif, webp or svg images`);
    images.push({ rel: cleanRel(im.name), buffer: im.buffer });
  }
  if (Buffer.byteLength(html, "utf8") > LIMITS.htmlBytes) throw bad("The HTML is larger than 2 MB");
  if (images.length > LIMITS.images) throw bad(`At most ${LIMITS.images} images`);
  const tooBig = images.find((im) => im.buffer.length > LIMITS.imageBytes);
  if (tooBig) throw bad(`${tooBig.rel} is larger than 5 MB`);
  if (!/<(html|body|table|div|p)\b/i.test(html)) throw bad("That doesn't look like an HTML email");

  const warnings = [];
  const prefix = `email-campaigns/${campaignId}`;

  // images → S3, looked up by their relative path and by their file name
  const assets = [];
  const byRel = new Map();
  const byBase = new Map();
  for (const im of images) {
    const ext = path.extname(im.rel).toLowerCase();
    const url = await put(`${prefix}/images/${safeFile(im.rel)}`, im.buffer, IMAGE_TYPES[ext], "public, max-age=31536000");
    assets.push({ name: im.rel, url, size: im.buffer.length });
    byRel.set(im.rel.toLowerCase(), url);
    byBase.set(path.posix.basename(im.rel).toLowerCase(), url);
  }
  const rewritten = rewriteRefs(html, (rel) => byRel.get(rel.toLowerCase()) || byBase.get(path.posix.basename(rel).toLowerCase()) || null);
  html = rewritten.html;
  if (rewritten.missing.length) warnings.push(`Image file${rewritten.missing.length > 1 ? "s" : ""} not included: ${rewritten.missing.slice(0, 5).join(", ")}${rewritten.missing.length > 5 ? "…" : ""} — they'll show broken`);

  // unsubscribe → Zoho's tag (a function replacement: "$" is special in strings)
  for (const re of OTHER_UNSUBSCRIBE) html = html.replace(re, () => UNSUBSCRIBE_TAG);
  if (!html.includes(UNSUBSCRIBE_TAG) && !html.includes("$[LI:ORG_OPTOUT]$")) {
    warnings.push("No unsubscribe link in the email — Zoho will add its own footer with one");
  }

  // no scripts or inline handlers
  const before = html.length;
  html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "");
  if (html.length !== before) warnings.push("Scripts were removed from the email (email apps don't run them)");

  const leftover = html.match(/\{\{\s*[\w.]+\s*\}\}/g);
  if (leftover) warnings.push(`Placeholders Zoho won't fill: ${[...new Set(leftover)].slice(0, 5).join(", ")}`);

  const contentUrl = await put(`${prefix}/email-${rev}.html`, html, "text/html; charset=utf-8", "no-cache");
  return { html, text, contentUrl, assets, warnings };
}

module.exports = { prepareContent, LIMITS, UNSUBSCRIBE_TAG };
