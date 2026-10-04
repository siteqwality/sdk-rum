// Sizes of the built bundles (run after `npm run build`), the budget gate, and a per-module report
// of the CDN core. Exits 1 when a bundle is over its budget.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(fs.readFileSync(path.join(root, 'scripts/size-budgets.json'), 'utf8'));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const gzip = (b) => zlib.gzipSync(b, { level: 9 }).length;

const cdn = path.join(root, 'dist/cdn');
const files = [
  ...fs.readdirSync(cdn).filter((f) => f.endsWith('.js')).map((f) => `dist/cdn/${f}`),
  ...fs.readdirSync(path.join(root, 'dist/esm')).filter((f) => f.endsWith('.js')).map((f) => `dist/esm/${f}`),
];
let failed = false;
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file));
  const gz = gzip(source);
  const budget = file === 'dist/cdn/sdk.min.js' ? budgets.core : /dist\/cdn\/recorder-/.test(file) ? budgets.replay : /dist\/cdn\/gzip-/.test(file) ? budgets.gzip : /dist\/cdn\/canvas-/.test(file) ? budgets.canvas : undefined;
  const over = budget !== undefined && gz > budget;
  failed ||= over;
  const gate = budget === undefined ? '' : `${over ? 'OVER' : 'ok'} (budget ${kb(budget)})`;
  console.log(`${file.padEnd(34)} ${kb(source.length).padStart(9)} raw ${kb(gz).padStart(9)} gzip ${kb(zlib.brotliCompressSync(source).length).padStart(9)} brotli  ${gate}`);
}

// Per-module view of the core: each module minified and gzipped alone (an upper bound; the
// bundle compresses better as a whole).
if (process.argv.includes('--modules')) {
  const { rollup } = await import('rollup');
  const { default: typescript } = await import('@rollup/plugin-typescript');
  const { default: resolve } = await import('@rollup/plugin-node-resolve');
  const { default: alias } = await import('@rollup/plugin-alias');
  const { minify } = await import('terser');
  const loader = path.join(root, 'src/replay/load-record.cdn.ts');
  const bundle = await rollup({
    input: path.join(root, 'src/cdn.ts'),
    onwarn() {},
    plugins: [alias({ entries: [{ find: /^\.\/replay\/load-record$/, replacement: loader }] }), resolve({ browser: true }), typescript({ tsconfig: path.join(root, 'tsconfig.json'), declaration: false, outDir: 'dist/cdn' })],
  });
  const { output } = await bundle.generate({ format: 'iife' });
  const rows = [];
  for (const [id, m] of Object.entries(output[0].modules)) {
    if (!m.code) continue;
    const code = (await minify(m.code, { compress: { toplevel: false }, mangle: true })).code ?? '';
    rows.push([path.relative(root, id), gzip(code)]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  for (const [file, gz] of rows) console.log(`  ${kb(gz).padStart(8)}  ${file}`);
}

if (failed) {
  console.error('A bundle is over its gzip budget (scripts/size-budgets.json).');
  process.exit(1);
}
