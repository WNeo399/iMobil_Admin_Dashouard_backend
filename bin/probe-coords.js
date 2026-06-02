// Inspect the (x, y) positions of every text token on page 1 of a PDF so we
// can identify column boundaries. pdf-parse uses pdfjs-dist under the hood;
// we tap into the page's TextContent directly via the pagerender hook.
//
// Usage: node bin/probe-coords.js <pdf-path>

const fs = require('fs');
const pdfParse = require('pdf-parse');

const path = process.argv[2];
if (!path) { console.error('Usage: node bin/probe-coords.js <pdf>'); process.exit(1); }

const allTokens = [];

const options = {
    pagerender: async (pageData) => {
        const textContent = await pageData.getTextContent();
        for (const item of textContent.items) {
            // transform is [a,b,c,d,e,f] — translation is e, f
            const [a, b, c, d, e, f] = item.transform;
            allTokens.push({
                str: item.str,
                x: Math.round(e * 10) / 10,
                y: Math.round(f * 10) / 10,
                w: Math.round((item.width || 0) * 10) / 10,
            });
        }
        return ''; // we don't need the text return; we collected tokens above
    },
    max: 1, // only first page
};

(async () => {
    const buf = fs.readFileSync(path);
    await pdfParse(buf, options);

    // Group tokens by Y (within tolerance). pdfjs returns y descending from top.
    const Y_TOL = 2;
    const rows = [];
    for (const tok of allTokens) {
        let row = rows.find((r) => Math.abs(r.y - tok.y) <= Y_TOL);
        if (!row) {
            row = { y: tok.y, tokens: [] };
            rows.push(row);
        }
        row.tokens.push(tok);
    }
    rows.sort((a, b) => b.y - a.y); // top-down
    for (const r of rows) r.tokens.sort((a, b) => a.x - b.x);

    // Search for every occurrence of "MANUFACTURER" — could be anywhere.
    const mfgTokens = allTokens.filter((t) => t.str.trim() === 'MANUFACTURER');
    console.log('=== "MANUFACTURER" token positions ===');
    for (const t of mfgTokens) console.log(`  y=${t.y}  x=${t.x}`);

    const skuColonTokens = allTokens.filter((t) => t.str.trim() === 'SKU:');
    console.log('\n=== "SKU:" token positions ===');
    for (const t of skuColonTokens) console.log(`  y=${t.y}  x=${t.x}`);

    // Show all rows with non-trivial token count (≥ 3 tokens) — these are
    // likely the table header + data rows.
    const meaningfulRows = rows.filter((r) => r.tokens.length >= 3);
    console.log(`\n=== ${meaningfulRows.length} rows with >=3 tokens ===`);
    for (const r of meaningfulRows.slice(0, 30)) {
        console.log(`y=${String(r.y).padStart(7)}  | ` + r.tokens.map(t => `[${t.x}:${JSON.stringify(t.str)}]`).join(' '));
    }
})();
