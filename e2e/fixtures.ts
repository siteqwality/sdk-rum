import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export const VERSION: string = JSON.parse(await readFile(join(import.meta.dirname, '../package.json'), 'utf8')).version;

const DIST = join(import.meta.dirname, '../dist/cdn');

export interface Batch {
  ctx: Record<string, unknown> & { session_id: string };
  events: Array<Record<string, unknown> & { k: string }>;
}

export interface Received {
  kind: 'batch' | 'segments' | 'config' | 'preflight';
  body: unknown;
  gzip: boolean;
  at: number;
  path: string;
}

/** A local intake and CDN: serves dist/cdn, config v2 and test pages, records every SDK request. */
export class Intake {
  readonly received: Received[] = [];
  readonly pages = new Map<string, string>();
  config: Record<string, unknown> = { v: 2, rules: [] };
  private server: Server;
  origin = '';
  crossOrigin = '';

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, type, body, headers }) => {
          res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
          res.end(body);
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    // The same server under another origin, to load the SDK cross-origin like the CDN.
    this.crossOrigin = `http://localhost:${port}`;
  }

  stop(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    return closed;
  }

  page(name: string, html: string): string {
    this.pages.set(name, html);
    return `${this.origin}/page/${name}`;
  }

  batches(): Batch[] {
    return this.received.filter((r) => r.kind === 'batch').map((r) => r.body as Batch);
  }

  /** Batch events of kind `k`, each with its ctx. */
  events<T = Record<string, unknown>>(k?: string): Array<T & { ctx: Batch['ctx'] }> {
    return this.batches().flatMap((b) => b.events.filter((e) => !k || e.k === k).map((e) => ({ ...e, ctx: b.ctx }))) as Array<T & { ctx: Batch['ctx'] }>;
  }

  segments<T = { session_id: string; segment_index: number; events: Array<{ type: number }> }>(): T[] {
    return this.received.filter((r) => r.kind === 'segments').map((r) => r.body as T);
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; type: string; body: string | Buffer; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? '/', this.origin);
    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, GET' };

    if (req.method === 'OPTIONS') {
      this.received.push({ kind: 'preflight', body: null, gzip: false, at: Date.now(), path: url.pathname });
      return { status: 204, type: 'text/plain', body: '', headers: cors };
    }
    // /sdk/ sends CORS headers as the CDN does; /sdk-nocors/ does not.
    const sdkPath = url.pathname.match(/^\/(sdk|sdk-nocors)\/(.+)$/);
    if (sdkPath) {
      const file = sdkPath[2];
      if (file.includes('..')) return { status: 404, type: 'text/plain', body: '' };
      try {
        return { status: 200, type: 'application/javascript', body: await readFile(join(DIST, file)), headers: sdkPath[1] === 'sdk' ? { 'access-control-allow-origin': '*' } : {} };
      } catch {
        return { status: 404, type: 'text/plain', body: '' };
      }
    }
    if (url.pathname.startsWith('/page/')) {
      const html = this.pages.get(url.pathname.slice('/page/'.length).split('/')[0]);
      return { status: html ? 200 : 404, type: 'text/html', body: html ?? '' };
    }
    if (url.pathname === '/slow.png') {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
      return { status: 200, type: 'image/png', body: png };
    }
    if (/^\/cdn\/rum\/config\/v2\/[^/]+\.json$/.test(url.pathname)) {
      this.received.push({ kind: 'config', body: null, gzip: false, at: Date.now(), path: url.pathname });
      return { status: 200, type: 'application/json', body: JSON.stringify(this.config), headers: { 'access-control-allow-origin': '*' } };
    }
    const kind = url.pathname === '/rum/v2/batch' ? 'batch' : url.pathname === '/replay/v1/segments' ? 'segments' : null;
    if (kind && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let raw = Buffer.concat(chunks);
      const gzip = raw[0] === 0x1f && raw[1] === 0x8b;
      if (gzip) raw = gunzipSync(raw);
      this.received.push({ kind, body: JSON.parse(raw.toString('utf8')), gzip, at: Date.now(), path: url.pathname });
      return { status: 202, type: 'application/json', body: '{}', headers: cors };
    }
    return { status: 404, type: 'text/plain', body: '' };
  }
}

export const test = base.extend<{ intake: Intake }>({
  intake: async ({}, use) => {
    const intake = new Intake();
    await intake.start();
    await use(intake);
    await intake.stop();
  },
});

export { expect };

const METHODS = ['init', 'setUser', 'clearUser', 'setGlobalAttribute', 'removeGlobalAttribute', 'addError', 'addAction', 'setView', 'setTrackingConsent', 'optOut', 'optIn', 'isOptedOut', 'startReplay', 'stopReplay', 'getSessionUrl', 'getStatus'];

/** The dashboard's install snippet for 2.0, loading the local build. */
export function snippet(intake: Intake, sdkUrl = '/sdk/sdk.min.js', initExtra = ''): string {
  const src = /^https?:/.test(sdkUrl) ? sdkUrl : `${intake.origin}${sdkUrl}`;
  return `<script>
  (function(w,d,s,u){var r=w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};if(r._q&&!r._h){
  ${JSON.stringify(METHODS)}.forEach(function(m){
    r[m]=function(){r._q.push([m,arguments])}});
  r._h=function(e){r._q.push(['_e',[e]])};w.addEventListener('error',r._h);
  w.addEventListener('unhandledrejection',r._h);
  var e=d.createElement(s);e.async=1;e.src=u;(d.head||d.documentElement).appendChild(e)}
  })(window,document,'script','${src}');

  SiteQwalityRUM.init({
    applicationId: 'app-1',
    clientToken: 'ct_test',
    ingestBase: location.origin + '/rum',
    replayBase: location.origin + '/replay',
    configBase: location.origin + '/cdn',
    ${initExtra}
  });
</script>`;
}

export async function sdkLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { SiteQwalityRUM?: { __sq?: boolean } }).SiteQwalityRUM?.__sq === true);
}

/** Hides the page, which makes the transport send what it holds. */
export async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}

export const REPLAY_ALL = { v: 2, rules: [{ id: 'r_all', capture: 'replay', sample_rate: 1, conditions: [], min_duration_ms: 0, require_interaction: false }] };
export const ANALYZE_ALL = { v: 2, rules: [{ id: 'r_an', capture: 'analyze', sample_rate: 1, conditions: [], min_duration_ms: 0, require_interaction: false }] };
