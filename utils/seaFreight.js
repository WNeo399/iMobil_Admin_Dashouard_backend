// The 海运 (sea-freight) list: the pinned Stock Monitoring collection that
// a part is added to when it should ship by sea. One doc in
// productCollections, flagged seaFreight: true, its members under
// `products` [{ itemId, name, sku, imageUrl }].
//
//   seaFreightDoc(db)              the doc (made on first use — or a hand-made
//                                  "海运" collection adopted)
//   addSeaFreightItems(db, items)  bulk add, already-listed items skipped
//                                  → { added, already, total }
//
// Shared by the row toggle (routes/zohoRoutes: POST /zoho/seaFreight/items)
// and the lists' "add everything shown" (routes/stockMonitorRoutes:
// POST /stock-monitor/sea-freight/add-matching, 2026-10-13).

const SEA_FREIGHT_TITLE = "海运";
const ID_RE = /^\d{5,25}$/;

// Deliberately NOT in any collection group, so it stays out of the
// category tree — the page pins it as a tab instead.
async function seaFreightDoc(db) {
  const col = db.collection("productCollections");
  let doc = await col.findOne({ seaFreight: true });
  if (!doc) {
    // Adopt a hand-made collection of the same name rather than shadow it.
    doc = await col.findOne({ title: SEA_FREIGHT_TITLE });
    if (doc) await col.updateOne({ _id: doc._id }, { $set: { seaFreight: true } });
  }
  if (!doc) {
    const fresh = {
      title: SEA_FREIGHT_TITLE,
      seaFreight: true,
      note: "Sea-freight list — pinned tab on Stock Monitoring",
      type: "Selection",
      status: "active",
      rules: [],
      children: [],
      products: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const r = await col.insertOne(fresh);
    doc = { _id: r.insertedId, ...fresh };
  }
  return doc;
}

// items: [{ itemId | id, name, sku }] in any mix. Bad ids and repeats are
// dropped; items already on the list are counted, not re-added.
async function addSeaFreightItems(db, items) {
  const seen = new Set();
  const clean = [];
  for (const i of items || []) {
    const itemId = String((i && (i.itemId || i.id)) || "").trim();
    if (!ID_RE.test(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    clean.push({ itemId, name: String((i && i.name) || "").trim(), sku: String((i && i.sku) || "").trim(), imageUrl: "" });
  }
  const doc = await seaFreightDoc(db);
  const existing = new Set((doc.products || []).map((p) => String(p.itemId)));
  const fresh = clean.filter((i) => !existing.has(i.itemId));
  if (fresh.length) {
    await db.collection("productCollections").updateOne(
      { _id: doc._id },
      { $push: { products: { $each: fresh } }, $set: { updatedAt: new Date() } },
    );
  }
  return { added: fresh.length, already: clean.length - fresh.length, total: existing.size + fresh.length };
}

module.exports = { SEA_FREIGHT_TITLE, seaFreightDoc, addSeaFreightItems };
