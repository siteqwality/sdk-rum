// Builds the SDK at the repo root before a run, unless another build is under test.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.env.SQ_SDK_DIR || process.env.SQ_SKIP_BUILD === '1') {
  console.log(`[fixtures] testing ${process.env.SQ_SDK_DIR || 'the existing build'} without rebuilding`);
} else {
  console.log('[fixtures] building the SDK (npm run build at the repo root)');
  execSync('npm run build --silent', { cwd: root, stdio: 'inherit' });
}
