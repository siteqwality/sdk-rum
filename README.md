# @siteqwality/rum

SiteQwality Real User Monitoring for the browser: page views, Core Web Vitals with attribution,
errors grouped across deploys, user actions with frustration signals, network and console detail,
and session replay. One small core on every page; the replay recorder loads only for sessions that
can be replayed.

## Install

```bash
npm install @siteqwality/rum
```

```ts
import { SiteQwalityRUM } from '@siteqwality/rum';

SiteQwalityRUM.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  service: 'web',
  env: 'production',
  version: '1.4.2', // your release, matched to source maps
});

SiteQwalityRUM.setUser({ id: 'user_123', email: 'user@example.com', name: 'Jane' });
SiteQwalityRUM.setGlobalAttribute('plan', 'pro');
SiteQwalityRUM.addAction('checkout-completed', { items: '3' });
SiteQwalityRUM.addError(new Error('payment declined'));
```

`init()` starts collecting before it returns: the first page view is queued and errors are captured
from that line on. Its promise resolves once the application's config is applied, or has failed
(3 s timeout), and never rejects; there is no need to await it. No method ever throws.

## CDN

Use the snippet from the dashboard. It defines a stub that queues calls and catches errors raised
before the script arrives, then loads `https://cdn.siteqwality.com/rum/v2/sdk.min.js`, a classic
script whose only global is `window.SiteQwalityRUM` (it also works as `type="module"`). Queued
calls replay in order with their original times, a second copy of the script does nothing, and
page errors raised between the script load and a late `init()` (say, after consent) are kept.

| Path | Contents | Cache |
|---|---|---|
| `rum/v2/sdk.min.js` | Latest 2.x | 1 day |
| `rum/v2.0.0/sdk.min.js` | This release, immutable; pin it with Subresource Integrity | 1 year |
| `recorder-<version>.min.js` | The replay chunk, beside the core it belongs to | as its folder |

`rum/v1/` stays on 1.x. The replay chunk is fetched from beside the core; set `recorderUrl` to
self-host it.

## Content Security Policy

```
script-src  https://cdn.siteqwality.com
connect-src https://in.siteqwality.com https://replay.siteqwality.com https://cdn.siteqwality.com
```

`in.siteqwality.com` takes events, `replay.siteqwality.com` replay segments, and the CDN serves
the script, the replay chunk and the application's config (fetched with `fetch`, hence
`connect-src`). To proxy through your own domain, set `ingestBase`, `replayBase` and `configBase`.

## Options

| Option | Default | Effect |
|---|---|---|
| `applicationId`, `clientToken` | required | From the RUM application's settings |
| `service`, `env`, `version` | none | Sent with every batch; `version` selects source maps |
| `trackingConsent` | `'granted'`, or `'pending'` when the app requires consent | See Consent |
| `persistence` | `'cookie'` | `'localStorage'` or `'memory'` (one page load, nothing stored) |
| `cookieDomain` | the page's host | Share the session across subdomains, e.g. `'example.com'` |
| `hashRouting` | `false` | One page view per `#/route` |
| `routeName(path)` | none | Route name for a path, e.g. `'/users/:id'` |
| `allowedQueryParams`, `deniedQueryParams` | none | See URL minimisation |
| `ignoreErrors`, `denyUrls` | none | See Errors |
| `beforeSend(event, kind)` | none | See beforeSend |
| `ingestBase`, `replayBase`, `configBase` | SiteQwality hosts | First-party proxies |
| `recorderUrl` | beside the core | CDN build: where the replay chunk is loaded from |
| `debug` | `false` | Logs config, rule decisions, recording state and sends to the console |

## Methods

| Method | |
|---|---|
| `init(options)` | Once per page; later calls are ignored |
| `setUser({ id, email, name, traits })`, `clearUser()` | Identity on every later batch; `traits` holds up to 20 strings |
| `setGlobalAttribute(key, value)`, `removeGlobalAttribute(key)` | Up to 50 string attributes, 4 KB in all, on every later batch |
| `addError(error, context?)` | Any value; `context['sq.fingerprint']` sets your own grouping |
| `addAction(name, context?)` | A custom event, always recorded |
| `setView(name)` | Names the current view's route |
| `setTrackingConsent(consent)` | `'granted'`, `'pending'` or `'not-granted'` |
| `optOut()`, `optIn()`, `isOptedOut()` | Persistent per browser; work before `init()` |
| `startReplay({ force? })`, `stopReplay()` | `force` records regardless of rules; consent still applies |
| `getSessionUrl({ atCurrentTime? })` | Link to this session in the dashboard |
| `getStatus()` | Session, consent, sampling, recording state and reason, drop counters |

Calls before `init()` are ignored, except the opt-out methods. The CDN stub queues them instead.

## What is recorded

The application's config (sampling, rules, privacy and capture settings) comes from the CDN, is
cached in `localStorage` for the next page, and refreshes when a tab becomes visible with a copy
older than 5 minutes. A paused application sends nothing.

- **Observe**, every sampled session: page views and their measures, Web Vitals, errors, failed
  requests, frustration signals, custom events.
- **Analyze**, once a recording rule matches: every action, request and resource, console output
  and long animation frames. The last 60 s before the match (up to 500 events) are kept in memory
  and sent with it.
- **Replay**, once a replay rule matches (or `startReplay`): the recorder loads and records.

A rule matches when all its conditions have held at some point in the session (URL, error, failed
request, frustration, vital, custom event, identified user, attribute, device, release,
environment), after its sample rate (deterministic per session) and its minimum duration and
interaction gates; error conditions skip the gates. A match lasts for the rest of the session in
every tab.

## Sessions and storage

A session ends after 15 minutes without user input (pointer, key, scroll, touch, the tab becoming
visible) and lasts at most 4 hours. The SDK's own sends never keep it alive. Tabs share the session
through a first-party cookie; each tab has its own window id.

| Key | Where | Holds |
|---|---|---|
| `_sq_s` | cookie (or `localStorage`) | Session id, start, last activity, rule decision |
| `_sq_w` | `sessionStorage` | Window id of this tab |
| `_sq_aid` | `localStorage` | Anonymous id, 13 months; not set without consent or under GPC |
| `_sq_cfg_<app>` | `localStorage` | Cached config |
| `_sq_bgt` | as the session | Request budget counters |
| `_sq_optout` | `localStorage` | Opt-out |

## Consent, GPC and opt-out

- `'pending'` collects in memory only: nothing is sent or stored, replay does not start. Granting
  sends what was held under a fresh session; `'not-granted'` drops it.
- With Global Privacy Control on and the app honouring it (the default), a session is Observe only:
  no Analyze detail, no replay, no user identity or anonymous id, and the session lives in
  `sessionStorage`. Cookieless apps get the same storage.
- `optOut()` stops everything in this browser until `optIn()`.

## Errors

Captured from `error` and `unhandledrejection`, and from `addError`. Never sent: browser noise
(ResizeObserver loop warnings, cross-origin `Script error.` with no stack, errors raised only in
extension code, and Sentry's default ignore list), messages matching `ignoreErrors` (substring or
RegExp, on the message trimmed and without a leading `Uncaught `), errors whose top frame URL matches
`denyUrls`, and the app's ignore, deny and suppressed lists. Identical errors within 5 s fold into
one with a `repeat` count; a burst of one error sends 10, then 1 per 10 s; a page load sends at most
500.

Each error carries its stack, up to three `cause` levels, the last 30 breadcrumbs (clicks,
navigations, failed requests, console), the Debug IDs of bundles built with our plugins, and an
`error_key`: a hash of the type, the message with digits removed and the top frame's normalised
path, so an error groups the same across deploys and browsers.

## beforeSend

```ts
SiteQwalityRUM.init({
  applicationId: 'YOUR_APPLICATION_ID',
  clientToken: 'YOUR_CLIENT_TOKEN',
  beforeSend: (event, kind) => {
    if (kind === 'error' && String(event.message).includes('third-party-widget')) return false;
    if (kind === 'network') event.url = String(event.url).replace(/\/users\/\d+/, '/users/:id');
  },
});
```

Runs for errors, views, actions, custom events, network rows and console lines, on a copy. Return
`false` or `null` to drop (views cannot be dropped), an object to replace, or nothing to keep your
in-place changes. Only fields the event already has change, and only to a value of the same type;
`k`, `t`, `view_id`, `id`, `seq`, `final` and `error_key` never change. URLs are minimised again and
messages and stacks scrubbed again; an error's `error_key` follows your changes. It must return
synchronously; if it throws, the event is sent unchanged.

## URL minimisation

Every URL the SDK captures is minimised in the browser before it is sent: the fragment is removed
(a hash route such as `#/path` is kept unless it holds `=` or `&`), the whole query string is
removed, and credentials in the authority are removed. This covers page views, resources, fetch and
XHR, URLs in error messages and stacks, the page URL in replay, and URL attributes in the replay
DOM. Opt parameters back in by name with `allowedQueryParams`; a built-in deny list (`token`,
`code`, `key`, `secret`, `password`, `email`, `session`, `sig`, `auth`, `apikey` and similar, also
inside compound names) applies even to names you allow and cannot be switched off. The intake
applies the same rules server-side.

## Session replay

- **Privacy levels** from the dashboard: Strict masks all text and blocks media; Balanced and
  Relaxed mask inputs. Password, email and phone fields are always masked, hidden inputs are never
  recorded, and block selectors always win. PII patterns (emails, card numbers, long digit runs) are
  masked with `*` so the layout stays.
- **Pauses**: while the tab is hidden, after 5 minutes without input (pointer moves count), and on
  never-record URLs, rrweb stops and nothing is sent. It resumes with a full snapshot, and the gap
  is marked in the replay. Recording never outlives its session.
- **Segments** close at 30 s, 500 events or about 750 KB, and when the tab hides or closes; a full
  snapshot every 3 minutes keeps seeking fast. A page whose snapshot is over 4 MB is not recorded
  (`status` reason `too_large`).

A tab left open on a page that ticks a clock every second sends nothing while hidden or idle; while
watched it sends about two segments a minute.

## Network capture

Failed requests (status 0, 4xx, 5xx, aborts, timeouts) are recorded for every session; successful
ones in Analyze sessions, with repeats of one request folded into counts and percentiles per 30 s.
Timing phases come from Resource Timing. A W3C `traceparent` header is added only to URLs listed
under trace URLs, headers only from the app's allowlist (never credentials), and bodies only for
body URLs, redacted and capped.

## Limits that protect you

- **Clock**: events and replay frames take `Date` only while it agrees with the browser's monotonic
  clock (it may run ahead after sleep, never behind), so a page that patches `Date` into the past
  or years ahead cannot skew times.
- **Request budget**: whatever the cause (a bug, a retry storm, hidden tabs), the SDK makes at
  most 5,000 requests and 250 MB per session, and 10,000 requests and 500 MB per page load. A 4 h
  session at full activity with replay needs about 2,200 requests. Past a ceiling it stops sending,
  says so once in the console and in `getStatus()` (reason `request_budget`), and resumes only in
  a new session.
- **Transport**: batches every 10 s or 200 events, errors within 1 s, gzip above 1 KB, everything
  queued sent when the tab hides, and a keepalive tail on close. 401 and 403 stop sending; other
  failures back off.

## Debugging

`debug: true`, or `?sq_debug=1` once in the URL (remembered in `localStorage`), logs every config,
rule decision, recording state and send. `getStatus()` returns the session and window ids, consent,
opt-out, sampling, recording state with its reason, the config revision and counters of everything
dropped.

## Bundle size

| File | gzip | Budget |
|---|---|---|
| Core `sdk.min.js` | 25.6 KB | 26 KB (CI gate) |
| Replay chunk `recorder-2.0.0.min.js` | 25.4 KB | 30 KB |

The design targets 18 KB for the core; its estimate left out stack parsing and grouping, resource
timing and the URL minimiser. Pages that never replay download only the core.

## Migrating from 1.x

- Events go to `POST https://in.siteqwality.com/v2/batch`; config comes from the CDN. Update your
  CSP (above). A first-party proxy needs the same paths.
- `beforeSend` now runs for every kind with `(event, kind)`; error events carry `message`, `stack`
  and `error_type` (1.x: `error_message`, `error_stack`, `error_source`). `apiBase` is gone.
- New methods: `clearUser`, `setView`, `setTrackingConsent`, `optOut`, `optIn`, `isOptedOut`,
  `startReplay`, `stopReplay`, `getSessionUrl`, `getStatus`. Update the snippet so its stub queues
  them.
- The session moves from `sessionStorage` (`sq_rum_session`) to the `_sq_s` cookie, shared by tabs.
  A running 1.1 session and its rule decision carry over.

## Development

```bash
npm install
npm test              # vitest
npm run build         # rollup: dist/esm, dist/cjs, dist/cdn
npm run build:types   # tsc: dist/types
npm run test:bundle   # the built CDN core: one global, classic and module, size budget
npm run test:browser  # Playwright: snippet, early errors, replay chunk, views, clicks
npm run size          # gzip sizes and budgets (size:modules adds a per-module view)
make probe            # test:bundle against the live rum/v2 file
```

`fixtures/` holds a fixture site, a mock intake and a Playwright harness that checks everything the
SDK sends; see its README.

## Changelog

- 2.0.0: batch v2 to `in.siteqwality.com` (gzip, keepalive tail, urgent errors); config from the
  CDN, cached; cookie sessions shared by tabs with window and page load ids; Observe, Analyze and
  Replay tiers with rules v2 and a 60 s detail ring; consent, GPC and opt-out; errors with cause
  chains, breadcrumbs, Debug IDs and stable grouping keys; Web Vitals with attribution; network
  detail with tracing; console capture; long animation frames; `beforeSend` for every kind; a clock
  the page cannot patch; a hard request budget; replay that pauses while hidden or idle and ends
  with its session; CDN path `rum/v2/`.
- 1.1.0: classic CDN script with one global; collection starts at `init()`; browser noise filtered,
  burst limits, `ignoreErrors`, `beforeSend`, `recorderUrl`; page views only on URL change;
  sessions follow user activity; rage, dead and error clicks; rules evaluated at once and kept per
  session; hidden inputs never recorded in replay.

## Publish checklist

`prepublishOnly` runs clean, build, build:types, the unit and bundle tests and the package check;
walk this list before any `npm publish`:

1. Bump `version` (and `src/version.ts`; a test keeps them equal) and tag the release commit.
2. `make check` green (unit, bundle, size and browser tests), and the fixture harness:
   `cd fixtures && SQ_SKIP_BUILD=1 SQ_SDK_VERSION=<version> npx playwright test`.
3. `npm pack --dry-run`: only `dist/esm`, `dist/cjs`, `dist/types`, `README.md`, `LICENSE`,
   `package.json`.
4. Confirm prod serves what 2.x calls: `POST /v2/batch` and `/v2/identity` on `in.siteqwality.com`,
   `POST /v1/segments` on `replay.siteqwality.com`, and config at
   `https://cdn.siteqwality.com/rum/config/v2/<app>.json` for live applications.
5. `npm publish` (scoped, public). Requires `@siteqwality` org membership.
6. `make deploy` uploads `dist/cdn` to `rum/v<version>/` (immutable; refuses to overwrite) and
   `rum/v<major>/`, prints the SRI hash and invalidates `/rum/v<major>/*`. Then `make probe`.
   Rollback: copy the previous release's files over `rum/v2/` and invalidate.
