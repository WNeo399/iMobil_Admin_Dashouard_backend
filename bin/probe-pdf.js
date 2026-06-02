// One-off probe for the BuzzTech PO parser — dumps the line list pdf-parse
// produces so we can see what header marker the file actually contains.
const fs = require('fs');
const pdfParse = require('pdf-parse');

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: node bin/probe-pdf.js <path-to-pdf>');
  process.exit(1);
}

(async () => {
  const buf = fs.readFileSync(pdfPath);
  const result = await pdfParse(buf);
  const lines = result.text.split('\n').map(l => l.trim()).filter(Boolean);
  console.log('Total non-empty lines:', lines.length);
  console.log('\n=== First 200 lines ===');
  for (let i = 0; i < Math.min(200, lines.length); i++) {
    console.log(`${String(i).padStart(3)} | ${JSON.stringify(lines[i])}`);
  }
})();
