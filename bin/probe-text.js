// Dump the text lines around 'SUPPLIER SKU:' so we can see why supplier
// SKUs aren't appearing where the parser expects.
const fs = require('fs');
const pdfParse = require('pdf-parse');
(async () => {
    const path = process.argv[2];
    const buf = fs.readFileSync(path);
    const r = await pdfParse(buf);
    const lines = r.text.split('\n').map(l => l.trim()).filter(Boolean);
    let i = -1;
    for (let j = 0; j < lines.length - 1; j++) {
        if (lines[j] === 'SUPPLIER' && lines[j + 1] === 'SKU:') { i = j; break; }
    }
    console.log('SUPPLIER SKU header at line:', i);
    console.log('Total lines:', lines.length);
    console.log('\n=== lines [i .. i+40] ===');
    for (let k = i; k < i + 40 && k < lines.length; k++) {
        console.log(String(k).padStart(3), '|', JSON.stringify(lines[k]));
    }
})();
