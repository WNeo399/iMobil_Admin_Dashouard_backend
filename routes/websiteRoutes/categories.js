// iMobile Website → Categories (user ask 2026-10-16): the online store's
// category tree, straight from Zoho Commerce (utils/zohoCommerce). Commerce
// and Inventory share one category tree (same ids), so this is also what
// Zoho Inventory items are filed under.
//
//   GET  /website/categories[?refresh=1]          every category, flat (parentId / depth)
//   POST /website/categories                      { name, url?, parentId?, visible?, showInMenu?, description? }
//   PUT  /website/categories/:id                  { name?, url?, parentId?, visible?, showInMenu?, description? }
//   GET  /website/categories/:id/products?page=   the products filed directly under it (50 a page)
//   GET  /website/categories/products/search?q=   find products by name / SKU
//   POST /website/categories/products/move        { productIds: [...], categoryId } — file products under a category
//
// listing:category:view reads, listing:category:manage writes — the page sits
// under iMobile Listing (2026-10-16): Admin, iMobile Warehouse, iMobile
// Purchase (listing:*:*). Nothing is deleted from here.

const express = require("express");
const router = express.Router();
const { requirePermission } = require("../../middleware/auth");
const { commerce } = require("../../utils/zohoCommerce");
const { imageUrlFromId } = require("../../utils/productImage");

const VIEW = requirePermission("listing:category:view");
const MANAGE = requirePermission("listing:category:manage");

const ROOT = "-1";
const PAGE_SIZE = 50;
const MAX_MOVE = 50;
const str = (v) => String(v == null ? "" : v).trim();
const URL_RE = /^[A-Za-z0-9_-]+$/;

// A Zoho error body as a readable message; the store's own codes in words.
const ZOHO_MESSAGES = {
  250001: "The parent category no longer exists in Zoho — refresh and pick again",
  250005: "That URL is already used by another category — change the URL",
  1002: "That category or product no longer exists in Zoho — refresh",
};
function zohoFail(res, d, fallback) {
  const code = d && d.code;
  const message = ZOHO_MESSAGES[code] || (d && d.message) || fallback;
  return res.status(code === 1002 ? 404 : 400).json({ success: false, message, zohoCode: code });
}

const slugify = (s) =>
  str(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);

function shapeCategory(c) {
  return {
    id: str(c.category_id),
    name: c.name || "",
    parentId: str(c.parent_category_id) || ROOT,
    depth: Number(c.depth) || 0,
    order: Number(c.sibling_order) || 0,
    url: c.url || "",
    visible: c.visibility !== false,
    showInMenu: !!c.show_in_menu,
    hasProducts: !!c.has_active_items,
    description: c.description || "",
  };
}

function shapeProduct(p) {
  const variants = Array.isArray(p.variants) ? p.variants : [];
  return {
    productId: str(p.product_id),
    name: p.name || "",
    brand: p.brand || "",
    status: p.status || "",
    showInStorefront: p.show_in_storefront !== false,
    categoryId: str(p.category_id),
    categoryName: p.category_name || "",
    skus: [...new Set(variants.map((v) => str(v.sku)).filter(Boolean))],
    variantCount: Number(p.variant_count) || variants.length || 1,
    minRate: p.min_rate == null ? null : Number(p.min_rate),
    maxRate: p.max_rate == null ? null : Number(p.max_rate),
    imageUrl: p.document_id ? imageUrlFromId(str(p.document_id)) : null,
  };
}

// The category list changes rarely; a minute's cache keeps clicks cheap,
// and every write here clears it.
let cache = { at: 0, list: null };
const TTL = 60 * 1000;
async function loadCategories(force) {
  if (!force && cache.list && Date.now() - cache.at < TTL) return cache.list;
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const d = await commerce("get", "/categories", { params: page > 1 ? { page } : undefined });
    if (!d || d.code !== 0 || !Array.isArray(d.categories)) {
      const e = new Error((d && d.message) || "Zoho did not return the categories");
      e.zoho = d;
      throw e;
    }
    all.push(...d.categories);
    if (!(d.page_context && d.page_context.has_more_page)) break;
  }
  const seen = new Set();
  const list = all
    .filter((c) => str(c.category_id) !== ROOT && !seen.has(str(c.category_id)) && seen.add(str(c.category_id)))
    .map(shapeCategory);
  cache = { at: Date.now(), list };
  return list;
}
const dropCache = () => { cache = { at: 0, list: null }; };

// ids of a category and everything below it (a category can't move under its own branch)
function branchIds(list, id) {
  const kids = new Map();
  for (const c of list) {
    if (!kids.has(c.parentId)) kids.set(c.parentId, []);
    kids.get(c.parentId).push(c.id);
  }
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!out.has(k)) { out.add(k); stack.push(k); }
  return out;
}

router.get("/", VIEW, async (req, res) => {
  try {
    const categories = await loadCategories(req.query.refresh === "1");
    return res.json({ success: true, categories, at: new Date(cache.at) });
  } catch (e) {
    console.error("Commerce categories error:", e.message);
    return res.status(502).json({ success: false, message: "Could not read the categories from Zoho Commerce" });
  }
});

router.post("/", MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const name = str(b.name).slice(0, 200);
    if (!name) return res.status(400).json({ success: false, message: "A category name is required" });
    const url = str(b.url) || slugify(name);
    if (!URL_RE.test(url)) return res.status(400).json({ success: false, message: "The URL may only hold letters, numbers, - and _" });
    const parentId = str(b.parentId) || ROOT;
    const list = await loadCategories(true);
    if (parentId !== ROOT && !list.some((c) => c.id === parentId)) {
      return res.status(400).json({ success: false, message: "The parent category no longer exists — refresh and pick again" });
    }
    const d = await commerce("post", "/categories", {
      data: {
        name,
        url,
        parent_category_id: parentId,
        visibility: b.visible !== false,
        show_in_menu: !!b.showInMenu,
        description: str(b.description).slice(0, 2000),
      },
    });
    if (!d || d.code !== 0 || !d.category) return zohoFail(res, d, "Zoho did not create the category");
    dropCache();
    return res.json({ success: true, message: `${name} created`, category: shapeCategory(d.category) });
  } catch (e) {
    console.error("Commerce create category error:", e.message);
    return res.status(500).json({ success: false, message: "Failed to create the category" });
  }
});

router.put("/:id", MANAGE, async (req, res) => {
  try {
    const id = str(req.params.id);
    if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: "Bad category id" });
    const b = req.body || {};
    const list = await loadCategories(true);
    const cur = list.find((c) => c.id === id);
    if (!cur) return res.status(404).json({ success: false, message: "Category not found — refresh" });
    // Zoho's own record, so the SEO fields we don't edit are sent back as they are
    const ed = await commerce("get", "/categories/editpage", { params: { category_id: id } });
    const z = (ed && ed.code === 0 && ed.category) || {};
    const name = b.name !== undefined ? str(b.name).slice(0, 200) : cur.name;
    if (!name) return res.status(400).json({ success: false, message: "A category name is required" });
    const url = b.url !== undefined ? str(b.url) : cur.url;
    if (url && !URL_RE.test(url)) return res.status(400).json({ success: false, message: "The URL may only hold letters, numbers, - and _" });
    let parentId = cur.parentId;
    if (b.parentId !== undefined) {
      parentId = str(b.parentId) || ROOT;
      if (parentId !== ROOT && !list.some((c) => c.id === parentId)) return res.status(400).json({ success: false, message: "The new parent category no longer exists — refresh" });
      if (branchIds(list, id).has(parentId)) return res.status(400).json({ success: false, message: "A category can't move under itself or one of its own sub-categories" });
    }
    const data = {
      name,
      url,
      parent_category_id: parentId,
      description: b.description !== undefined ? str(b.description).slice(0, 2000) : cur.description,
      visibility: b.visible !== undefined ? !!b.visible : cur.visible,
      show_in_menu: b.showInMenu !== undefined ? !!b.showInMenu : cur.showInMenu,
      ...(z.seo_title !== undefined ? { seo_title: z.seo_title } : {}),
      ...(z.seo_keyword !== undefined ? { seo_keyword: z.seo_keyword } : {}),
      ...(z.seo_description !== undefined ? { seo_description: z.seo_description } : {}),
    };
    const d = await commerce("put", `/categories/${id}`, { data });
    if (!d || d.code !== 0 || !d.category) return zohoFail(res, d, "Zoho did not update the category");
    dropCache();
    return res.json({ success: true, message: `${name} updated`, category: shapeCategory(d.category) });
  } catch (e) {
    console.error("Commerce update category error:", e.message);
    return res.status(500).json({ success: false, message: "Failed to update the category" });
  }
});

// The product routes come before /:id/products so "products" isn't read as an id.
router.get("/products/search", VIEW, async (req, res) => {
  try {
    const q = str(req.query.q).slice(0, 100);
    if (q.length < 2) return res.json({ success: true, products: [] });
    const d = await commerce("get", "/products", { params: { search_text: q, per_page: 30 } });
    if (!d || d.code !== 0 || !Array.isArray(d.products)) return zohoFail(res, d, "Zoho did not return products");
    return res.json({ success: true, products: d.products.map(shapeProduct) });
  } catch (e) {
    console.error("Commerce product search error:", e.message);
    return res.status(502).json({ success: false, message: "Could not search products in Zoho Commerce" });
  }
});

router.post("/products/move", MANAGE, async (req, res) => {
  try {
    const b = req.body || {};
    const categoryId = str(b.categoryId);
    const ids = [...new Set((Array.isArray(b.productIds) ? b.productIds : []).map(str).filter((x) => /^\d+$/.test(x)))];
    if (!ids.length) return res.status(400).json({ success: false, message: "Pick at least one product" });
    if (ids.length > MAX_MOVE) return res.status(400).json({ success: false, message: `At most ${MAX_MOVE} products at a time` });
    const list = await loadCategories(false);
    const target = list.find((c) => c.id === categoryId);
    if (!target) return res.status(400).json({ success: false, message: "Pick a category — that one no longer exists" });
    const moved = [];
    const failed = [];
    for (const productId of ids) {
      // only the category changes; Zoho takes a partial product update
      const d = await commerce("put", `/products/${productId}`, { data: { category_id: categoryId } });
      if (d && d.code === 0 && d.product && str(d.product.category_id) === categoryId) moved.push(shapeProduct(d.product));
      else failed.push({ productId, message: (d && (ZOHO_MESSAGES[d.code] || d.message)) || "Zoho did not update the product" });
    }
    dropCache();
    return res.json({
      success: failed.length === 0,
      message: failed.length ? `${moved.length} moved to ${target.name}, ${failed.length} failed` : `${moved.length} moved to ${target.name}`,
      moved,
      failed,
    });
  } catch (e) {
    console.error("Commerce move products error:", e.message);
    return res.status(500).json({ success: false, message: "Failed to move the products" });
  }
});

router.get("/:id/products", VIEW, async (req, res) => {
  try {
    const id = str(req.params.id);
    if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, message: "Bad category id" });
    const page = Math.max(1, Math.min(200, parseInt(req.query.page, 10) || 1));
    // category_id alone: Zoho drops the category filter when filter_by is added
    const d = await commerce("get", "/products", { params: { category_id: id, page, per_page: PAGE_SIZE } });
    if (!d || d.code !== 0 || !Array.isArray(d.products)) return zohoFail(res, d, "Zoho did not return the products");
    return res.json({
      success: true,
      products: d.products.map(shapeProduct),
      page,
      pageSize: PAGE_SIZE,
      hasMore: !!(d.page_context && d.page_context.has_more_page),
    });
  } catch (e) {
    console.error("Commerce category products error:", e.message);
    return res.status(502).json({ success: false, message: "Could not read the products from Zoho Commerce" });
  }
});

module.exports = router;
module.exports.slugify = slugify;
// New Products' create dialog picks a category from the same (cached) list
module.exports.loadCategories = loadCategories;

// A category id from a dialog, checked against the store's list (read again
// when it isn't there — it may have been made in Zoho a moment ago); hidden
// ones count too. { category } or { error, status }. Shared by New Products
// and the Purchase Order page's "Create in Zoho".
async function findCategory(id) {
  try {
    let category = (await loadCategories()).find((c) => c.id === id);
    if (!category) category = (await loadCategories(true)).find((c) => c.id === id);
    return category ? { category } : { error: "That category no longer exists — refresh and pick again", status: 400 };
  } catch (e) {
    return { error: "Could not read the categories from Zoho Commerce — try again", status: 502 };
  }
}
module.exports.findCategory = findCategory;
