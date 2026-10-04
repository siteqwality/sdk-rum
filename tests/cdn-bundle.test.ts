import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import vm from 'node:vm';
import { parse, type Node } from 'acorn';

/**
 * Checks on the built CDN core (`npm run build` first). Set SDK_BUNDLE_URL to
 * run the same checks against a deployed file instead, e.g. after `make deploy`.
 */

const LIVE_URL = process.env.SDK_BUNDLE_URL;
const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const budgets = JSON.parse(readFileSync(join(ROOT, 'scripts/size-budgets.json'), 'utf8')) as { core: number; replay: number };

let source = '';
let bundlePath = '';

beforeAll(async () => {
  if (LIVE_URL) {
    const res = await fetch(LIVE_URL);
    expect(res.ok, `${LIVE_URL} answered ${res.status}`).toBe(true);
    source = await res.text();
    bundlePath = join(mkdtempSync(join(tmpdir(), 'sq-rum-')), 'sdk.min.js');
    writeFileSync(bundlePath, source);
  } else {
    bundlePath = join(ROOT, 'dist/cdn/sdk.min.js');
    source = readFileSync(bundlePath, 'utf8');
  }
});

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === 'string') visit(n);
  for (const value of Object.values(n)) {
    if (value && typeof value === 'object') walk(value, visit);
  }
}

/** A page's globals before the SDK: window, a document stub, jQuery and lodash. */
function hostContext() {
  const jquery = function jQuery() {};
  const lodash = { map: () => [] };
  const sandbox: Record<string, unknown> = {
    document: { currentScript: null },
    $: jquery,
    _: lodash,
  };
  sandbox.window = sandbox;
  return { context: vm.createContext(sandbox), jquery, lodash };
}

describe('CDN core as a classic script', () => {
  it('declares nothing at the top level', () => {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const declarations = ast.body.filter((n) => /Declaration$/.test(n.type));
    expect(declarations.map((n) => n.type)).toEqual([]);
  });

  it('adds only window.SiteQwalityRUM and leaves $ and _ alone', () => {
    const { context, jquery, lodash } = hostContext();
    const before = new Set(Object.getOwnPropertyNames(context));
    vm.runInContext(source, context);
    const added = Object.getOwnPropertyNames(context).filter((k) => !before.has(k));
    expect(added).toEqual(['SiteQwalityRUM']);
    expect(context.$).toBe(jquery);
    expect(context._).toBe(lodash);
    expect(typeof (context.SiteQwalityRUM as { init?: unknown }).init).toBe('function');
  });

  it('lets later host scripts declare any name', () => {
    const { context } = hostContext();
    vm.runInContext(source, context);
    expect(() => vm.runInContext('var t=1; let e=2; function _(){}', context)).not.toThrow();
  });

  it('does nothing when loaded twice', () => {
    const { context } = hostContext();
    vm.runInContext(source, context);
    const first = context.SiteQwalityRUM;
    vm.runInContext(source, context);
    expect(context.SiteQwalityRUM).toBe(first);
  });
});

describe('CDN core as a module', () => {
  it('parses as module source', () => {
    expect(() => parse(source, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
  });

  it('evaluates as a module and adds only window.SiteQwalityRUM', () => {
    const helper = join(__dirname, 'helpers/eval-module.mjs');
    const out = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', helper, bundlePath], {
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual({ added: ['SiteQwalityRUM'], hasInit: true, jqueryKept: true });
  });
});

describe('CDN core contents', () => {
  it('never names @rrweb/record and loads the recorder with a native import()', () => {
    expect(source).not.toContain('@rrweb/record');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    let imports = 0;
    walk(ast, (n) => {
      if (n.type === 'ImportExpression') imports++;
    });
    expect(imports).toBe(1);
  });

  it(`stays within ${(budgets.core / 1024).toFixed(1)} KB gzipped`, () => {
    const gzip = gzipSync(source, { level: 9 }).length;
    console.log(`sdk.min.js: ${source.length} B raw, ${gzip} B gzip`);
    expect(gzip).toBeLessThanOrEqual(budgets.core);
  });

  it('names the v2 CDN path and the v2 ingest endpoint, and no v1 intake route', () => {
    expect(source).toContain('https://cdn.siteqwality.com/rum/v2/');
    expect(source).toContain('/v2/batch');
    expect(source).not.toMatch(/\/v1\/(measure|events|errors|config)/);
  });
});

describe.skipIf(!!LIVE_URL)('CDN replay chunk', () => {
  it(`is recorder-${pkg.version}.min.js, an ES module exporting startReplay, within budget`, () => {
    const recorder = readFileSync(join(ROOT, `dist/cdn/recorder-${pkg.version}.min.js`), 'utf8');
    const ast = parse(recorder, { ecmaVersion: 'latest', sourceType: 'module' });
    const exported: string[] = [];
    walk(ast, (n) => {
      if (n.type === 'ExportSpecifier') {
        const name = (n as unknown as { exported: { name?: string; value?: string } }).exported;
        exported.push(name.name ?? String(name.value));
      }
    });
    expect(exported).toEqual(['startReplay']);
    const gzip = gzipSync(recorder, { level: 9 }).length;
    console.log(`recorder-${pkg.version}.min.js: ${recorder.length} B raw, ${gzip} B gzip`);
    expect(gzip).toBeLessThanOrEqual(budgets.replay);
  });
});
