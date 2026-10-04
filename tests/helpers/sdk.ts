// Runs the real SDK in jsdom against a fake network that records what it sends.
import { vi } from 'vitest';
import { SiteQwalityRUM } from '../../src/sdk';
import type { InitOptions, SqEvent } from '../../src/types';

export const APP = '9a9a009c-0000-4000-8000-000000000001';

export interface Batch {
  url: string;
  headers: Record<string, string>;
  keepalive?: boolean;
  gzip: boolean;
  body: {
    v: number;
    sent_at: number;
    sdk: string;
    ctx: Record<string, unknown> & { session_id: string };
    events: Array<SqEvent & Record<string, unknown>>;
  };
}

export interface Net {
  fetch: ReturnType<typeof vi.fn>;
  configCalls: Array<{ url: string; init?: RequestInit }>;
  batches: Batch[];
  segments: Array<{ url: string; body: { session_id: string; segment_index: number; events: unknown[] } }>;
  app: Array<{ url: string; init?: RequestInit }>;
  /** Every event sent, with its batch ctx, optionally of one kind. */
  events(k?: string): Array<SqEvent & Record<string, unknown> & { ctx: Batch['body']['ctx'] }>;
  config: unknown;
  batchStatus: number;
  identity: boolean;
}

export function rule(capture: 'analyze' | 'replay', conditions: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { id: `r_${capture}_${conditions.length}`, capture, sample_rate: 1, conditions, min_duration_ms: 0, require_interaction: false, ...extra };
}

export function config(extra: Record<string, unknown> = {}) {
  return { v: 2, application_id: APP, revision: 7, status: 'active', observe: { sample_rate: 1 }, rules: [], ...extra };
}

async function decode(body: unknown): Promise<{ text: string; gzip: boolean }> {
  if (typeof body === 'string') return { text: body, gzip: false };
  const blob = body as Blob;
  const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return { text, gzip: true };
}

/** A fake fetch: config from `net.config` ('fail' answers 500, 'hang' never answers). */
export function stubNetwork(cfg: unknown = config()): Net {
  const net: Net = {
    configCalls: [],
    batches: [],
    segments: [],
    app: [],
    config: cfg,
    batchStatus: 202,
    identity: true,
    events(k) {
      return net.batches.flatMap((b) => b.body.events.filter((e) => !k || e.k === k).map((e) => ({ ...e, ctx: b.body.ctx })));
    },
    fetch: vi.fn(),
  };
  net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/rum/config/v2/')) {
      net.configCalls.push({ url, init });
      if (net.config === 'hang') return new Promise(() => {});
      if (net.config === 'fail') return new Response('', { status: 500 });
      return new Response(JSON.stringify(net.config), { status: 200 });
    }
    if (url.endsWith('/v2/batch')) {
      const { text, gzip } = await decode(init?.body);
      net.batches.push({ url, headers: init?.headers as Record<string, string>, keepalive: init?.keepalive, gzip, body: JSON.parse(text) });
      return new Response('', { status: net.batchStatus });
    }
    if (url.includes('/v2/identity')) return new Response(JSON.stringify({ record: net.identity }), { status: 200 });
    if (url.includes('/v1/segments')) {
      net.segments.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response('', { status: 202 });
    }
    net.app.push({ url, init });
    if (url.includes('/fail')) return new Response('{"ok":false}', { status: 500 });
    if (url.includes('/drop')) throw new TypeError('Failed to fetch');
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'rid-1' } });
  });
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

export function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

/** Hides the tab (everything queued is sent), lets the sends land, then shows it again. */
export async function flush(): Promise<void> {
  setVisibility('hidden');
  await settle();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
}

export function pagehide(persisted = false): void {
  const e = new Event('pagehide') as PageTransitionEvent;
  Object.defineProperty(e, 'persisted', { value: persisted });
  window.dispatchEvent(e);
}

export function clearStorage(): void {
  localStorage.clear();
  sessionStorage.clear();
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=;path=/;max-age=0`;
  }
}

/** A fresh page load: forgets the instance (storage survives unless cleared). */
export async function boot(options: Partial<InitOptions> = {}, net: Net = stubNetwork()): Promise<Net> {
  SiteQwalityRUM._reset();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  await SiteQwalityRUM.init({
    applicationId: APP,
    clientToken: 'ct_1',
    ingestBase: 'https://in.test',
    replayBase: 'https://rp.test',
    configBase: 'https://cdn.test',
    ...options,
  });
  await settle(2);
  return net;
}

export function el<T extends Element = HTMLElement>(html: string): T {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  const node = host.firstElementChild as T;
  document.body.appendChild(node);
  return node;
}

export function click(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }));
}

export function throwInPage(error: unknown, init: Partial<ErrorEventInit> = {}): void {
  const message = error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : `Uncaught ${String(error)}`;
  window.dispatchEvent(new ErrorEvent('error', { message, error, ...init }));
}
