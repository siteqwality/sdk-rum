#!/usr/bin/env node
// Supply chain gate: fails when a locked dependency was published under --days (7) days ago.
// Usage: node check-dep-age.mjs [--days N] [lockfile ...]. Canonical copy: core-rs/scripts.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DAY_MS = 86_400_000;
const LOCKFILE =
  /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.mod|\.terraform\.lock\.hcl|requirements.*\.txt)$/;
const SKIP_PATH = /(^|\/)(node_modules|vendor|\.core-rs)\//;
const NPM_TARBALL =
  /^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/((?:@[^/]+\/)?[^/]+)\/-\/[^/]+\.tgz$/;
const CRATES_IO = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
]);
const HEADERS = { 'user-agent': 'siteqwality-dep-age-check (https://github.com/siteqwality)' };

function parseArgs(argv) {
  let days = 7;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]);
    else if (argv[i].startsWith('-')) fail(`unknown option ${argv[i]}`);
    else files.push(argv[i]);
  }
  if (!Number.isFinite(days) || days < 0) fail('--days needs a non-negative number');
  return { days, files };
}

function fail(message) {
  console.error(`dep-age: ${message}`);
  process.exit(2);
}

function trackedLockfiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch {
    fail('not in a git checkout; pass the lockfiles to check');
  }
  return out.split('\0').filter((f) => f && LOCKFILE.test(basename(f)) && !SKIP_PATH.test(f));
}

function npmEntry(file, name, version, resolved) {
  if (!resolved) {
    return /^\d/.test(version ?? '')
      ? { eco: 'npm', name, version, file }
      : { file, name, version, bad: `${name}@${version} is not a registry version` };
  }
  const m = NPM_TARBALL.exec(resolved.split('#')[0]);
  if (!m) return { file, name, version, bad: `${name}@${version} comes from ${resolved}` };
  return { eco: 'npm', name: decodeURIComponent(m[1]), version, file };
}

function parsePackageLock(file, text) {
  const lock = JSON.parse(text);
  const out = [];
  if (lock.packages) {
    for (const [path, p] of Object.entries(lock.packages)) {
      // Workspace links have no tarball; bundled packages ship inside their parent's.
      if (!path.includes('node_modules/') || p.link || p.inBundle) continue;
      const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push(npmEntry(file, name, p.version, p.resolved));
    }
    return out;
  }
  const walk = (deps) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (!d.bundled) out.push(npmEntry(file, name, d.version, d.resolved));
      walk(d.dependencies);
    }
  };
  walk(lock.dependencies);
  return out;
}

function parseYarnLock(file, text) {
  if (/^__metadata:/m.test(text)) throw new Error('Yarn Berry lockfiles are not supported');
  const out = [];
  for (const block of text.split(/\n(?=[^\s#])/)) {
    const name = /^"?(@?[^@\s"]+)@/.exec(block)?.[1];
    const version = /^\s+version "([^"]+)"/m.exec(block)?.[1];
    if (name && version)
      out.push(npmEntry(file, name, version, /^\s+resolved "([^"]+)"/m.exec(block)?.[1]));
  }
  return out;
}

function tomlBlocks(text, header) {
  return text
    .split(/^\[metadata\]/m)[0]
    .split(header)
    .slice(1)
    .map((block) => {
      const get = (key) => new RegExp(`^${key} = "([^"]*)"`, 'm').exec(block)?.[1];
      return { block, name: get('name'), version: get('version'), source: get('source') };
    });
}

function parseCargoLock(file, text) {
  return tomlBlocks(text, '[[package]]')
    .filter(({ source }) => source) // path and workspace crates have no source
    .map(({ name, version, source }) =>
      CRATES_IO.has(source)
        ? { eco: 'crates', name, version, file }
        : { file, name, version, bad: `${name}@${version} comes from ${source}` },
    );
}

function parsePoetryLock(file, text) {
  return tomlBlocks(text, '[[package]]').map(({ block, name, version }) => {
    const source = /^\[package\.source\]\s*\ntype = "([^"]+)"/m.exec(block)?.[1];
    if (source)
      return { file, name, version, bad: `${name}@${version} comes from a ${source} source` };
    return {
      eco: 'pypi',
      name,
      version,
      file,
      files: [...block.matchAll(/\{file = "([^"]+)"/g)].map((m) => m[1]),
    };
  });
}

function parseRequirements(file, text) {
  const out = [];
  for (const raw of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;]+)/.exec(line);
    out.push(
      m
        ? { eco: 'pypi', name: m[1], version: m[2], file }
        : { file, name: line, bad: `"${line}" is not pinned with ==` },
    );
  }
  return out;
}

function parseGoMod(file, text) {
  const body = text.replace(/\/\/.*$/gm, '');
  if (/^replace\b/m.test(body)) throw new Error('replace directives are not supported');
  const lines = [
    ...[...body.matchAll(/^require\s*\(([^)]*)\)/gm)].flatMap((m) => m[1].split('\n')),
    ...[...body.matchAll(/^require\s+([^\s(].*)$/gm)].map((m) => m[1]),
  ];
  return lines
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, version]) => name && version)
    .map(([name, version]) => ({ eco: 'go', name, version, file }));
}

function parseTerraformLock(file, text) {
  return [...text.matchAll(/^provider "([^"]+)" \{[^}]*?^\s*version\s*=\s*"([^"]+)"/gms)].map(
    ([, addr, version]) => {
      const [host, ...path] = addr.split('/');
      return host === 'registry.terraform.io' && path.length === 2
        ? { eco: 'terraform', name: path.join('/'), version, file }
        : { file, name: addr, version, bad: `provider ${addr} is not on registry.terraform.io` };
    },
  );
}

export function parseText(file, text) {
  const name = basename(file);
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json')
    return parsePackageLock(file, text);
  if (name === 'yarn.lock') return parseYarnLock(file, text);
  if (name === 'Cargo.lock') return parseCargoLock(file, text);
  if (name === 'poetry.lock') return parsePoetryLock(file, text);
  if (name === 'go.mod') return parseGoMod(file, text);
  if (name === '.terraform.lock.hcl') return parseTerraformLock(file, text);
  if (/^requirements.*\.txt$/.test(name)) return parseRequirements(file, text);
  throw new Error('not a lockfile this check reads');
}

function parseLockfile(file) {
  try {
    return parseText(file, readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${file}: ${err.message}`);
  }
}

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    let status;
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      status = res.status;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err.message}`);
    }
    if (status && (attempt >= 3 || (status < 500 && status !== 429)))
      throw new Error(`${url}: HTTP ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

const memo = new Map();
const once = (key, load) => memo.get(key) ?? memo.set(key, load()).get(key);
const getJson = async (url) => JSON.parse(await get(url));

export function crateIndexPath(name) {
  const n = name.toLowerCase();
  if (n.length <= 2) return `${n.length}/${n}`;
  if (n.length === 3) return `3/${n[0]}/${n}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
}

export const goEscape = (s) => s.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

// Each returns the version's publish time from its registry.
const publishedAt = {
  async npm({ name, version }) {
    const doc = await once(`npm:${name}`, () =>
      getJson(`https://registry.npmjs.org/${name.replace('/', '%2f')}`),
    );
    return doc.time?.[version];
  },
  async crates({ name, version }) {
    const index = await once(`crates:${name}`, async () =>
      (await get(`https://index.crates.io/${crateIndexPath(name)}`))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    );
    const entry = index.find((v) => v.vers === version);
    if (entry?.pubtime) return entry.pubtime;
    return (await getJson(`https://crates.io/api/v1/crates/${name}/${version}`)).version
      ?.created_at;
  },
  async pypi({ name, version, files }) {
    // Files can be added to an old release, so the newest upload counts.
    const { urls } = await getJson(`https://pypi.org/pypi/${name}/${version}/json`);
    const locked = urls.filter((u) => files?.includes(u.filename));
    return (locked.length ? locked : urls)
      .map((u) => u.upload_time_iso_8601)
      .sort()
      .at(-1);
  },
  async go({ name, version }) {
    return (
      await getJson(`https://proxy.golang.org/${goEscape(name)}/@v/${goEscape(version)}.info`)
    ).Time;
  },
  async terraform({ name, version }) {
    return (await getJson(`https://registry.terraform.io/v1/providers/${name}/${version}`))
      .published_at;
  },
};

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function readAllowList() {
  if (!existsSync('.dep-age-allow')) return new Set();
  return new Set(
    readFileSync('.dep-age-allow', 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean),
  );
}

const day = (date) => date.toISOString().slice(0, 10);
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  if (typeof fetch !== 'function') fail('needs Node 18 or newer');
  const { days, files } = parseArgs(process.argv.slice(2));
  const lockfiles = files.length ? files : trackedLockfiles();
  if (!lockfiles.length) {
    console.log('dep-age: no lockfiles to check');
    return;
  }

  const allow = readAllowList();
  const used = new Set();
  const isAllowed = (e) => {
    const key = `${e.name}@${e.version}`;
    if (allow.has(key)) used.add(key);
    return allow.has(key);
  };

  const entries = lockfiles.flatMap(parseLockfile);
  const unverifiable = entries.filter((e) => e.bad && !isAllowed(e));
  const unique = [
    ...new Map(
      entries.filter((e) => !e.bad).map((e) => [`${e.eco}:${e.name}@${e.version}`, e]),
    ).values(),
  ];

  const cutoff = Date.now() - days * DAY_MS;
  const checked = await mapLimit(unique, 16, async (e) => {
    try {
      const time = await publishedAt[e.eco](e);
      if (!time) return { ...e, error: 'the registry has no publish time for this version' };
      return { ...e, published: new Date(time) };
    } catch (err) {
      return { ...e, error: err.message };
    }
  });
  const tooNew = checked
    .filter((e) => e.published > cutoff && !isAllowed(e))
    .sort((a, b) => b.published - a.published);
  const errors = checked.filter((e) => e.error);

  for (const key of allow) {
    if (!used.has(key)) console.error(`dep-age: .dep-age-allow entry ${key} is no longer needed`);
  }
  if (!tooNew.length && !errors.length && !unverifiable.length) {
    console.log(
      `dep-age: ${unique.length} packages in ${lockfiles.length} lockfile(s), all published ${days}+ days ago`,
    );
    return;
  }

  if (tooNew.length) {
    console.error(
      `dep-age: ${tooNew.length} of ${unique.length} packages were published less than ${days} days ago:`,
    );
    for (const e of tooNew) {
      const clears = day(new Date(e.published.getTime() + days * DAY_MS));
      console.error(
        `  ${pad(e.eco, 9)} ${pad(`${e.name}@${e.version}`, 48)} published ${day(e.published)}, clears ${clears}  (${e.file})`,
      );
    }
  }
  if (unverifiable.length) {
    console.error(
      `dep-age: ${unverifiable.length} locked package(s) do not come from a public registry:`,
    );
    for (const e of unverifiable) console.error(`  ${e.bad}  (${e.file})`);
  }
  if (errors.length) {
    console.error(`dep-age: could not verify ${errors.length} package(s):`);
    for (const e of errors)
      console.error(
        `  ${pad(e.eco, 9)} ${pad(`${e.name}@${e.version}`, 48)} ${e.error}  (${e.file})`,
      );
  }
  console.error(
    'dep-age: pin an older version, wait it out, or add name@version to .dep-age-allow with a reason',
  );
  process.exit(1);
}

// Only the parser test sets this; any other import or invocation runs the gate.
if (!globalThis.depAgeParseOnly) await main();
