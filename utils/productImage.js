// Product image URLs. The stock snapshot stores only Zoho's image id
// (image_document_id — the item's main image, not necessarily its first
// upload); routes turn it into a URL when a page reads it.
//
// Zoho's own image endpoints need OAuth, so the URL is the online store's
// public one, which finds the image by id. The item details carry no file
// name, and with a stand-in one the store returns the image at full size
// rather than the 400x400 resize.

const STORE_IMAGE_BASE = "https://www.imobilestore.com.au/product-images";

// The main image id from a Zoho *itemdetails* record (the bulk endpoint).
// null = the item has no image. The single-item GET /items/{id} does NOT
// carry image_document_id — read items through itemdetails for this.
function imageIdOf(detail) {
  return String((detail && detail.image_document_id) || "").trim() || null;
}

function imageUrlFromId(imageId) {
  return imageId ? `${STORE_IMAGE_BASE}/image/${imageId}/400x400` : null;
}

// The main image for the register. Photos put in order on Listing → Edit
// (2026-10-20) make the first the item's image in Zoho, but the bulk record
// keeps its old image_document_id (tested: minutes later, and after
// update_primary_image too). So the register keeps that pick as
// `imagePick: { id, zohoId }` and uses it while Zoho's id is still the one it
// had then; once Zoho's moves (a main image changed in Zoho itself), Zoho's
// wins. Returns { imageId, stale } — stale: the pick no longer applies.
function mainImageId(detail, pick) {
  const zohoId = imageIdOf(detail);
  if (!pick || !pick.id) return { imageId: zohoId, stale: false };
  if (String(pick.zohoId || "") === String(zohoId || "")) return { imageId: String(pick.id), stale: false };
  return { imageId: zohoId, stale: true };
}

module.exports = { imageIdOf, imageUrlFromId, mainImageId };
