// Which SDK build is under test, and the knobs a run can turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = path.resolve(here, '../..');
export const SDK_DIR = path.resolve(process.env.SQ_SDK_DIR || path.join(FIXTURES_ROOT, '../dist/cdn'));

function sdkVersion() {
  if (process.env.SQ_SDK_VERSION) return process.env.SQ_SDK_VERSION;
  // dist/cdn sits two levels under the package root.
  const pkg = path.resolve(SDK_DIR, '../../package.json');
  if (fs.existsSync(pkg)) return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  throw new Error(`Cannot tell the SDK version of ${SDK_DIR}: set SQ_SDK_VERSION`);
}

const parse = (v) => v.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);

function atLeast(version, min) {
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// The oldest SDK the harness tests: 2.0 replay went to an intake that no longer exists.
const MIN_VERSION = '2.1.0';
const version = sdkVersion();
if (!atLeast(version, MIN_VERSION)) throw new Error(`SDK ${version} is older than ${MIN_VERSION}, the oldest the harness tests`);

export const SDK = { dir: SDK_DIR, version };

export const LOADER = process.env.SQ_LOADER || 'classic';
export const SDK_PATH = '/rum/v2/sdk.min.js';

// Seconds of scripted activity behind the per-minute replay numbers.
export const ACTIVE_SECONDS = Number(process.env.SQ_ACTIVE_SECONDS || 60);
// Opt-in tests that wait for a 60 s checkout.
export const SLOW = process.env.SQ_SLOW === '1';
