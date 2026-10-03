import { vi } from 'vitest';
import { SiteQwalityRUM } from '../../src/init';
import type {
  RumDetailEvent,
  RumErrorEvent,
  RumMeasureEvent,
  SessionFilterRule,
} from '../../src/types';

// Helpers for tests that run the real init() in jsdom; each file mocks
// ../src/transport with a class that records into a Registry.

export interface FakeTransport {
  endpoint: string;
  events: unknown[];
}

export type Registry = FakeTransport[];

/** The events the latest transport for `/v1/<kind>` received. */
export function sent<T = unknown>(registry: Registry, kind: 'measure' | 'events' | 'errors'): T[] {
  const transport = [...registry].reverse().find((t) => t.endpoint.endsWith(`/v1/${kind}`));
  return (transport?.events ?? []) as T[];
}

export const measures = (r: Registry) => sent<RumMeasureEvent>(r, 'measure');
export const details = (r: Registry) => sent<RumDetailEvent>(r, 'events');
export const errors = (r: Registry) => sent<RumErrorEvent>(r, 'errors');

export function configBody(
  filters: Partial<SessionFilterRule>[] = [],
  settings: Record<string, unknown> = {},
) {
  return {
    data: {
      application_id: 'app-1',
      filters: filters.map((f) => ({ filter_type: 'custom', conditions: {}, capture_replay: false, ...f })),
      settings: { privacy: { mask_inputs: true, mask_text: false }, ...settings },
    },
  };
}

export function configResponse(
  filters: Partial<SessionFilterRule>[] = [],
  settings: Record<string, unknown> = {},
): Response {
  return { ok: true, status: 200, json: async () => configBody(filters, settings) } as Response;
}

/** A config fetch that answers with these rules. */
export function serveConfig(
  filters: Partial<SessionFilterRule>[] = [],
  settings: Record<string, unknown> = {},
) {
  const fetchMock = vi.fn().mockResolvedValue(configResponse(filters, settings));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A config fetch that never settles; returns the function that settles it. */
export function holdConfig(
  filters: Partial<SessionFilterRule>[] = [],
  settings: Record<string, unknown> = {},
): () => void {
  let release: (r: Response) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
  );
  return () => release(configResponse(filters, settings));
}

export const MATCH_ALL = { filter_type: 'custom', conditions: {}, capture_replay: false };
export const MATCH_ALL_REPLAY = { ...MATCH_ALL, capture_replay: true };
export const ERROR_RULE = { filter_type: 'error', conditions: {}, capture_replay: true };

export function init(extra: Record<string, unknown> = {}): Promise<void> {
  return SiteQwalityRUM.init({ applicationId: 'app-1', clientToken: 'ct_1', ...extra });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function instance(): any {
  return (SiteQwalityRUM as unknown as { instance: unknown }).instance;
}

/** A new page load in the same tab: sessionStorage survives, the instance does not. */
export function newPageLoad(): void {
  (SiteQwalityRUM as unknown as { instance: unknown }).instance = null;
  (SiteQwalityRUM as unknown as { earlyErrors: unknown[] }).earlyErrors = [];
}

export function resetSdk(): void {
  newPageLoad();
  sessionStorage.clear();
}

/** Lets the config promise chain settle under fake timers. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

export function click(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
}

export function el<T extends Element = HTMLElement>(html: string): T {
  const host = document.createElement('div');
  host.innerHTML = html.trim();
  const node = host.firstElementChild as T;
  document.body.appendChild(node);
  return node;
}

export function throwInPage(error: unknown, init: Partial<ErrorEventInit> = {}): void {
  const message = error instanceof Error ? `Uncaught ${error.name}: ${error.message}` : String(error);
  window.dispatchEvent(new ErrorEvent('error', { message, error, ...init }));
}
