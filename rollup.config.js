import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import alias from '@rollup/plugin-alias';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const cdnReplayLoader = fileURLToPath(new URL('./src/replay/load-record.cdn.ts', import.meta.url));

// npm: rrweb is a dependency; the replay chunk stays a separate lazy file.
const npm = (format, dir, ext) => ({
  input: 'src/index.ts',
  output: {
    dir,
    format,
    entryFileNames: `index.${ext}`,
    chunkFileNames: `[name].${ext}`,
    manualChunks: (id) => (/\/src\/replay\/(?!load-record)/.test(id) ? 'replay' : 'core'),
    sourcemap: true,
  },
  external: ['@rrweb/record'],
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json', declaration: false, outDir: dir }),
  ],
});

const cdnPlugins = (extra = []) => [
  ...extra,
  resolve({ browser: true }),
  commonjs(),
  typescript({ tsconfig: './tsconfig.json', declaration: false, outDir: 'dist/cdn' }),
  terser({ ecma: 2020, compress: { passes: 3 } }),
];

export default [
  npm('esm', 'dist/esm', 'js'),
  // .cjs, because package.json says "type": "module".
  npm('cjs', 'dist/cjs', 'cjs'),
  // CDN core: one global, classic or module. The alias swaps in a loader that imports the
  // replay chunk below by URL, so rrweb stays out of the core.
  {
    input: 'src/cdn.ts',
    output: { file: 'dist/cdn/sdk.min.js', format: 'iife', sourcemap: true },
    plugins: cdnPlugins([alias({ entries: [{ find: /^\.\/replay\/load-record$/, replacement: cdnReplayLoader }] })]),
  },
  // CDN replay chunk: an ES module exporting startReplay, versioned so a cached core always
  // finds its own chunk.
  {
    input: 'src/replay/chunk.ts',
    output: { file: `dist/cdn/recorder-${version}.min.js`, format: 'es', sourcemap: true },
    plugins: cdnPlugins(),
  },
];
