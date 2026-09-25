import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

const shared = {
  plugins: [
    resolve({ browser: true }),
    commonjs(),
    typescript({ tsconfig: './tsconfig.json', declaration: false }),
  ],
};

export default [
  // ESM (npm; rrweb and web-vitals are peer deps)
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/esm/index.js',
      format: 'esm',
      sourcemap: true,
    },
    external: ['web-vitals', 'rrweb'],
    ...shared,
  },
  // CJS (npm; rrweb and web-vitals are peer deps)
  {
    input: 'src/index.ts',
    output: {
      // .cjs, because package.json says "type": "module" and Node would
      // otherwise load this CommonJS file as an ES module and export nothing.
      file: 'dist/cjs/index.cjs',
      format: 'cjs',
      sourcemap: true,
    },
    external: ['web-vitals', 'rrweb'],
    ...shared,
  },
  // CDN bundle (ES module with code splitting, so rrweb is lazy-loaded)
  //
  // Outputs:
  //   dist/cdn/sdk.min.js     core SDK (< 30KB gzipped, no rrweb)
  //   dist/cdn/rrweb-*.js     rrweb chunk (loaded on demand when replay activates)
  //
  // Usage: <script type="module" src="https://cdn.siteqwality.com/rum/v1/sdk.min.js"></script>
  {
    input: 'src/cdn.ts',
    output: {
      dir: 'dist/cdn',
      format: 'es',
      sourcemap: true,
      entryFileNames: 'sdk.min.js',
      chunkFileNames: '[name]-[hash].js',
      manualChunks(id) {
        if (id.includes('rrweb')) {
          return 'rrweb';
        }
      },
    },
    plugins: [
      resolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: './tsconfig.json', declaration: false, outDir: 'dist/cdn' }),
      terser(),
    ],
  },
];
