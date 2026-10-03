# @siteqwality/rum

SiteQwality Real User Monitoring SDK: Web Vitals, page views, errors (with
source-map symbolication server-side), user actions, and session replay.

## Install

```bash
npm install @siteqwality/rum
```

## Usage

```ts
import { SiteQwalityRUM } from '@siteqwality/rum';

SiteQwalityRUM.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  version: '1.4.2', // your app release, enables error symbolication
});

SiteQwalityRUM.setUser({ id: 'user_123', email: 'user@example.com' });
SiteQwalityRUM.setGlobalAttribute('plan', 'pro');
SiteQwalityRUM.addError(new Error('custom error'));
SiteQwalityRUM.addAction('checkout-clicked');
```

`init()` starts collecting before it returns: the first page view is queued
and errors are captured from that line on. Its promise resolves once the
remote config is applied, or has failed (5 s timeout; then safe defaults: no
replay, inputs masked). There is no need to await it. No method ever throws;
calls made before `init()` are ignored. `addError` accepts any value: a
non-Error is sent as `String(value)` with no stack.

From 1.0.6 the user's id and email go on every event, page views and Web
Vitals included, so every session shows its user.

## CDN

`https://cdn.siteqwality.com/rum/v1/sdk.min.js` is a classic script whose only
global is `window.SiteQwalityRUM` (it also works as `type="module"`). Use the
snippet from the dashboard: its stub queues calls, and errors raised before
the script arrives, and replays both with their original times. Loading the
script twice is harmless, and if `init()` comes later (say, after consent),
page errors raised in between are still kept. The session-replay recorder loads on demand as
`recorder-<version>.min.js` from beside the SDK script; set `recorderUrl` to
self-host it. A strict CSP needs `script-src https://cdn.siteqwality.com` and
`connect-src https://rum.siteqwality.com https://replay.siteqwality.com`.

## Errors

Known browser noise is never sent: ResizeObserver loop warnings, a
cross-origin `Script error.` with no stack, and errors whose stack frames all
come from extensions (`chrome-extension://`, `moz-extension://`,
`safari(-web)-extension://`, `webkit-masked-url://`, `ms-browser-extension://`).
The ingestor drops the same noise for older versions. A burst of one message
sends 10 errors, then 1 per 10 s; a page load sends at most 500.

```ts
SiteQwalityRUM.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  // Substring of the message (trimmed, one leading "Uncaught " removed), or a RegExp.
  ignoreErrors: ['Network request failed', /Loading chunk \d+ failed/],
  // false or null drops; an object replaces; nothing sends your in-place changes.
  beforeSend: (event) => {
    if (event.error_message.includes('third-party-widget')) return false;
  },
});
```

`beforeSend` runs on errors only. If it throws, the original is sent. URLs in
what it returns are minimised again, and the ids and timestamp cannot change.
A dropped or ignored error never marks the session as errored and never
matches an error rule.

## Page views and sessions

A page view starts on load and whenever the URL (after minimisation) changes
through pushState, replaceState, popstate or hashchange, so router noise is not
counted; hash-routed apps get one view per `#/` route.
Views carry `loading_type` `initial_load` or `route_change`. Load and DOM-ready
times come from Navigation Timing, for the initial view only; if the page has
not finished loading at init they follow in a separate measure. Web Vitals
always belong to the document's initial view.

A session ends after 15 minutes without user input (pointer, key, scroll,
touch, the tab becoming visible, or a page view) and lasts at most 4 hours.
The SDK's own sends never keep it alive. The next activity, error or click
starts a new session with a fresh page view; requests and long tasks seen in an
expired session are dropped, so an idle polling tab never opens one.

## Recording rules

Rules are checked when the config loads or refreshes, after every error sent,
Web Vital, click and `setUser`, with no delay. A match lasts for the rest of
the session, across page loads in the tab (kept in sessionStorage as
`sq_rum_rules:<session id>`); a later page resumes it once the server config
arrives, never on the offline defaults. A custom rule with a condition this SDK does not
know never matches. Detail events seen before the config arrives (up to 500)
are kept and sent if a rule matches, otherwise dropped.

## Frustration signals

Each click carries at most one, by precedence: an `error_click` (an error sent
within 1 s), a `rage_click` (the third click on the same control within 1 s;
one per burst), a `dead_click` (a link or button that changed nothing within
1 s: no DOM change, navigation, request or page hide). Clicks are named after
the closest link, button or form control. Add `data-sq-no-frustration` to an
element or ancestor, or list selectors under the application's frustration
settings, to turn off rage and dead clicks there (games, carousels, steppers).

## Global attributes

`setGlobalAttribute(key, value)` adds a string to `custom_attributes` on every
later error, action and other detail event; `removeGlobalAttribute(key)` stops
it. A `context` passed to `addError` or `addAction` wins on the same key. Up to
50 keys of at most 128 characters; values are cut at 1024. All of them
together stay within 4 KB as JSON, since they ride on every detail event; a set
past that budget is ignored. Anything else is ignored, never thrown.

## URL minimisation

Every URL the SDK captures is minimised in the browser before it is sent:

- the fragment is removed, except a hash route (`#/path` or `#!/path`), which
  is kept and minimised like a path,
- the whole query string is removed,
- credentials in the authority (`https://user:pass@host/`) are removed,
- the scheme, host, port and path are kept verbatim.

This covers page views, SPA navigations, every subresource, fetch and XHR
recorded by the resource collector, the URL stamped on errors and actions, and
the page URL rrweb embeds in a session-replay segment. It exists because query
strings routinely carry password-reset tokens, magic-link tokens, session ids,
email addresses and search terms, and aggregate measures are retained for
months.

If you need specific parameters for analysis, opt them back in by name:

```ts
SiteQwalityRUM.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  allowedQueryParams: ['plan', 'tab'],
  deniedQueryParams: ['internal_ref'], // optional, on top of the built-in list
});
```

A built-in deny list (`token`, `access_token`, `id_token`, `refresh_token`,
`code`, `key`, `secret`, `password`, `passwd`, `pwd`, `email`, `e-mail`,
`session`, `sid`, `sig`, `signature`, `auth`, `apikey`, `api_key`) is applied
even to names you allow, and matches inside compound names too, so
`reset_token` and `user.email` are refused. There is no option that switches it
off.

The ingestor repeats the default behaviour server-side, so a cached older
version of this script cannot bypass it.

Two things this does **not** reach: URLs embedded in the DOM snapshot inside a
replay segment (rrweb's serialiser produces those and filtering them needs a
fork), and `document.referrer`, which this SDK does not capture at all.

The CDN files (`dist/cdn/`) are deployed separately with `make deploy`; they
are not part of the npm package.

## Excluded resources

Resource URLs listed under Excluded resources in the RUM application's
dashboard settings are not recorded. Applied at ingest for all versions; from
1.0.5 the SDK also skips sending them, picking up changes on its next config
refresh (every 5 minutes).

## Click names

Clicks are named `tag.class[text]` from the element's text or `aria-label`.
To set the name yourself, add `data-sq-action-name` to the element or an
ancestor; it is used as is (trimmed, up to 100 characters, square brackets
become parentheses):

```html
<button data-sq-action-name="Send message">Send to Jane</button>
```

With "Hide element text in click names" on in the RUM application's privacy
settings, other clicks are named `tag.class` only. Applied at ingest for all
versions; from 1.0.6 the SDK also stops sending the text, picking up changes on
its next config refresh.

## Development

```bash
npm install
npm test              # vitest
npm run build         # rollup: dist/esm + dist/cjs + dist/cdn
npm run build:types   # tsc: dist/types
npm run test:bundle   # built CDN core: one global, classic and module, 30 KB gzip budget
npm run test:browser  # Playwright: snippet, early errors, recorder, views, clicks
npm run size          # bundle sizes
make probe            # test:bundle against the live CDN file
```

## Changelog

- 1.1.0: classic CDN script with one global; collection starts at `init()`;
  browser noise filtered, burst limits, `ignoreErrors`, `beforeSend`,
  `recorderUrl`; page views only on URL change (one per hash route),
  `loading_type`, Navigation Timing load times; sessions follow user activity,
  and pending error and action counts go out on hide; rage, dead and error
  clicks; rules evaluated at once and kept per session; resource types limited
  to the known set.

## Publish checklist

`prepublishOnly` runs clean, build, build:types, the unit and bundle tests
and the package check, but walk this list before any `npm publish`:

1. Bump `version` per semver (`src/version.ts` too; a test keeps them equal)
   and tag the release commit (`git tag vX.Y.Z`).
2. `make check` green locally (unit, bundle and browser tests).
3. `npm pack --dry-run` and confirm the tarball contains only `dist/esm`,
   `dist/cjs`, `dist/types`, `README.md`, `LICENSE`, `package.json`.
4. Confirm the ingest endpoints the SDK targets are live in prod:
   `POST /v1/measure|events|errors` and `GET /v1/config` on
   `rum.siteqwality.com`.
5. `npm publish` (scoped package; `publishConfig.access: public` is already
   set). Requires npm org membership for `@siteqwality`.
6. Deploy the matching CDN files: `make deploy`, then `make probe`.
   Rollback: copy `rum/v<previous>/sdk.min.js` over `rum/v1/sdk.min.js` and
   invalidate.
