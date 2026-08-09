/**
 * URL minimisation.
 *
 * Every URL the SDK sends is stored for as long as the account's retention
 * window allows, which for aggregate measures is 458 days. A URL is not an
 * opaque identifier: query strings routinely carry password-reset tokens,
 * magic-link tokens, session ids, email addresses and free-text search terms,
 * and fragments carry the same on single-page applications. Storing those for
 * over a year is the data the customer never intended to send us.
 *
 * So one sanitiser runs on every URL before it is enqueued, and the default is
 * to keep only the part that identifies the page:
 *
 * - The **fragment** is removed entirely. There is no allow list for it: a
 *   fragment is never needed to identify a page for performance analysis, and
 *   it is where SPA routers put access tokens.
 * - The **query string** is removed by default. A customer can opt individual
 *   parameters back in with `allowedQueryParams`, but read the section below on
 *   what that actually preserves before relying on it: for most fields the
 *   server removes them again.
 * - **Credentials** in the authority (`https://user:pass@host/`) are removed,
 *   whatever else is configured.
 * - The scheme, host, port and path are preserved verbatim.
 *
 * A **deny list** is applied even to parameters the customer allowed, so a
 * broad allow list cannot re-admit a token by accident. The deny list wins
 * every time; there is deliberately no way to override it.
 *
 * Free-text fields (an error message, a stack trace, a script filename) carry
 * URLs too, and exactly the same ones. {@link createTextUrlSanitizer} rewrites
 * each URL embedded in a string through these same rules and leaves the rest of
 * the string alone.
 *
 * # Why this is hand-rolled string work rather than `new URL()`
 *
 * Two reasons. `new URL()` throws on a relative or malformed URL, and this
 * function runs on data the host page controls, so throwing is not an option
 * (monitoring must never break the page). And the server repeats this logic
 * defensively in `core-rs/common/src/rum/url_privacy.rs`, because a stale SDK
 * cached on a customer's page keeps sending full URLs for as long as the cache
 * lives. Two implementations of "whatever the WHATWG URL parser normalises to"
 * would drift; two implementations of the plain string rules below do not.
 * `core-rs/common/src/rum/url_privacy.rs` carries the same case table, for both
 * the whole-URL and the free-text form.
 *
 * # What `allowedQueryParams` actually preserves
 *
 * It changes what leaves the browser, which is the part that matters most. It
 * does **not** decide what is stored for most fields: the ingestor re-applies
 * the strict default (no allow list, because it cannot tell an allowed
 * parameter from a stale bundle sending everything) to the view URL of every
 * measure, event and error, to `resource_url`, and to the error message and
 * stack. So a parameter named here survives the network hop and is then removed
 * again server-side for those fields.
 *
 * The one place an allowed parameter is stored as sent is the page `href`
 * inside a **session-replay segment**: the replay ingestor stores the segment
 * body byte for byte and never re-reduces it.
 *
 * # What this does not reach
 *
 * Stated as an enumeration of the SDK's outbound fields, because an incomplete
 * version of this list is what finding 11 of the wave-3 audit was about.
 *
 * Covered, all of them through this module: the view URL on every measure
 * (`collectors/views.ts`), the current URL stamped on every vital, resource,
 * action, long task and error (`init.ts` `currentUrl()`), `resource_url` on
 * every subresource, fetch and XHR (`collectors/resources.ts`), the page `href`
 * inside rrweb's Meta event (`replay/recorder.ts`), and `error_message`,
 * `error_stack` and `filename` (`collectors/errors.ts` and `init.ts`
 * `addError`).
 *
 * Not covered, and each for a reason:
 *
 * - **URLs inside the replay DOM snapshot**, the `src` and `href` attributes of
 *   the recorded page. rrweb's serialiser produces those and filtering them
 *   needs a fork or an upstream option. They are recorded as they are.
 * - **`custom_attributes`**, the `context` argument of `addError` / `addAction`.
 *   It is whatever the customer puts there, so the SDK cannot tell a URL from a
 *   value that merely looks like one, and rewriting a customer's own dimension
 *   would corrupt their data. Documented as "do not put personal data here"
 *   instead.
 * - **`action_target`**, up to 30 characters of element text or a CSS selector
 *   from `collectors/actions.ts`. Not URL-shaped, so nothing here applies; it is
 *   a separate minimisation question.
 * - **`document.referrer`**, which is not captured by this SDK at all today (no
 *   collector reads it). If a referrer is ever collected it must go through this
 *   sanitiser first.
 * - **A URL with no scheme** inside free text, such as a bare
 *   `example.com/a?token=x`. {@link createTextUrlSanitizer} keys on `://` and
 *   deliberately does not recognise protocol-relative or scheme-less forms,
 *   because `// comment` is far more common inside an error message than a
 *   protocol-relative URL. A field that is wholly a URL is handled by
 *   {@link createUrlSanitizer}, which needs no scheme.
 */

/**
 * Parameter names that are never sent, even when the customer allows them.
 *
 * Lower-case; matching is case-insensitive and percent-decodes the name first.
 */
export const DEFAULT_DENIED_QUERY_PARAMS: readonly string[] = [
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'code',
  'key',
  'secret',
  'password',
  'passwd',
  'pwd',
  'email',
  'e-mail',
  'session',
  'sid',
  'sig',
  'signature',
  'auth',
  'apikey',
  'api_key',
];

export interface UrlSanitizerOptions {
  /**
   * Query parameter names to preserve. Everything else is dropped.
   * Empty or omitted means the query string is removed entirely.
   */
  allowedQueryParams?: string[];
  /**
   * Extra parameter names to refuse, on top of
   * {@link DEFAULT_DENIED_QUERY_PARAMS}. The defaults cannot be removed.
   */
  deniedQueryParams?: string[];
}

export type UrlSanitizer = (url: unknown) => string;

/**
 * Normalise a raw query-parameter name for matching: percent-decode it, treat
 * `+` as a space the way form encoding does, trim, and lower-case.
 *
 * Never throws. `decodeURIComponent` rejects a malformed escape such as `%zz`,
 * in which case the raw name is used.
 */
function normalizeParamName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // Malformed percent escape: match on what was actually sent.
  }
  return decoded.trim().toLowerCase();
}

/**
 * Split a parameter name into its `_`, `-` and `.` delimited segments, so a
 * denied name matches inside a compound name too.
 *
 * `reset_token`, `csrf-token` and `user.email` are all obviously sensitive and
 * none of them equals a deny-list entry, so exact matching alone would let a
 * customer allow them by accident. The rule errs towards dropping: a parameter
 * named `sig_page` is refused because `sig` is denied, and losing a dimension
 * is cheaper than storing a signature for 458 days.
 */
function isDenied(name: string, denied: Set<string>): boolean {
  if (denied.has(name)) return true;
  for (const segment of name.split(/[_\-.]/)) {
    if (segment !== '' && denied.has(segment)) return true;
  }
  return false;
}

/**
 * Remove `user:pass@` from the authority, leaving everything else alone.
 *
 * Operates only on the authority component, so a path containing `@`
 * (`/users/@ada`) is untouched. A relative URL has no authority and is
 * returned unchanged.
 */
function stripCredentials(base: string): string {
  const schemeEnd = base.indexOf('://');
  let authorityStart: number;
  if (schemeEnd !== -1) {
    authorityStart = schemeEnd + 3;
  } else if (base.startsWith('//')) {
    // Protocol-relative URL.
    authorityStart = 2;
  } else {
    return base;
  }

  // The query and fragment are already gone by the time this runs, so the
  // authority ends at the first `/` or at the end of the string.
  let authorityEnd = base.indexOf('/', authorityStart);
  if (authorityEnd === -1) authorityEnd = base.length;

  const authority = base.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at === -1) return base;

  return (
    base.slice(0, authorityStart) +
    authority.slice(at + 1) +
    base.slice(authorityEnd)
  );
}

/** The kept parameters, in their original order and original raw spelling. */
function keepAllowedParams(
  query: string,
  allowed: Set<string>,
  denied: Set<string>,
): string {
  if (query === '' || allowed.size === 0) return '';

  const kept: string[] = [];
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const name = normalizeParamName(rawName);
    if (!allowed.has(name)) continue;
    // The deny list beats the allow list, always.
    if (isDenied(name, denied)) continue;
    kept.push(pair);
  }
  return kept.join('&');
}

/**
 * Build a sanitiser bound to one set of options.
 *
 * Prefer this over calling {@link sanitizeUrl} per URL: it builds the two sets
 * once, and the SDK calls it on every view, every navigation and every
 * subresource.
 */
export function createUrlSanitizer(
  options: UrlSanitizerOptions = {},
): UrlSanitizer {
  const allowed = new Set(
    (options.allowedQueryParams || []).map((name) =>
      normalizeParamName(String(name)),
    ),
  );
  const denied = new Set<string>(DEFAULT_DENIED_QUERY_PARAMS);
  for (const name of options.deniedQueryParams || []) {
    denied.add(normalizeParamName(String(name)));
  }

  return (url: unknown): string => {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed === '') return '';

    const hashAt = trimmed.indexOf('#');
    const withoutFragment = hashAt === -1 ? trimmed : trimmed.slice(0, hashAt);

    const queryAt = withoutFragment.indexOf('?');
    const base =
      queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt);
    const query =
      queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1);

    const cleanBase = stripCredentials(base);
    const keptQuery = keepAllowedParams(query, allowed, denied);

    return keptQuery === '' ? cleanBase : `${cleanBase}?${keptQuery}`;
  };
}

/** One-shot convenience wrapper around {@link createUrlSanitizer}. */
export function sanitizeUrl(
  url: unknown,
  options: UrlSanitizerOptions = {},
): string {
  return createUrlSanitizer(options)(url);
}

// ── URLs embedded in free text ───────────────────────────────────────────────

export type TextUrlSanitizer = (text: unknown) => string;

/** RFC 3986 scheme characters, minus the leading-letter rule. */
const SCHEME_CHAR = /[A-Za-z0-9+.\-]/;
const ASCII_LETTER = /[A-Za-z]/;

/**
 * Characters that end a URL when it is embedded in free text.
 *
 * Written out rather than using `\s`, so it is exactly Unicode `White_Space`
 * plus the `Cc` control category plus the specials below. That is character for
 * character what the Rust side's
 * `char::is_whitespace() || char::is_control() || matches!(…)` accepts, and the
 * two must agree or the same stack trace is stored two different ways.
 */
const URL_TERMINATOR =
  /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000"'`<>\\^{}|]/;

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charAt(i) === ch) n++;
  return n;
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Where to cut a free-text URL candidate: everything from the returned index
 * onwards is trailing noise to re-append verbatim rather than to sanitise.
 *
 * Two passes, in this order. First trailing sentence punctuation (`.`, `,`,
 * `;`, `:`, `!`) and an *unbalanced* closing `)`, `]` or `}`, so
 * `at f (https://cdn/app.js?v=1:1:2)` loses its `)` before anything else looks
 * at it. Then a trailing `:line` or `:line:column`, the shape a JS stack frame
 * writes, so minimising the URL cannot take the position with it.
 *
 * Everything cut here is re-appended unchanged, so this can never lose a
 * character, and because it only ever moves past punctuation and digits it can
 * never leave a `?` or a `#` on the wrong side of the cut.
 */
function splitTrailingNoise(candidate: string): number {
  let end = candidate.length;

  for (;;) {
    if (end === 0) break;
    const last = candidate.charAt(end - 1);
    let peel = false;
    if (
      last === '.' ||
      last === ',' ||
      last === ';' ||
      last === ':' ||
      last === '!'
    ) {
      peel = true;
    } else if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const head = candidate.slice(0, end);
      peel = countChar(head, last) > countChar(head, open);
    }
    if (!peel) break;
    end--;
  }

  for (let pass = 0; pass < 2; pass++) {
    let digits = 0;
    while (digits < end && isAsciiDigit(candidate.charAt(end - 1 - digits))) {
      digits++;
    }
    if (digits === 0 || digits >= end) break;
    const colon = end - digits - 1;
    if (candidate.charAt(colon) !== ':') break;
    if (candidate.slice(0, colon).indexOf('://') === -1) break;
    end = colon;
  }

  return end;
}

/**
 * Rewrite every URL embedded in a string through `sanitizeUrl`, leaving
 * everything else exactly as it was.
 *
 * This is for the fields that are prose rather than a URL: `error_message`,
 * `error_stack` and `filename`. A stack trace names the script URL of every
 * frame and a message routinely quotes the URL a request failed against, so
 * both carry precisely the tokens, session ids and email addresses this module
 * exists to remove. Dropping the whole string would remove the bug report with
 * them, so each URL is rewritten in place instead.
 *
 * # The rules, which `common::rum::url_privacy::minimise_urls_in_text` matches
 *
 * 1. A candidate begins at an occurrence of `://`. Its scheme is the run of
 *    `[A-Za-z0-9+.-]` immediately before it, advanced forward to its first
 *    ASCII letter. If no letter remains, the occurrence is not a URL.
 * 2. The candidate ends at the first {@link URL_TERMINATOR} or at the end of
 *    the string.
 * 3. {@link splitTrailingNoise} decides how much of the tail is punctuation and
 *    position rather than URL.
 * 4. The head goes through `sanitizeUrl`; the tail is re-appended verbatim.
 *
 * Never throws, and idempotent: running it on its own output is a no-op.
 */
export function createTextUrlSanitizer(
  sanitizeUrl: UrlSanitizer,
): TextUrlSanitizer {
  return (text: unknown): string => {
    if (typeof text !== 'string') return '';
    if (text.indexOf('://') === -1) return text;

    let out = '';
    let cursor = 0;
    let searchFrom = 0;

    for (;;) {
      const sep = text.indexOf('://', searchFrom);
      if (sep === -1) break;

      let runStart = sep;
      while (runStart > 0 && SCHEME_CHAR.test(text.charAt(runStart - 1))) {
        runStart--;
      }
      let start = runStart;
      while (start < sep && !ASCII_LETTER.test(text.charAt(start))) start++;
      if (start >= sep || start < cursor) {
        searchFrom = sep + 3;
        continue;
      }

      let end = sep + 3;
      while (end < text.length && !URL_TERMINATOR.test(text.charAt(end))) {
        end++;
      }

      const candidate = text.slice(start, end);
      const cut = splitTrailingNoise(candidate);

      out += text.slice(cursor, start);
      out += sanitizeUrl(candidate.slice(0, cut));
      out += candidate.slice(cut);

      cursor = end;
      searchFrom = end;
    }

    return out + text.slice(cursor);
  };
}

/** One-shot convenience wrapper around {@link createTextUrlSanitizer}. */
export function sanitizeTextUrls(
  text: unknown,
  options: UrlSanitizerOptions = {},
): string {
  return createTextUrlSanitizer(createUrlSanitizer(options))(text);
}
