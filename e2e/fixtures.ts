import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

export const VERSION: string = JSON.parse(
  await readFile(join(import.meta.dirname, '../package.json'), 'utf8'),
).version;

const DIST = join(import.meta.dirname, '../dist/cdn');

export interface Received {
  kind: 'measure' | 'events' | 'errors' | 'segments';
  body: unknown;
  at: number;
}

/** A local intake: serves dist/cdn and test pages, records every SDK request. */
export class Intake {
  readonly received: Received[] = [];
  readonly pages = new Map<string, string>();
  config: unknown = { filters: [], settings: { privacy: { mask_inputs: true, mask_text: false } } };
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
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  page(name: string, html: string): string {
    this.pages.set(name, html);
    return `${this.origin}/page/${name}`;
  }

  of<T = Record<string, unknown>>(kind: Received['kind']): T[] {
    return this.received
      .filter((r) => r.kind === kind)
      .flatMap((r) => (Array.isArray(r.body) ? r.body : [r.body])) as T[];
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; type: string; body: string | Buffer; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? '/', this.origin);
    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    // /sdk/ sends CORS headers as the CDN does; /sdk-nocors/ does not.
    const sdkPath = url.pathname.match(/^\/(sdk|sdk-nocors)\/(.+)$/);
    if (sdkPath) {
      const file = sdkPath[2];
      if (file.includes('..')) return { status: 404, type: 'text/plain', body: '' };
      const headers: Record<string, string> =
        sdkPath[1] === 'sdk' ? { 'access-control-allow-origin': '*' } : {};
      try {
        const body = await readFile(join(DIST, file));
        return { status: 200, type: 'application/javascript', body, headers };
      } catch {
        return { status: 404, type: 'text/plain', body: '' };
      }
    }
    if (url.pathname.startsWith('/page/')) {
      const html = this.pages.get(url.pathname.slice('/page/'.length).split('/')[0]);
      return { status: html ? 200 : 404, type: 'text/html', body: html ?? '', headers: {} };
    }
    if (url.pathname === '/slow.png') {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      );
      return { status: 200, type: 'image/png', body: png };
    }
    if (url.pathname === '/rum/v1/config') {
      return { status: 200, type: 'application/json', body: JSON.stringify({ data: { application_id: 'app-1', ...(this.config as object) } }) };
    }
    const kind = url.pathname.match(/^\/(?:rum|replay)\/v1\/(measure|events|errors|segments)$/)?.[1];
    if (kind && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      this.received.push({ kind: kind as Received['kind'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')), at: Date.now() });
      return { status: 202, type: 'application/json', body: '{}' };
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

/** The dashboard's install snippet, loading the local build. */
export function snippet(intake: Intake, sdkUrl = '/sdk/sdk.min.js', initExtra = ''): string {
  const src = /^https?:/.test(sdkUrl) ? sdkUrl : `${intake.origin}${sdkUrl}`;
  return `<script>
  (function(w,d,s,u){var r=w.SiteQwalityRUM=w.SiteQwalityRUM||{_q:[]};if(r._q&&!r._h){
  ['init','setUser','setGlobalAttribute','removeGlobalAttribute','addError','addAction'].forEach(function(m){
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
    ${initExtra}
  });
</script>`;
}

export async function sdkLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { SiteQwalityRUM?: { __sq?: boolean } }).SiteQwalityRUM?.__sq === true);
}

/** Hides the page, which makes every transport send what it holds. */
export async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}
