/**
 * Largest body sent with `keepalive`. Browsers cap the bodies of all in-flight
 * keepalive requests from a page at 64 KiB together and reject a request past
 * that outright, so this leaves room for a second request in flight.
 */
export const KEEPALIVE_MAX_BYTES = 60_000;

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
 * Fire and forget: a failed send is not retried.
 */
export function sendJson(
  url: string,
  clientToken: string,
  body: string | Blob,
): Promise<void> {
  const size = typeof body === 'string' ? byteLength(body) : body.size;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${clientToken}`,
    },
    body,
    keepalive: size <= KEEPALIVE_MAX_BYTES,
    credentials: 'omit',
  }).then(
    () => undefined,
    () => undefined,
  );
}

function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(text).length
    : text.length;
}
