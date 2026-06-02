// Exercise the BuzzTech parser against a real PDF, without the HTTP layer.
// Usage: node bin/probe-parser.js <path-to-pdf>

const fs = require('fs');
const pdfParse = require('pdf-parse');

// Re-create the parser in isolation so we can iterate without restarting
// the backend. Keep this in sync with routes/zohoRoutes/buzztech/index.js
// while iterating, then delete this probe.
function isMoney(value) {
    return /^\$[\d,]+(\.\d{2})?$/.test(value);
}
function isSupplierSku(value) {
    return /^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(value) || /^SKU-\d+/.test(value);
}
function isAttributeLabel(token) {
    return /^(Size|Colour|Season|Brand):$/i.test(token);
}
function isManufacturerSku(token) {
    return /^\d{3,5}(-[A-Za-z0-9]+)?$/.test(token);
}
function findRowTerminator(lines, from, to) {
    for (let j = from; j < to; j++) {
        if (/^\d+$/.test(lines[j]) && isMoney(lines[j + 1] || '') && isMoney(lines[j + 2] || '')) {
            return j;
        }
    }
    return -1;
}
function findManufacturerSku(lines, from, to) {
    for (let k = from; k < to; k++) {
        if (isManufacturerSku(lines[k])) return k;
    }
    return -1;
}

function parseBuzztechTable(rawText) {
    const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);
    let headerStart = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === 'SUPPLIER' && lines[i + 1] === 'SKU:') {
            headerStart = i;
            break;
        }
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
        for (let k = i + 1; k < lines.length; k++) {
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
        for (let k = bodyStart; k < qtyIdx; k++) {
            if (isAttributeLabel(lines[k])) { attrStart = k; break; }
        }

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

(async () => {
    const path = process.argv[2];
    if (!path) { console.error('Usage: node bin/probe-parser.js <pdf>'); process.exit(1); }
    const buf = fs.readFileSync(path);
    const result = await pdfParse(buf);
    const rows = parseBuzztechTable(result.text);
    console.log(`Parsed ${rows.length} rows.\n`);
    rows.forEach((r, idx) => {
        console.log(`[${idx + 1}] ${r.supplierSKU}  |  ${r.manufacturerSKU}  |  qty=${r.qty}  |  ${r.supplierBuyExTax} -> ${r.totalSupplierExTax}`);
        console.log(`    desc: ${r.description}`);
        console.log(`    attr: ${r.attributes}`);
        console.log();
    });
})();
