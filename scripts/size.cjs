// Prints raw, gzip and brotli sizes of the built bundles; run after `npm run build`.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'dist/cdn')).filter((f) => f.endsWith('.js')).map((f) => `dist/cdn/${f}`),
  'dist/esm/index.js',
];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file));
  const gzip = zlib.gzipSync(source, { level: 9 }).length;
  const brotli = zlib.brotliCompressSync(source).length;
  console.log(`${file.padEnd(32)} ${kb(source.length).padStart(9)} raw ${kb(gzip).padStart(9)} gzip ${kb(brotli).padStart(9)} brotli`);
}
