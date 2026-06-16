// Slug helpers for the IMB catalogue reference collections.
//
// Reference docs (brand / model / quality) use a human-readable slug as
// their _id. These helpers generate those slugs consistently with the
// values already in the database (see IMB-database-schema.md examples)
// so UI-created entries match the import-pipeline conventions.

// Base slugify: lowercase, "+" → "plus" (so "JK+" → "jk-plus", matching
// the existing quality ids), any run of non-alphanumerics → single
// hyphen, trim leading/trailing hyphens.
function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Brand id: plain slug of the display name. "Apple" → "apple".
function brandSlug(name) {
  return slugify(name);
}

// Model id: plain slug of the display name. Matches the OZ resolver's
// model_id rule because "iPhone 16 Pro Max" slugifies to
// "iphone-16-pro-max" either way (the resolver strips "iPhone" then
// re-prefixes "iphone-"; plain slugify lands on the same string).
function modelSlug(name) {
  return slugify(name);
}

// Quality id: category-scoped. "<category>-<grade-slug>", e.g.
// category "screen" + name "JK+" → "screen-jk-plus". The category
// prefix enforces the schema's "quality scoped to its category" rule
// (§6) at the id level.
function qualitySlug(categoryId, name) {
  const cat = slugify(categoryId);
  const grade = slugify(name);
  return `${cat}-${grade}`;
}

module.exports = { slugify, brandSlug, modelSlug, qualitySlug };
