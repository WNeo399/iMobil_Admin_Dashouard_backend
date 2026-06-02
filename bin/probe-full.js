// End-to-end probe of the BuzzTech parser including the positional
// manufacturer-SKU augmentation. Bypasses the HTTP layer so we can verify
// the row output without running the server.

const fs = require('fs');
const pdfParse = require('pdf-parse');

function isMoney(v) { return /^\$[\d,]+(\.\d{2})?$/.test(v); }
function isSupplierSku(v) { return /^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(v) || /^SKU-\d+/.test(v); }
function isAttributeLabel(t) { return /^(Size|Colour|Season|Brand):$/i.test(t); }
function isManufacturerSku(t) { return /^\d{3,5}(-[A-Za-z0-9]+)?$/.test(t); }

function findRowTerminator(lines, from, to) {
    for (let j = from; j < to; j++) {
        if (/^\d+$/.test(lines[j]) && isMoney(lines[j + 1] || '') && isMoney(lines[j + 2] || '')) return j;
    }
    return -1;
}
function findManufacturerSku(lines, from, to) {
    for (let k = from; k < to; k++) if (isManufacturerSku(lines[k])) return k;
    return -1;
}

function parseBuzztechTable(rawText) {
    const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
    let headerStart = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === 'SUPPLIER' && lines[i + 1] === 'SKU:') { headerStart = i; break; }
    }
    if (headerStart === -1) throw Object.assign(new Error('Table header not found'), { code: 'TABLE_NOT_FOUND' });

    let i = headerStart + 2;
    while (i < lines.length && !isSupplierSku(lines[i])) i++;

    const rows = [];
    while (i < lines.length) {
        const supplierSKU = lines[i];
        if (!isSupplierSku(supplierSKU)) { i++; continue; }
        if (supplierSKU === 'TOTAL') break;

        let scanEnd = lines.length;
        for (let k = i + 3; k < lines.length; k++) {
            if (isSupplierSku(lines[k]) && lines[k] !== supplierSKU) { scanEnd = k; break; }
        }
        const qtyIdx = findRowTerminator(lines, i + 1, scanEnd);
        if (qtyIdx === -1) { i = scanEnd; continue; }

        const manufIdx = findManufacturerSku(lines, i + 1, qtyIdx);
        let supplierSKU2, manufacturerSKU, bodyStart;
        if (manufIdx !== -1) {
            supplierSKU2 = lines.slice(i + 1, manufIdx).join(' ');
            manufacturerSKU = lines[manufIdx];
            bodyStart = manufIdx + 1;
        } else {
            supplierSKU2 = lines[i + 1] || '';
            manufacturerSKU = lines[i + 2] || '';
            bodyStart = i + 3;
        }

        let attrStart = qtyIdx;
        for (let k = bodyStart; k < qtyIdx; k++) if (isAttributeLabel(lines[k])) { attrStart = k; break; }

        rows.push({
            supplierSKU,
            supplierSKU2,
            manufacturerSKU,
            description: lines.slice(bodyStart, attrStart).join(' '),
            attributes: lines.slice(attrStart, qtyIdx).join(' '),
            qty: Number(lines[qtyIdx]),
            supplierBuyExTax: lines[qtyIdx + 1],
            totalSupplierExTax: lines[qtyIdx + 2],
        });
        i = qtyIdx + 3;
    }
    return rows;
}

function applyPositionalManufacturerSkus(rows, tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return;
    const Y_TOL = 4;
    const X_TOL = 4;
    const mfgLabels = tokens.filter(t => t.str === 'MANUFACTURER');
    for (const row of rows) {
        const supplierTok = tokens.find(t => t.str === row.supplierSKU);
        if (!supplierTok) continue;
        let mfgLabel = null;
        let mfgDist = Infinity;
        for (const lbl of mfgLabels) {
            if (lbl.page !== supplierTok.page) continue;
            const d = Math.abs(lbl.y - supplierTok.y);
            if (d < mfgDist) { mfgDist = d; mfgLabel = lbl; }
        }
        if (!mfgLabel) continue;
        const candidates = tokens.filter(t =>
            t.page === supplierTok.page &&
            Math.abs(t.y - mfgLabel.y) <= Y_TOL &&
            Math.abs(t.x - supplierTok.x) <= X_TOL &&
            t.str !== 'MANUFACTURER' && t.str !== 'SKU:'
        );
        if (candidates.length === 0) continue;
        candidates.sort((a, b) => Math.abs(a.x - supplierTok.x) - Math.abs(b.x - supplierTok.x));
        row.manufacturerSKU = candidates[0].str;
    }
}

(async () => {
    const path = process.argv[2];
    if (!path) { console.error('Usage: node bin/probe-full.js <pdf>'); process.exit(1); }
    const buf = fs.readFileSync(path);
    // Pass 1: default text extraction (don't disturb pdf-parse's output).
    const extracted = await pdfParse(buf);
    // Pass 2: collect positional tokens via custom pagerender.
    const positionalTokens = [];
    let pageIdx = 0;
    await pdfParse(buf, {
        pagerender: async (pageData) => {
            pageIdx++;
            const page = pageData.pageNumber || pageIdx;
            const tc = await pageData.getTextContent();
            for (const item of tc.items) {
                const str = String(item.str || '').trim();
                if (!str) continue;
                positionalTokens.push({ str, x: item.transform[4], y: item.transform[5], page });
            }
            return '';
        },
    });
    const rows = parseBuzztechTable(extracted.text);
    applyPositionalManufacturerSkus(rows, positionalTokens);
    console.log(`Parsed ${rows.length} rows. Positional tokens: ${positionalTokens.length}\n`);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        console.log(`[${i + 1}] ${r.supplierSKU.padEnd(24)} | mfg=${String(r.manufacturerSKU).padEnd(16)} | qty=${r.qty}`);
    }
})();
