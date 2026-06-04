// Pure parser for the HandwritingOCR extractor payload.
//
// Direct port of desktop/html/ocrReturnParser.json (the n8n Code node)
// so the dashboard's behavior matches the workflow staff are already
// familiar with. Lives outside webhook.js so it can be unit-tested
// against captured OCR payloads without booting Express.
//
// Input is the JSON body HandwritingOCR posts when extraction finishes —
// the shape is the inner object from desktop/html/ocrreturn.json (n8n
// wraps it under `body`, but Express sticks it directly on req.body).
//
// Output:
//   {
//     creditNo:      string | null,  // sourced from the OCR `parcel_no` field
//     itemCount:     number,         // count of regular items only (excludes A9999/R9999)
//     items:         [{ sku, model, quantity }],
//     returnDevice:  [{ model, quantity }],  // A9999 rows (Received Return Device)
//     repairDevice:  [{ model, quantity }],  // R9999 rows (Received Device for Repair)
//     returnNote:    string  // newline-joined "Model x Qty (reasons)" lines
//   }
//
// A9999 and R9999 are sentinel SKUs the warehouse uses to flag returned
// devices and repair-in devices respectively — they don't represent real
// products on their own, so they get peeled off into their own arrays
// here and submitted to Zoho as line items pointing at the fixed
// catalogue item-ids on the backend submit path (see index.js).
//
// Note: the upstream HandwritingOCR field key is `parcel_no` (the
// physical parcel sticker the warehouse writes on the box), but we
// store it as `creditNo` in our DB because that's how the rest of the
// app talks about credit-note identifiers. Only the local name changes
// — the OCR payload key is left alone so re-running an older payload
// still parses cleanly.

function findField(extraction, key) {
  if (!Array.isArray(extraction)) return undefined;
  return extraction.find((f) => f && f.key === key);
}

// Sentinel SKUs the warehouse uses on warranty rows. Compared
// case-insensitively to defend against OCR/data-entry variants.
const SKU_RETURN_DEVICE = "A9999";
const SKU_REPAIR_DEVICE = "R9999";

function parseOcrResult(body) {
  const results = (body && body.results) || [];
  let creditNo = null;
  const items = [];
  const returnDevice = [];
  const repairDevice = [];
  const returnNotes = [];

  for (const page of results) {
    const extraction = page && page.extractions && page.extractions[0];
    if (!extraction) continue;

    // ── Credit No (sourced from OCR's `parcel_no`) ────────────
    // Same precedence as the n8n parser: first non-empty value wins,
    // in case a multi-page document repeats the field.
    const creditField = findField(extraction, "parcel_no");
    if (!creditNo && creditField && creditField.value) {
      creditNo = String(creditField.value);
    }

    // ── Warranty Stock Back/Refund ─────────────────────────────
    // Each row is an array of fields with sku / model / quantity.
    // We split off the two sentinel SKUs (A9999 / R9999) into their
    // own buckets — they represent received-device-for-return and
    // received-device-for-repair respectively, and need to be
    // submitted to Zoho as line items pointing at fixed catalogue
    // item-ids (handled on the submit path, not here). Regular SKUs
    // stay in `items` with their `model` field preserved.
    const warrantyField = findField(extraction, "warranty_stock_backrefund");
    if (warrantyField && Array.isArray(warrantyField.value)) {
      for (const row of warrantyField.value) {
        const sku = (findField(row, "sku") || {}).value;
        const model = (findField(row, "model") || {}).value;
        const quantity = (findField(row, "quantity") || {}).value;
        if (sku == null || sku === "") continue;

        const skuUpper = String(sku).trim().toUpperCase();
        const modelStr =
          model == null || model === "" ? "" : String(model);
        const qtyNum = Number(quantity) || 0;

        if (skuUpper === SKU_RETURN_DEVICE) {
          returnDevice.push({ model: modelStr, quantity: qtyNum });
        } else if (skuUpper === SKU_REPAIR_DEVICE) {
          repairDevice.push({ model: modelStr, quantity: qtyNum });
        } else {
          // Stringify qty so the schema stays string-typed regardless of
          // whether OCR returned a number or a string for the value —
          // matches the n8n parser's behavior. Model is left null when
          // empty so consumers can distinguish "missing" from "blank".
          items.push({
            sku: String(sku),
            model: modelStr || null,
            quantity: String(quantity == null ? 0 : quantity),
          });
        }
      }
    }

    // ── Return ─────────────────────────────────────────────────
    // Each row gets formatted as "Model x Qty (reason1, reason2)".
    // Boolean flags whose value === true are treated as reason labels;
    // a non-empty `others` string is appended verbatim.
    const returnField = findField(extraction, "return");
    if (returnField && Array.isArray(returnField.value)) {
      for (const row of returnField.value) {
        const model = (findField(row, "model_1") || {}).value || "";
        const quantity = (findField(row, "quantity_1") || {}).value;
        const qtyOut = quantity == null ? 0 : quantity;
        const reasons = Array.isArray(row)
          ? row
              .filter((f) => f && f.type === "boolean" && f.value === true)
              .map((f) => f.name)
          : [];
        const others = (findField(row, "others") || {}).value;
        if (others != null && String(others).trim()) {
          reasons.push(String(others).trim());
        }
        const suffix = reasons.length ? ` (${reasons.join(", ")})` : "";
        returnNotes.push(`${model} x ${qtyOut}${suffix}`);
      }
    }
  }

  return {
    creditNo,
    // itemCount stays as just the regular items so the Credit Note
    // list page's "Items" column reflects orderable products. The
    // returnDevice / repairDevice arrays have their own counts via
    // their `.length` when needed.
    itemCount: items.length,
    items,
    returnDevice,
    repairDevice,
    returnNote: returnNotes.join("\n"),
  };
}

module.exports = { parseOcrResult };
