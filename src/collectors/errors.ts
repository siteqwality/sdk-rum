import type { TextUrlSanitizer } from '../privacy/url';

/**
 * A browser error, ready to be sent.
 *
 * **Every field here is already URL-minimised, and whoever constructs a
 * `CollectedError` is responsible for that.** `message`, `stack` and `filename`
 * are free text that routinely names URLs: a stack trace carries the script URL
 * of every frame, and `Failed to fetch https://api.example.com/reset?token=…`
 * is an ordinary message. Those query strings carry the same reset tokens,
 * magic-link tokens, session ids and email addresses as a page URL, and
 * `rum_events` keeps an error for the whole RUM Analyze window.
 *
 * There are exactly two constructors: `startErrorCollector` below, which
 * minimises with the sanitiser it is handed, and `SiteQwalityRUM.addError`,
 * which does the same. The ingestor repeats the reduction defensively, because
 * a stale SDK cached on a customer's page keeps sending raw strings.
 */
export interface CollectedError {
  message: string;
  source: string;
  stack: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

export function startErrorCollector(
  onError: (error: CollectedError) => void,
  sanitizeText: TextUrlSanitizer,
): void {
  window.addEventListener('error', (event) => {
    onError({
      message: sanitizeText(event.message),
      source: 'source',
      stack: sanitizeText(event.error?.stack || ''),
      // Not sent today: `RumErrorEvent` has no filename field. Minimised anyway
      // so that adding one can never reintroduce a raw script URL.
      filename: sanitizeText(event.filename),
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    onError({
      message: sanitizeText(event.reason?.message || String(event.reason)),
      source: 'console',
      stack: sanitizeText(event.reason?.stack || ''),
    });
  });
}
