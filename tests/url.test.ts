import { describe, it, expect } from 'vitest';
import {
  createUrlSanitizer,
  createTextUrlSanitizer,
  sanitizeUrl,
  sanitizeTextUrls,
  DEFAULT_DENIED_QUERY_PARAMS,
} from '../src/privacy/url';

describe('sanitizeUrl: the defaults', () => {
  it('strips the fragment entirely', () => {
    expect(sanitizeUrl('https://shop.example.com/cart#access_token=abc123')).toBe(
      'https://shop.example.com/cart',
    );
    expect(sanitizeUrl('https://example.com/#/account/reset/tok_9f2')).toBe(
      'https://example.com/',
    );
    // A bare fragment on the current page collapses to the path.
    expect(sanitizeUrl('https://example.com/a#')).toBe('https://example.com/a');
  });

  it('strips the whole query string by default', () => {
    expect(
      sanitizeUrl('https://example.com/reset?token=abc&email=ada@example.com'),
    ).toBe('https://example.com/reset');
    expect(sanitizeUrl('https://example.com/search?q=my+medical+condition')).toBe(
      'https://example.com/search',
    );
  });

  it('strips the query and the fragment together', () => {
    expect(
      sanitizeUrl('https://example.com/p?sid=9&x=1#section-2'),
    ).toBe('https://example.com/p');
  });

  it('preserves the scheme, host, port and path verbatim', () => {
    expect(sanitizeUrl('https://Example.COM:8443/A/b/C.js')).toBe(
      'https://Example.COM:8443/A/b/C.js',
    );
    // No normalisation: a URL with no path keeps having no path.
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('leaves a URL with nothing to remove untouched', () => {
    expect(sanitizeUrl('https://example.com/pricing')).toBe(
      'https://example.com/pricing',
    );
  });
});

describe('sanitizeUrl: the allow list', () => {
  const sanitize = createUrlSanitizer({ allowedQueryParams: ['plan', 'tab'] });

  it('keeps an allowed parameter and drops everything else', () => {
    expect(
      sanitize('https://example.com/billing?plan=pro&token=abc&tab=usage'),
    ).toBe('https://example.com/billing?plan=pro&tab=usage');
  });

  it('preserves the original order and raw spelling of what it keeps', () => {
    expect(sanitize('https://example.com/x?tab=a%20b&plan=pro')).toBe(
      'https://example.com/x?tab=a%20b&plan=pro',
    );
  });

  it('matches parameter names case-insensitively and percent-decoded', () => {
    expect(sanitize('https://example.com/x?PLAN=pro')).toBe(
      'https://example.com/x?PLAN=pro',
    );
    expect(sanitize('https://example.com/x?%70lan=pro')).toBe(
      'https://example.com/x?%70lan=pro',
    );
  });

  it('keeps a valueless allowed parameter and drops a valueless denied one', () => {
    expect(sanitize('https://example.com/x?plan&secret')).toBe(
      'https://example.com/x?plan',
    );
  });

  it('drops the whole query when nothing survives', () => {
    expect(sanitize('https://example.com/x?utm_source=email&token=abc')).toBe(
      'https://example.com/x',
    );
  });

  it('is still empty-by-default when no allow list is given', () => {
    expect(createUrlSanitizer()('https://example.com/x?plan=pro')).toBe(
      'https://example.com/x',
    );
    expect(
      createUrlSanitizer({ allowedQueryParams: [] })(
        'https://example.com/x?plan=pro',
      ),
    ).toBe('https://example.com/x');
  });
});

describe('sanitizeUrl: the deny list beats the allow list', () => {
  it('refuses every default denied name even when explicitly allowed', () => {
    for (const denied of DEFAULT_DENIED_QUERY_PARAMS) {
      const sanitize = createUrlSanitizer({ allowedQueryParams: [denied] });
      expect(sanitize(`https://example.com/x?${denied}=leaked`)).toBe(
        'https://example.com/x',
      );
    }
  });

  it('refuses a denied name inside a compound parameter name', () => {
    const sanitize = createUrlSanitizer({
      allowedQueryParams: ['reset_token', 'csrf-token', 'user.email'],
    });
    expect(
      sanitize(
        'https://example.com/x?reset_token=a&csrf-token=b&user.email=ada@example.com',
      ),
    ).toBe('https://example.com/x');
  });

  it('honours an extra denied name supplied by the customer', () => {
    const sanitize = createUrlSanitizer({
      allowedQueryParams: ['plan', 'account_ref'],
      deniedQueryParams: ['account_ref'],
    });
    expect(sanitize('https://example.com/x?plan=pro&account_ref=42')).toBe(
      'https://example.com/x?plan=pro',
    );
  });

  it('cannot have the built-in deny list removed', () => {
    // There is no option that clears the defaults; passing extras only adds.
    const sanitize = createUrlSanitizer({
      allowedQueryParams: ['token'],
      deniedQueryParams: [],
    });
    expect(sanitize('https://example.com/x?token=abc')).toBe(
      'https://example.com/x',
    );
  });
});

describe('sanitizeUrl: credentials in the authority', () => {
  it('removes user and password from an absolute URL', () => {
    expect(sanitizeUrl('https://user:pass@host/')).toBe('https://host/');
    expect(sanitizeUrl('https://user:pass@host.example.com:8443/a/b')).toBe(
      'https://host.example.com:8443/a/b',
    );
  });

  it('removes a bare username with no password', () => {
    expect(sanitizeUrl('https://ada@example.com/inbox')).toBe(
      'https://example.com/inbox',
    );
  });

  it('removes credentials from a protocol-relative URL', () => {
    expect(sanitizeUrl('//user:pass@cdn.example.com/app.js')).toBe(
      '//cdn.example.com/app.js',
    );
  });

  it('removes credentials even with no path at all', () => {
    expect(sanitizeUrl('https://user:pass@host')).toBe('https://host');
  });

  it('does not touch an @ that appears in the path', () => {
    expect(sanitizeUrl('https://example.com/users/@ada')).toBe(
      'https://example.com/users/@ada',
    );
  });

  it('removes credentials and the query and the fragment at once', () => {
    expect(
      sanitizeUrl('https://user:pass@host/p?token=abc#frag'),
    ).toBe('https://host/p');
  });
});

describe('sanitizeUrl: malformed and relative input', () => {
  it('does not throw on anything, and returns a string every time', () => {
    const inputs: unknown[] = [
      'not a url at all',
      'http://',
      '://missing-scheme',
      'https://exa mple.com/a b',
      '?????',
      '####',
      '%',
      'https://example.com/x?%zz=1&plan=pro',
      '',
      '   ',
      null,
      undefined,
      42,
      {},
      [],
    ];
    for (const input of inputs) {
      expect(() => sanitizeUrl(input)).not.toThrow();
      expect(typeof sanitizeUrl(input)).toBe('string');
    }
  });

  it('handles a malformed percent escape in a parameter name without throwing', () => {
    const sanitize = createUrlSanitizer({ allowedQueryParams: ['plan'] });
    expect(sanitize('https://example.com/x?%zz=1&plan=pro')).toBe(
      'https://example.com/x?plan=pro',
    );
  });

  it('handles relative URLs', () => {
    expect(sanitizeUrl('/account/settings?token=abc#tab')).toBe(
      '/account/settings',
    );
    expect(sanitizeUrl('checkout/step-2?sid=9')).toBe('checkout/step-2');
    expect(sanitizeUrl('/')).toBe('/');
    expect(sanitizeUrl('?token=abc')).toBe('');
    expect(sanitizeUrl('#/route/tok_1')).toBe('');
  });

  it('returns an empty string for a non-string, so a caller always gets a string', () => {
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
    expect(sanitizeUrl(12345)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeUrl('  https://example.com/a?x=1  ')).toBe(
      'https://example.com/a',
    );
  });
});

/**
 * The shared case table between this file and
 * `core-rs/common/src/rum/url_privacy.rs`.
 *
 * The ingestor repeats the SDK's default behaviour, because a stale bundle
 * cached on a customer's page keeps sending full URLs. If the two ever
 * disagree, the same page produces two different strings depending on which
 * side did the work, which splits every dashboard aggregate in two. Keep this
 * list and `equivalence_with_the_sdk_defaults` on the Rust side in step.
 */
describe('equivalence with the server-side minimiser', () => {
  const cases: [string, string][] = [
    ['https://shop.example.com/cart#access_token=abc123', 'https://shop.example.com/cart'],
    ['https://example.com/#/account/reset/tok_9f2', 'https://example.com/'],
    ['https://example.com/a#', 'https://example.com/a'],
    ['https://example.com/reset?token=abc&email=ada@example.com', 'https://example.com/reset'],
    ['https://example.com/search?q=my+medical+condition', 'https://example.com/search'],
    ['https://example.com/p?sid=9&x=1#section-2', 'https://example.com/p'],
    ['https://Example.COM:8443/A/b/C.js', 'https://Example.COM:8443/A/b/C.js'],
    ['https://example.com', 'https://example.com'],
    ['https://example.com/pricing', 'https://example.com/pricing'],
    ['https://user:pass@host/', 'https://host/'],
    ['https://user:pass@host.example.com:8443/a/b', 'https://host.example.com:8443/a/b'],
    ['https://ada@example.com/inbox', 'https://example.com/inbox'],
    ['//user:pass@cdn.example.com/app.js', '//cdn.example.com/app.js'],
    ['https://user:pass@host', 'https://host'],
    ['https://example.com/users/@ada', 'https://example.com/users/@ada'],
    ['https://user:pass@host/p?token=abc#frag', 'https://host/p'],
    ['/account/settings?token=abc#tab', '/account/settings'],
    ['checkout/step-2?sid=9', 'checkout/step-2'],
    ['/', '/'],
    ['?token=abc', ''],
    ['#/route/tok_1', ''],
    ['  https://example.com/a?x=1  ', 'https://example.com/a'],
    ['', ''],
    ['   ', ''],
  ];

  const sanitize = createUrlSanitizer();

  it.each(cases)('minimises %j the same way the ingestor does', (input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });
});

// ── URLs embedded in free text ───────────────────────────────────────────────

describe('sanitizeTextUrls: URLs inside an error message or a stack trace', () => {
  it('rewrites the URL and keeps the message around it', () => {
    expect(
      sanitizeTextUrls(
        'Failed to fetch https://api.example.com/reset?token=abc123&email=ada@example.com',
      ),
    ).toBe('Failed to fetch https://api.example.com/reset');
  });

  it('leaves text with no URL in it exactly as it was', () => {
    for (const text of [
      '',
      'plain message',
      'at bar (app.min.js:1:2345)',
      'a // b // c',
      'ratio 3:4',
      "Cannot read property 'foo' of undefined",
    ]) {
      expect(sanitizeTextUrls(text)).toBe(text);
    }
  });

  it('keeps every frame of a realistic stack trace parseable', () => {
    const stack = [
      'Error: request failed for https://app.example.com/reset?token=tok_9f2#step2',
      '    at fetchUser (https://cdn.example.com/static/main.8ab.js?v=2:120:9)',
      '    at async Checkout (https://cdn.example.com/chunks/checkout.js?sig=deadbeef:44:11)',
      '    at https://user:pass@internal.example.com:8443/proxy?key=secret:1:1',
      '    at bar (app.a3f9c2.min.js:1:2345)',
    ].join('\n');

    const out = sanitizeTextUrls(stack);

    expect(out).not.toContain('?');
    expect(out).not.toContain('#');
    for (const leaked of ['tok_9f2', 'deadbeef', 'secret', 'user:pass']) {
      expect(out).not.toContain(leaked);
    }

    // Debuggability: function, script and position all survive.
    expect(out).toBe(
      [
        'Error: request failed for https://app.example.com/reset',
        '    at fetchUser (https://cdn.example.com/static/main.8ab.js:120:9)',
        '    at async Checkout (https://cdn.example.com/chunks/checkout.js:44:11)',
        '    at https://internal.example.com:8443/proxy:1:1',
        '    at bar (app.a3f9c2.min.js:1:2345)',
      ].join('\n'),
    );
  });

  it('preserves the punctuation around a URL', () => {
    expect(sanitizeTextUrls('see https://example.com/a?x=1, then stop')).toBe(
      'see https://example.com/a, then stop',
    );
    expect(sanitizeTextUrls('failed at https://example.com/a?x=1.')).toBe(
      'failed at https://example.com/a.',
    );
    expect(sanitizeTextUrls('(https://example.com/a?x=1)')).toBe(
      '(https://example.com/a)',
    );
    expect(sanitizeTextUrls('"https://example.com/a?x=1"')).toBe(
      '"https://example.com/a"',
    );
  });

  it('rewrites every URL in the string, not only the first', () => {
    expect(
      sanitizeTextUrls(
        'two: https://a.example/x?k=1 and https://b.example/y#z',
      ),
    ).toBe('two: https://a.example/x and https://b.example/y');
  });

  it('honours the same allow and deny lists as the URL sanitiser', () => {
    const sanitize = createTextUrlSanitizer(
      createUrlSanitizer({ allowedQueryParams: ['plan', 'token'] }),
    );
    expect(sanitize('failed on https://example.com/a?plan=pro&token=abc')).toBe(
      'failed on https://example.com/a?plan=pro',
    );
  });

  it('is idempotent and never throws', () => {
    for (const text of [
      'https://a/b?x=1 https://c/d#e',
      '://no-scheme-here',
      '1https://example.com/a?x=1',
      'blob:https://example.com/9f2?x=1',
      'webpack://src/app.ts?query=1:12:3',
      'https://exämple.com/ünïcode?q=1 tail',
      'https://',
      'https://:1',
      'mailto:ada@example.com',
      '%%%',
      '   ',
    ]) {
      const once = sanitizeTextUrls(text);
      expect(sanitizeTextUrls(once)).toBe(once);
    }
  });

  it('returns an empty string for a non-string, so a caller always gets a string', () => {
    expect(sanitizeTextUrls(null)).toBe('');
    expect(sanitizeTextUrls(undefined)).toBe('');
    expect(sanitizeTextUrls(12345)).toBe('');
  });
});

/**
 * The shared case table for the free-text path, matching
 * `text_equivalence_with_the_sdk_defaults` in
 * `core-rs/common/src/rum/url_privacy.rs`. Keep the two lists in step.
 */
describe('text equivalence with the server-side minimiser', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['no url here', 'no url here'],
    [
      'Failed to fetch https://api.example.com/reset?token=abc',
      'Failed to fetch https://api.example.com/reset',
    ],
    [
      'at load (https://cdn.example.com/app.min.js?v=9f2:1:2345)',
      'at load (https://cdn.example.com/app.min.js:1:2345)',
    ],
    [
      'at https://cdn.example.com/vendor.js:10:20',
      'at https://cdn.example.com/vendor.js:10:20',
    ],
    ['see https://example.com/a?x=1, then stop', 'see https://example.com/a, then stop'],
    ['failed at https://example.com/a?x=1.', 'failed at https://example.com/a.'],
    ['(https://example.com/a?x=1)', '(https://example.com/a)'],
    [
      '"https://example.com/a?x=1" and \'https://example.com/b#f\'',
      '"https://example.com/a" and \'https://example.com/b\'',
    ],
    ['https://user:pass@host/p?token=abc#frag', 'https://host/p'],
    ['a // b // c', 'a // b // c'],
    ['://no-scheme-here', '://no-scheme-here'],
    ['blob:https://example.com/9f2?x=1', 'blob:https://example.com/9f2'],
    [
      'two: https://a.example/x?k=1 and https://b.example/y#z',
      'two: https://a.example/x and https://b.example/y',
    ],
    ['https://example.com:8443/a?x=1', 'https://example.com:8443/a'],
    ['at bar (app.min.js:1:2345)', 'at bar (app.min.js:1:2345)'],
  ];

  const sanitize = createTextUrlSanitizer(createUrlSanitizer());

  it.each(cases)('minimises %j the same way the ingestor does', (input, expected) => {
    expect(sanitize(input)).toBe(expected);
  });
});
