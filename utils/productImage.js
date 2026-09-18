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

module.exports = { imageIdOf, imageUrlFromId };
