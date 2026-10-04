// One POST to the intake and what became of it. Retry rules are those of 1.x: 429, 408, 5xx
// and network errors retry with backoff; 401 and 403 stop; any other 4xx drops the body.

import { now } from './util';
import { BUDGET } from './budget';

/** Browsers cap keepalive bodies in flight at 64 KiB per page; this leaves headroom. */
export const KEEPALIVE_MAX_BYTES = 60_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** Longest Retry-After honoured. */
export const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'retryable'; retryAfterMs?: number }
  | { kind: 'permanent'; status: number };

/** Refused by the request budget: status 0, never retried. */
const overBudget = (err: unknown): SendOutcome => ((err as Error | null)?.name === BUDGET ? { kind: 'permanent', status: 0 } : { kind: 'retryable' });

let keepaliveInFlight = 0;

/** Whether `bytes` more can go with keepalive now. */
export const keepaliveFits = (bytes: number): boolean => bytes + keepaliveInFlight <= KEEPALIVE_MAX_BYTES;

/**
 * POSTs with the client token. Keepalive when the body fits the page's keepalive budget, so a
 * send on hide outlives the page; credentials omitted. Never rejects or throws.
 */
export function send(
  fetchFn: typeof fetch,
  url: string,
  token: string,
  body: string | Blob,
  contentType: string,
  size: number,
  extraHeaders?: Record<string, string>,
): Promise<SendOutcome> {
  const keepalive = keepaliveFits(size);
  let request: Promise<Response>;
  try {
    const headers: Record<string, string> = { 'Content-Type': contentType, Authorization: `Bearer ${token}` };
    for (const k in extraHeaders) if (!/^(authorization|content-type)$/i.test(k)) headers[k] = extraHeaders[k];
    request = fetchFn(url, {
      method: 'POST',
      headers,
      body,
      keepalive,
      credentials: 'omit',
    });
  } catch (err) {
    return Promise.resolve(overBudget(err));
  }
  if (keepalive) keepaliveInFlight += size;
  const done = () => {
    if (keepalive) keepaliveInFlight -= size;
  };
  return request.then(
    (res) => {
      done();
      return classifyResponse(res);
    },
    (err) => {
      done();
      return overBudget(err);
    },
  );
}

export function classifyResponse(res: Response): SendOutcome {
  if (res.ok) return { kind: 'ok' };
  const { status } = res;
  if (status === 429 || status === 408 || status >= 500) {
    let header: string | null = null;
    try {
      header = res.headers.get('Retry-After');
    } catch {
      header = null;
    }
    return { kind: 'retryable', retryAfterMs: parseRetryAfter(header) };
  }
  return { kind: 'permanent', status };
}

/** 401 or 403: the token was revoked, the origin is not allowed or the app is paused. */
export const isRefused = (o: SendOutcome): boolean =>
  o.kind === 'permanent' && (o.status === 401 || o.status === 403);

/** Retry-After as delay seconds or an HTTP-date, in ms from now. */
export function parseRetryAfter(value: string | null, at: number = now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/[a-z]/i.test(v)) return undefined;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - at);
}

/** Exponential backoff with full jitter; Retry-After is a floor, honoured up to a day. */
export class Backoff {
  private failures = 0;

  next(retryAfterMs?: number): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures);
    this.failures++;
    return Math.max(Math.random() * ceiling, Math.min(retryAfterMs ?? 0, RETRY_AFTER_MAX_MS));
  }

  reset(): void {
    this.failures = 0;
  }
}

/** gzip with CompressionStream, or null where it is missing. */
export async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream !== 'function') return null;
  try {
    return await new Response(new Response(text).body!.pipeThrough(new CompressionStream('gzip'))).blob();
  } catch {
    return null;
  }
}
