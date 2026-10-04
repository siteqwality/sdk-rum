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

const version = sdkVersion();

export const SDK = {
  dir: SDK_DIR,
  version,
  atLeast: (min) => atLeast(version, min),
  // Wave 1 (1.1.0): IIFE CDN core, noise rules, burst limit, early-error stub, methods never throw.
  wave1: atLeast(version, '1.1.0'),
  // SDK 2.0 core (WP 1.1): batch v2, config from the CDN, privacy levels, network and console.
  v2: atLeast(version, '2.0.0'),
  // Replay chunk v2 (WP 2.1): segments v2, gzip, the replay ring, mutation throttle, CSS references.
  replayV2: atLeast(version, '2.1.0'),
};

// 1.0.x is an ES module that only records replay when loaded as type=module (see README).
export const LOADER = process.env.SQ_LOADER || (SDK.wave1 ? 'classic' : 'module');
export const SDK_PATH = SDK.v2 ? '/rum/v2/sdk.min.js' : '/rum/v1/sdk.min.js';

// Seconds of scripted activity behind the per-minute replay numbers.
export const ACTIVE_SECONDS = Number(process.env.SQ_ACTIVE_SECONDS || 60);
// Opt-in tests that wait for a 60 s checkout.
export const SLOW = process.env.SQ_SLOW === '1';

// SQ_STRICT=1 runs known gaps as ordinary assertions, to see exactly how they fail.
export const STRICT = process.env.SQ_STRICT === '1';
