// BuzzTech PO PDF import — port of the n8n "BuzzTech PO" workflow.
// Steps performed by POST /zoho/buzztech/parsePdf:
//   1. Receive a single PDF upload (multipart, field name "file").
//   2. Validate it's a "PO ..." style file by filename.
//   3. Extract raw text with pdf-parse.
//   4. Parse the BuzzTech PO line-item table (see parseBuzztechTable below).
//   5. Look up each manufacturerSKU in our Zoho Analytics view to resolve it
//      to an Item ID and Status.
//   6. Return { filename, kept, discarded } so the frontend can show a review
//      screen before calling /zoho/salesOrder/create with the kept lines.
//
// Order creation itself is delegated to /zoho/salesOrder/create — we don't
// want to duplicate the create logic, and that endpoint already enforces the
// pricebook and customer constraints we need.

const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const router = express.Router();

const { getViewData } = require("../../../utils/zohoRequest");
const { requirePermission } = require("../../../middleware/auth");

const ANALYTICS_WORKSPACE_ID = "1404913000003936002";
const ANALYTICS_VIEW_ID = "1404913000003936100";

// In-memory upload, 10 MB cap — POs are small (hundreds of KB at most).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ── PDF parser (ported verbatim from the n8n Code node) ────────────────────
// Recognises the BuzzTech PO table structure. Each row has:
//   supplierSKU, supplierSKU2, manufacturerSKU, description, attributes,
//   qty, supplierBuyExTax, totalSupplierExTax.
// The format isn't a real table in the PDF — pdf-parse returns text in
// reading order, so we walk lines and pattern-match on shape (uppercase
// dash-delimited SKUs, $-prefixed money values, etc.).

function isMoney(value) {
  return /^\$[\d,]+(\.\d{2})?$/.test(value);
}

function isSupplierSku(value) {
  return /^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(value) || /^SKU-\d+/.test(value);
}

function isAttributeLabel(token) {
  return /^(Size|Colour|Season|Brand):$/i.test(token);
}

// Manufacturer SKUs in BuzzTech POs are 3-5 digit numbers, optionally
// followed by a "-suffix" (e.g. "3438", "7297", "16224-Incell"). The
// adjacent supplier-SKU2 column is either a 6-digit-prefix code like
// "150520-502" (too long to match here) or repeats the supplier SKU
// pattern (uppercase-dash, also no match), so this regex reliably picks
// the manufacturer SKU even when supplier-SKU2 spills across many tokens.
function isManufacturerSku(token) {
  return /^\d{3,5}(-[A-Za-z0-9]+)?$/.test(token);
}

// Look at position j: is this the start of the qty + money + money triplet
// that terminates each row? Tolerates a "$" sign sitting on its own line
// when pdf-parse splits a value like "$10.68" into two tokens (rare but
// observed on some PDFs).
function findRowTerminator(lines, from, to) {
  for (let j = from; j < to; j++) {
    if (/^\d+$/.test(lines[j]) && isMoney(lines[j + 1] || "") && isMoney(lines[j + 2] || "")) {
      return j;
    }
  }
  return -1;
}

// Find the manufacturer SKU index in [from, to). Returns -1 if none of the
// tokens in the range look like one.
function findManufacturerSku(lines, from, to) {
  for (let k = from; k < to; k++) {
    if (isManufacturerSku(lines[k])) return k;
  }
  return -1;
}

// Re-read the PDF, this time using a pagerender hook to collect each text
// item's (x, y) position alongside the string. Returns an array of
// { str, x, y, page } for every non-empty token. Used to locate the true
// MANUFACTURER SKU column value for each row (see applyPositionalManufacturerSkus).
async function extractPositionalTokens(buffer) {
  const tokens = [];
  let pageIdx = 0;
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      pageIdx++;
      const page = pageData.pageNumber || pageIdx;
      const tc = await pageData.getTextContent();
      for (const item of tc.items) {
        const str = String(item.str || "").trim();
        if (!str) continue;
        tokens.push({
          str,
          x: item.transform[4],
          y: item.transform[5],
          page,
        });
      }
      // Returning a placeholder is fine — pdf-parse's `text` field is read
      // from the FIRST call only (above), not this one.
      return "";
    },
  });
  return tokens;
}

// Mutates `rows` in place — replaces each row's manufacturerSKU with the
// token sitting at the same x-position as that row's supplierSKU on the
// MANUFACTURER SKU row of the same section. This is the bit that bypasses
// the format-detection heuristic and reads exactly what's in the
// MANUFACTURER SKU column, no matter how it's shaped.
function applyPositionalManufacturerSkus(rows, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;

  const Y_TOL = 4;
  const X_TOL = 4;

  // Pre-index MANUFACTURER labels by page for the lookup below.
  const mfgLabels = tokens.filter((t) => t.str === "MANUFACTURER");

  for (const row of rows) {
    // Locate this row's supplierSKU in the positional data. PO line items
    // each carry a unique supplierSKU, so this is an unambiguous anchor.
    const supplierTok = tokens.find((t) => t.str === row.supplierSKU);
    if (!supplierTok) continue;

    // Pick the MANUFACTURER label closest in y on the same page — that's
    // the one belonging to this item's section (the PO has multiple
    // sections across multiple pages).
    let mfgLabel = null;
    let mfgDist = Infinity;
    for (const lbl of mfgLabels) {
      if (lbl.page !== supplierTok.page) continue;
      const d = Math.abs(lbl.y - supplierTok.y);
      if (d < mfgDist) {
        mfgDist = d;
        mfgLabel = lbl;
      }
    }
    if (!mfgLabel) continue;

    // The value sits on the same y-row as the label, at the supplierSKU's
    // x. Tolerate small misalignment in both axes.
    const candidates = tokens.filter(
      (t) =>
        t.page === supplierTok.page &&
        Math.abs(t.y - mfgLabel.y) <= Y_TOL &&
        Math.abs(t.x - supplierTok.x) <= X_TOL &&
        t.str !== "MANUFACTURER" &&
        t.str !== "SKU:"
    );
    if (candidates.length === 0) continue;

    // Closest by x wins.
    candidates.sort(
      (a, b) => Math.abs(a.x - supplierTok.x) - Math.abs(b.x - supplierTok.x)
    );
    row.manufacturerSKU = candidates[0].str;
  }
}

function parseBuzztechTable(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // pdf-parse on this codebase splits text into one TOKEN per line rather
  // than one visual line — so "SUPPLIER SKU:" comes back as ["SUPPLIER",
  // "SKU:"], not as the single string the n8n flow saw. Detect the header
  // by looking for those two tokens in sequence.
  let headerStart = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === "SUPPLIER" && lines[i + 1] === "SKU:") {
      headerStart = i;
      break;
    }
  }
  if (headerStart === -1) {
    const err = new Error("Table header not found in PDF");
    err.code = "TABLE_NOT_FOUND";
    throw err;
  }

  // Skip ahead until we find the first row's supplier SKU. We can't reliably
  // count header tokens because the BuzzTech header includes labels like
  // "(EX Tax)" that split unevenly; scanning is simpler and more robust.
  let i = headerStart + 2;
  while (i < lines.length && !isSupplierSku(lines[i])) {
    i++;
  }

  const rows = [];
  while (i < lines.length) {
    const supplierSKU = lines[i];
    if (!isSupplierSku(supplierSKU)) {
      i++;
      continue;
    }
    if (supplierSKU === "TOTAL") break;

    // Find the row body's end: the qty+money+money terminator. Also bound
    // by the next row's supplier SKU so we don't run off into a malformed
    // entry's neighbour. We start the scan at i+3 (past the typical
    // supplier-SKU2 / manufacturer-SKU positions) to avoid mistaking
    // supplier-SKU2 codes like "150520-502" — which happen to match the
    // generic isSupplierSku pattern — for the next row's anchor.
    let scanEnd = lines.length;
    for (let k = i + 3; k < lines.length; k++) {
      if (isSupplierSku(lines[k]) && lines[k] !== supplierSKU) {
        scanEnd = k;
        break;
      }
    }
    const qtyIdx = findRowTerminator(lines, i + 1, scanEnd);
    if (qtyIdx === -1) {
      i = scanEnd;
      continue;
    }

    // Locate the manufacturer SKU within the row body — first 3-5 digit
    // (optionally suffixed) token after supplierSKU. Everything between
    // supplierSKU and manufacturerSKU is treated as the supplier-SKU2
    // column (which BuzzTech sometimes uses as freeform text — e.g.
    // "Samsung Galaxy S20 FE Scr een Replacement" or "Rear Camera").
    const manufIdx = findManufacturerSku(lines, i + 1, qtyIdx);
    let supplierSKU2;
    let manufacturerSKU;
    let bodyStart;
    if (manufIdx !== -1) {
      supplierSKU2 = lines.slice(i + 1, manufIdx).join(" ");
      manufacturerSKU = lines[manufIdx];
      bodyStart = manufIdx + 1;
    } else {
      // Fall back to the simple positional read so well-formed rows where
      // the manufacturer SKU somehow doesn't match (e.g. an alphanumeric
      // part number) still parse.
      supplierSKU2 = lines[i + 1] || "";
      manufacturerSKU = lines[i + 2] || "";
      bodyStart = i + 3;
    }

    // Split [bodyStart .. qtyIdx) between description and attributes.
    // Attributes start at the first Size:/Colour:/Season:/Brand: label;
    // everything before that is description. We DON'T terminate description
    // on a digit because product descriptions routinely contain numbers
    // ("iPhone 8 Battery", "(ID: 124992)" etc.).
    let attrStart = qtyIdx;
    for (let k = bodyStart; k < qtyIdx; k++) {
      if (isAttributeLabel(lines[k])) {
        attrStart = k;
        break;
      }
    }

    rows.push({
      supplierSKU,
      supplierSKU2,
      manufacturerSKU,
      description: lines.slice(bodyStart, attrStart).join(" "),
      attributes: lines.slice(attrStart, qtyIdx).join(" "),
      qty: Number(lines[qtyIdx]),
      supplierBuyExTax: lines[qtyIdx + 1],
      totalSupplierExTax: lines[qtyIdx + 2],
    });

    i = qtyIdx + 3;
  }

  return rows;
}

// Resolve a list of manufacturerSKUs against the Zoho Analytics item view.
// Returns a Map keyed by lowercased SKU → { itemId, sku, name, status }.
// Missing SKUs are simply absent from the map. We pull `Item Name` too so
// the review screen can show the Zoho name next to the PDF description for
// at-a-glance comparison.
async function lookupSkusInAnalytics(skus) {
  const map = new Map();
  const unique = Array.from(
    new Set((skus || []).map((s) => String(s || "").trim()).filter(Boolean)),
  );
  if (unique.length === 0) return map;

  // Mirror the n8n quoting: lowercase + single-quoted, comma-separated.
  const inList = unique
    .map((s) => `'${s.toLowerCase().replace(/'/g, "''")}'`)
    .join(",");
  const config = {
    responseFormat: "json",
    criteria: `LOWER("SKU") IN (${inList})`,
    selectedColumns: ["Item ID", "SKU", "Item Name", "Status"],
  };
  const url = `https://analyticsapi.zoho.com/restapi/v2/workspaces/${ANALYTICS_WORKSPACE_ID}/views/${ANALYTICS_VIEW_ID}/data?CONFIG=${encodeURIComponent(JSON.stringify(config))}`;
  const rows = await getViewData(url);
  if (!Array.isArray(rows)) return map;

  for (const r of rows) {
    const sku = String(r.SKU || "").toLowerCase();
    if (!sku) continue;
    map.set(sku, {
      itemId: r["Item ID"] ? String(r["Item ID"]) : "",
      sku: r.SKU,
      name: r["Item Name"] || "",
      status: r.Status || "",
    });
  }
  return map;
}

router.post(
  "/parsePdf",
  requirePermission("zoho:salesOrder:create"),
  upload.single("file"),
  async function (req, res) {
    try {
      if (!req.file || !req.file.buffer) {
        return res
          .status(400)
          .json({ success: false, message: "PDF file is required (form field 'file')" });
      }
      const filename = req.file.originalname || "upload.pdf";

      // n8n's If1 node — only accept files whose name starts with "PO".
      if (!filename.toUpperCase().startsWith("PO")) {
        return res.status(400).json({
          success: false,
          message: `Filename must start with "PO" — got "${filename}"`,
        });
      }

      // 1) Extract text (default pdf-parse rendering — same behaviour the
      //    table parser was designed around). A second pass below collects
      //    positional data without disturbing the text output.
      let extracted;
      try {
        extracted = await pdfParse(req.file.buffer);
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: `Could not read PDF: ${e.message || e}`,
        });
      }

      // 1b) Collect positional tokens for the manufacturer-SKU augmentation
      //     pass. Failure here is non-fatal — we just skip the augment and
      //     fall back to whatever the text parser produced.
      let positionalTokens = [];
      try {
        positionalTokens = await extractPositionalTokens(req.file.buffer);
      } catch (e) {
        console.warn("Positional token extraction failed:", e.message || e);
      }

      // 2) Parse the table
      let rawItems;
      try {
        rawItems = parseBuzztechTable(extracted.text || "");
      } catch (e) {
        const status = e.code === "TABLE_NOT_FOUND" ? 422 : 500;
        return res
          .status(status)
          .json({ success: false, message: e.message || "Parse failed" });
      }

      // 2b) Replace each row's manufacturerSKU with the value sitting
      //     directly in the MANUFACTURER SKU column at the item's x position.
      try {
        applyPositionalManufacturerSkus(rawItems, positionalTokens);
      } catch (e) {
        console.warn("Positional manufacturer SKU augment failed:", e.message || e);
        // Don't fail the request — leave rawItems with whatever the text
        // parser produced. The review screen still surfaces issues.
      }

      if (rawItems.length === 0) {
        return res.status(422).json({
          success: false,
          message: "No line items found in the PDF",
        });
      }

      // 3) Resolve each manufacturerSKU to a Zoho Item ID + Status
      const skuMap = await lookupSkusInAnalytics(
        rawItems.map((r) => r.manufacturerSKU),
      );

      const kept = [];
      const discarded = [];
      for (const item of rawItems) {
        const match = skuMap.get(String(item.manufacturerSKU || "").toLowerCase());
        if (match && match.itemId) {
          kept.push({
            ...item,
            itemId: match.itemId,
            // Zoho's stored name — the review screen renders this beside the
            // PDF description so the user can sanity-check the SKU match.
            zohoName: match.name || "",
            status: match.status,
          });
        } else {
          discarded.push(item);
        }
      }

      return res.json({
        success: true,
        data: {
          filename,
          kept,
          discarded,
          // Summary the frontend uses to render the review screen at a glance.
          summary: {
            totalParsed: rawItems.length,
            kept: kept.length,
            discarded: discarded.length,
            inactive: kept.filter((k) => k.status && k.status !== "Active").length,
          },
        },
      });
    } catch (error) {
      console.error("BuzzTech parsePdf error:", error);
      return res.status(500).json({
        success: false,
        message: `Failed to parse PDF: ${error.message || error}`,
      });
    }
  },
);

module.exports = router;
