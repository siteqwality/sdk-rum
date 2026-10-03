/**
 * Largest body sent with `keepalive`. Browsers cap the bodies of all in-flight
 * keepalive requests from a page at 64 KiB together and reject a request past
 * that outright, so this leaves room for a second request in flight.
 */
export const KEEPALIVE_MAX_BYTES = 60_000;

/** First backoff ceiling after a retryable failure. Doubles per failure. */
export const BACKOFF_BASE_MS = 2_000;

/** Longest wait between two attempts, Retry-After included. */
export const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * What became of a send, which decides what the caller does with the batch.
 *
 * - `ok`: delivered.
 * - `retryable`: keep the batch and try again later. 429 (throttled or over
 *   quota), 408, any 5xx, and every network error. The last matters more than
 *   it looks: an API Gateway error response can lack the CORS headers, and the
 *   browser then reports it as a network error, not as its status.
 * - `permanent`: any other 4xx (400, 401, 403, 413). Sending the same body
 *   again cannot succeed, so the batch is dropped. See {@link isRefused}.
 */
export type SendOutcome =
  | { kind: 'ok' }
  | { kind: 'retryable'; retryAfterMs?: number }
  | { kind: 'permanent'; status: number };

/**
 * POSTs a JSON body to the ingest API, authenticated by the client token.
 *
 * Why not `navigator.sendBeacon` for the last batch on tab hide or unload, as
 * this SDK used to:
 * - The ingest gateway authenticates the `Authorization` header only, and a
 *   beacon cannot set headers, so a beacon is refused before it is read.
 * - Browsers always send beacons with credentials, and the ingest API answers
 *   CORS with `Access-Control-Allow-Origin: *`, which browsers refuse for a
 *   credentialed request. Every beacon logged a CORS error in the console.
 * That final batch is where CLS and INP (and often LCP) are reported.
 *
 * A keepalive fetch outlives the page the same way, can carry the header, and
 * with `credentials: 'omit'` sends no cookies, which nothing at the intake
 * reads. A body over the keepalive cap goes as a plain request instead: on a
 * hidden but still loaded page it completes, where keepalive would be refused.
 *
 * Never rejects and never throws: every failure is reported as an outcome, and
 * retrying is the caller's decision.
 */
export function sendJson(
  url: string,
  clientToken: string,
  body: string | Blob,
): Promise<SendOutcome> {
  const size = typeof body === 'string' ? byteLength(body) : body.size;
  let request: Promise<Response>;
  try {
    request = fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientToken}`,
      },
      body,
      keepalive: size <= KEEPALIVE_MAX_BYTES,
      credentials: 'omit',
    });
  } catch {
    return Promise.resolve({ kind: 'retryable' });
  }
  return request.then(classifyResponse, () => ({ kind: 'retryable' }));
}

export function classifyResponse(res: Response): SendOutcome {
  if (res.ok) return { kind: 'ok' };
  const { status } = res;
  if (status === 429 || status === 408 || status >= 500) {
    // Only readable cross-origin if the intake lists it in
    // Access-Control-Expose-Headers; otherwise this is null and the caller
    // falls back to its own backoff.
    const header = res.headers?.get?.('Retry-After') ?? null;
    return { kind: 'retryable', retryAfterMs: parseRetryAfter(header) };
  }
  return { kind: 'permanent', status };
}

/**
 * 401 or 403: the token was revoked or the account is stopped. Nothing sent
 * with this token will be accepted again on this page, so the caller stops
 * sending altogether rather than keep hammering the intake.
 */
export function isRefused(outcome: SendOutcome): boolean {
  return (
    outcome.kind === 'permanent' &&
    (outcome.status === 401 || outcome.status === 403)
  );
}

/**
 * A Retry-After header in milliseconds from now. Either form the header
 * allows: delay seconds, or an HTTP-date (a date in the past is 0).
 */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always names its day and month. Date.parse alone is lenient
  // enough to read "-5" as a year.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Exponential backoff with full jitter: after the nth consecutive failure the
 * wait is uniform between 0 and `BACKOFF_BASE_MS * 2^(n-1)`, capped at
 * `BACKOFF_MAX_MS`. The jitter keeps every client a throttled intake answered
 * at once from coming back at once.
 *
 * A Retry-After from the server is a floor under that wait (it never makes us
 * come back sooner than the backoff would, so `Retry-After: 0` cannot cause a
 * tight loop), and the result is still capped at `BACKOFF_MAX_MS`.
 */
export class Backoff {
  private failures = 0;

  /** Counts one more failure and returns how long to wait before retrying. */
  next(retryAfterMs?: number): number {
    const ceiling = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** this.failures,
    );
    this.failures++;
    const jittered = Math.random() * ceiling;
    return Math.min(BACKOFF_MAX_MS, Math.max(jittered, retryAfterMs ?? 0));
  }

  reset(): void {
    this.failures = 0;
  }
}

export function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;
}
