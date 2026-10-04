import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import alias from '@rollup/plugin-alias';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const cdnRecordLoader = fileURLToPath(new URL('./src/replay/load-record.cdn.ts', import.meta.url));

const shared = {
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json', declaration: false }),
  ],
};

const cdnPlugins = (extra = []) => [
  ...extra,
  resolve({ browser: true }),
  commonjs(),
  typescript({ tsconfig: './tsconfig.json', declaration: false, outDir: 'dist/cdn' }),
  terser(),
];

export default [
  // ESM (npm; @rrweb/record and web-vitals are dependencies)
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/esm/index.js',
      format: 'esm',
      sourcemap: true,
    },
    external: ['web-vitals', '@rrweb/record'],
    ...shared,
  },
  // CJS (npm; @rrweb/record and web-vitals are dependencies)
  {
    input: 'src/index.ts',
    output: {
      // .cjs, because package.json says "type": "module" and Node would
      // otherwise load this CommonJS file as an ES module and export nothing.
      file: 'dist/cjs/index.cjs',
      format: 'cjs',
      sourcemap: true,
    },
    external: ['web-vitals', '@rrweb/record'],
    ...shared,
  },
  // CDN core: one global, classic or module. The alias swaps in a loader that
  // imports the recorder file below by URL, so rrweb stays out of the core.
  {
    input: 'src/cdn.ts',
    output: {
      file: 'dist/cdn/sdk.min.js',
      format: 'iife',
      sourcemap: true,
    },
    plugins: cdnPlugins([
      alias({ entries: [{ find: /^\.\/load-record$/, replacement: cdnRecordLoader }] }),
    ]),
  },
  // CDN recorder: an ES module exporting rrweb's record(), versioned so a
  // cached core always finds its own recorder.
  {
    input: 'src/replay/rrweb-entry.ts',
    output: {
      file: `dist/cdn/recorder-${version}.min.js`,
      format: 'es',
      sourcemap: true,
    },
    plugins: cdnPlugins(),
  },
];
