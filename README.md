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
| `rum/v2.2.0/sdk.min.js` | Candidate immutable path, not published; pin releases with Subresource Integrity | 1 year |
| `recorder-<version>.min.js` | The replay chunk, beside the core it belongs to | as its folder |
| `canvas-<version>.min.js` | Opt-in canvas capture, beside the replay chunk | as its folder |
| `gzip-<version>.min.js` | gzip for browsers without `CompressionStream` (Safari before 16.4), beside the replay chunk | as its folder |

`rum/v1/` stays on 1.x. The replay chunk is fetched from beside the core, and the gzip fallback
and canvas module from beside the replay chunk; set `recorderUrl` to self-host them (keep all
three lazy files together).

## Content Security Policy

```
script-src  https://cdn.siteqwality.com
connect-src https://in.siteqwality.com https://in-replay.siteqwality.com https://cdn.siteqwality.com
```

`in.siteqwality.com` takes events, `in-replay.siteqwality.com` replay segments (2.0 used
`replay.siteqwality.com`), and the CDN serves the script, the replay chunk and the application's
config (fetched with `fetch`, hence `connect-src`). To proxy through your own domain, set
`ingestBase`, `replayBase` and `configBase`; a replay proxy forwards the fixed `POST /v2/segments`
URL with its `Authorization`, `Content-Type` and `x-sq-replay-index` headers.

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
- **Replay**, once a replay rule matches (or `startReplay`). When a replay rule could still match
  this session (it is sampled in, and its device, release and environment conditions hold), the
  recorder starts at page load and keeps the last two checkouts in memory (60 to 120 s, at most
  5 MB). A match sends them, then recording streams, so an error replay shows the minute or two
  before the error. Without a match nothing is sent or stored, and the memory is dropped when
  the page goes. Without any such rule the recorder is never downloaded.

A rule matches when all its conditions have held at some point in the session (URL, error, failed
request, frustration, vital, custom event, identified user, attribute, device, release,
environment), after its sample rate (deterministic per session) and its minimum duration and
interaction gates; error conditions skip the gates. A match lasts for the rest of the session in
every tab.

## Sessions and storage

The first view of a session carries its referrer (`""` for a direct visit), UTM parameters and
click-id type. A session ends after 15 minutes without user input (pointer, key, scroll, touch, the tab becoming
visible) and lasts at most 4 hours. The SDK's own sends never keep it alive. Tabs share the session
through a first-party cookie; each tab has its own window id.

| Key | Where | Holds |
|---|---|---|
| `_sq_s` | cookie (or `localStorage`) | Session id, start, last activity, rule decision |
| `_sq_w` | `sessionStorage` | Window id of this tab |
| `_sq_aid` | `localStorage` | Anonymous id, 13 months; not set without consent or under GPC |
| `_sq_cfg_<app>` | `localStorage` | Cached config |
| `_sq_bgt`, `_sq_bgr` | as the session | Request budget counters (core, replay) |
| `_sq_rcap` | as the session | Session id whose replay reached the backend cap; removed on consent withdrawal |
| `_sq_cb` | as the session | Canvas byte counters and cap flags keyed by session; removed on consent withdrawal |
| `_sq_optout` | `localStorage` | Opt-out |

2.1 no longer uses 2.0's `_sq_rseq` and `_sq_rl` and removes them when replay starts.

Nothing is stored while consent is pending or with `persistence: 'memory'`. Withdrawing consent
removes every key but the opt-out.

## Consent, GPC and opt-out

- `'pending'` collects in memory only: nothing is sent or stored, replay does not start. Granting
  sends what was held, in the session another tab already has or a new one; `'not-granted'` drops
  it. Consent set with `setTrackingConsent` is never overridden by the application's config.
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

The application's ignore and deny lists use the intake's pattern language: a case-sensitive
substring, or a regular expression written `/…/` (`/…/i` ignores case). Ignore patterns match the
message as sent (URLs minimised, PII scrubbed), or the type and message (`TypeError: x is null`). The SDK applies a deny pattern only when
the top frame is surely the page's own code; the intake decides the rest. With "console errors as
issues" on, `console.error` calls become errors with `handling: "console"`.

Each error carries the page `url`, its stack, up to three `cause` levels, the last 30 breadcrumbs (clicks,
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
`k`, `t`, `view_id`, `id`, `seq`, `final` and `error_key` never change. What you change is minimised
and scrubbed again (URLs, stacks, text, nested fields included); what you leave alone is sent as
the SDK built it, and an error's `error_key` follows your changes. It must return synchronously; if
it throws, the event is sent unchanged.

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
  is marked in the replay (`sq-pause`). Recording never outlives its session.
- **Every tab records its own window**: segments carry the session, window and page load ids and
  number from 0 per page load, so each page load plays alone and the player orders windows.
  Hidden tabs pause, so in practice the tab in front records.
- **Error replays**: with a rule such as Errored sessions, every session keeps its last two
  checkouts in memory (see What is recorded), so the replay starts 60 to 120 s before the error.
- **Never-record URLs** use the same pattern language as the error lists: a substring of the page
  URL, or `/regex/`. Expressions see the first 4 KB of the text.
- **Diet**: pointer moves sampled at 50 ms, scrolls at 150 ms, media events at 800 ms; an input's
  value is recorded when it changes (on blur or Enter), masked as the privacy level says. A node
  that changes more than 100 times is held to about 10 changes a second, its latest state sent
  once a second, so the replay ends exact. Mutations past 64 KB a second (averaged over 5 s) are
  dropped, the gap is marked (`sq-throttle`) and a fresh snapshot follows when the page calms (or
  after 30 s if it does not), at most every 30 s. Recording never stops for volume.
- **Stylesheets** are inlined so the player needs nothing from your site; a checkout names a
  stylesheet over 1 KB that already reached SiteQwality (`sq-css:<hash>`, FNV-1a 64) instead of
  sending it again. URLs inside stylesheets and `style` attributes are minimised like any other.
  Images, fonts and canvas are never inlined into snapshots.
- **Segments** are gzipped and close at 20 s or about 2.5 MB, at a page's first snapshot (sent at
  once, so a short page view still plays), and when the tab hides. After a pause, the snapshot's
  segment goes once it is past 60 KB, so a tab closed right after it came back loses nothing. A full snapshot every 3 minutes,
  taken where a segment closes, keeps seeking fast. On close, what is left goes with keepalive, as
  JSON, if it is at most 60 KB; anything else is counted in `status`. A page whose snapshot is over
  4 MB after stylesheet references is not recorded (`status` reason `too_large`).
  Segments POST to the fixed `/v2/segments` URL. Index fields (`s,w,p,q,ft,lt,n,fs,fin,r,v`)
  use one URLSearchParams-encoded `x-sq-replay-index` header (at most 2,048 bytes), so sends reuse the CORS
  preflight cache. The client token stays in `Authorization`; it is never put in the URL.
  Proxies must allow `authorization`, `content-type`, and `x-sq-replay-index` and return
  `Access-Control-Max-Age` on OPTIONS. Deploy that backend support before SDK 2.1.
- **Replay refusal**: `403 {"reason":"not_enabled"}` falls back to Observe/Analyze-only operation
  with recording stopped and reason `not_enabled` for this page load. It never retries against v1.
  Other 401/403 responses, including empty, unknown or malformed 403 bodies, stop replay with
  reason `refused`. Observe and Analyze continue.
- **Replay session cap**: `429 {"reason":"session_cap"}` stops capture and delivery with reason
  `session_cap`, discards queued data and the unload tail, and does not retry for that session.
  Tabs sharing storage learn the cap before sending and on their next 15-second check; reloads
  retain it. A new session may record again. Other 429s, including an older backend's bare 429,
  retain backoff and honour `Retry-After` for all segments and the unload tail.

A tab left open on a page that ticks a clock every second sends nothing while hidden or idle; while
watched it sends at most three segments a minute.

### Opt-in canvas (2.2 candidate)

Canvas is disabled by default. Application config may opt in with
`capture.canvas: { enabled: true, selectors: [], fps: 2, quality: 0.4 }`.
An empty selector list selects all canvases in the recorded document, including mirrored shadow
DOM. Block selectors and blocked ancestors always win. Strict privacy disables canvas even if
enabled. Invalid selectors fail closed. The sampler follows replay consent, GPC, never-record
URLs, visibility, idle and session boundaries. Canvas configuration changes restart capture from
a fresh snapshot.

The separate `canvas-2.2.0.min.js` chunk loads only for opted-in non-Strict recording. It samples
visible canvases at at most 2 fps, resizes to a maximum side of 1,280 pixels and encodes WebP at
quality at most 0.4. Off-screen, hidden, zero-size, tainted and unsupported canvases emit no pixels.
It reads 2D/WebGL output without patching drawing commands or clearing the application's context.

Canvas stops after reserving at most 20,000,000 serialized frame-event bytes per session, before gzip,
including frames held in the error ring. DOM replay continues. Shared-storage reservations use
Web Locks across same-origin tabs and survive reloads; without locks or usable storage, that
canvas capture fails closed. Memory persistence shares a counter within the page only. Different
origins cannot share this client-side counter, so a hard aggregate cross-subdomain cap requires
backend enforcement.

Frames use native rrweb type 3/source 9 bitmap commands; `sq-canvas-ref` links an element across
checkouts and the cap emits custom tag `sq-canvas-cap`.
See [the player contract](docs/plans/2026-10-04-canvas-opt-in.md). This candidate must remain
unpublished until WP7.2 proves playback, seeking and last-frame retention across checkouts.

## Web Vitals

LCP, INP and CLS with web-vitals' definitions and attribution sub-parts (LCP load delay, load
time and render delay; INP input delay, processing and presentation, with the longest script of
its animation frame), plus FCP and TTFB. They belong to the document's initial view. Attribution
targets use the click selector (id, `data-testid`, `data-sq-*`, tag and up to two stable classes),
so a target groups the same across deploys.

## Network capture

Failed requests (status 0, 4xx, 5xx, aborts, timeouts) are recorded for every session; successful
ones in Analyze sessions, with repeats of one request folded into counts and percentiles per 30 s.
Repeated failures fold the same way, with `err_n`, so a page polling a broken endpoint costs one row
per 30 s. Timing phases come from Resource Timing. Trace URLs and body URLs are URL prefixes, never
patterns: `/api` is a path on the page's own origin (and below it, so not `/apix`), and
`https://api.example.com/v1` that origin and path. A W3C `traceparent` header is added only to
matching URLs, headers only from the app's allowlist (never credentials), and bodies only for
matching URLs, redacted, read up to the size cap (event streams never), and given up after 10 s
(marked `truncated`). With no rules, nothing is traced or captured.

## Limits that protect you

- **Clock**: events and replay frames take `Date` only while it agrees with the browser's monotonic
  clock (it may run ahead after sleep, never behind), so a page that patches `Date` into the past
  or years ahead cannot skew times.
- **Request budget**: whatever the cause (a bug, a retry storm, hidden tabs), the SDK makes at
  most 5,000 requests and 100 MB per session (10,000 and 200 MB per page load) for events, config
  and identity, and apart from those 2,500 requests and 250 MB per session (5,000 and 500 MB per
  page load) for replay. A 4 h session at full activity makes about 1,500 and 720. Past a ceiling
  it stops sending (replay alone, when it is replay's), says so once in the console and in
  `getStatus()` (reason `request_budget` or `replay_budget`), and resumes only in a new session.
- **Transport**: batches every 10 s or 200 events, errors within 1 s, gzip above 1 KB, everything
  queued sent when the tab hides, and a keepalive tail on close. 401 and 403 stop sending; 429, 408
  and 5xx back off, and a `Retry-After` (up to a day) holds every send, on hide and close too.

## Debugging

`debug: true`, or `?sq_debug=1` once in the URL (remembered in `localStorage`), logs every config,
rule decision, recording state and send. `getStatus()` returns the session and window ids, consent,
opt-out, sampling, recording state with its reason, the config revision and counters of everything
dropped.

## Bundle size

| File | gzip | Budget |
|---|---|---|
| Core `sdk.min.js` | 26.0 KB | 26 KB (CI gate) |
| Replay chunk `recorder-2.2.0.min.js` | 29.4 KB | 30 KB (CI gate) |
| Canvas chunk `canvas-2.2.0.min.js` | 2.0 KB | 6 KB (CI gate) |
| gzip fallback `gzip-2.2.0.min.js` | 3.3 KB | 9 KB (CI gate) |

The design estimated 18 KB for the core, leaving out stack parsing and grouping, resource timing and
the URL minimiser; 26 KB is the accepted 2.0 budget, and CI fails a build past it. Pages that never
replay download only the core; only browsers without `CompressionStream` download the gzip fallback.

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

- 2.2.0 (unpublished candidate): opt-in canvas frames with bounded WebP encoding, privacy and
  lifecycle checks, lazy loading, and a session byte cap. Requires the WP7.2 player integration.
- 2.1.0: replay chunk v2. Segments v2 to `POST /v2/segments` on `in-replay.siteqwality.com` (gzip,
  window and page load ids, a sequence per page load); every tab records its own window (the 2.0
  one-tab lease is gone); a replay ring from page load, so error replays start 60 to 120 s before
  the error; the recorder diet (mutation throttling and coalescing, stylesheet references, input,
  scroll and media sampling); 20 s segments; a keepalive tail on close; a gzip fallback for
  browsers without `CompressionStream`.
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
   `POST /v2/segments` on `in-replay.siteqwality.com` (2.1; its CORS allows `authorization`,
   `content-type` and `x-sq-replay-index`), and config at
   `https://cdn.siteqwality.com/rum/config/v2/<app>.json` for live applications.
5. `npm publish` (scoped, public). Requires `@siteqwality` org membership.
6. `make deploy` uploads `dist/cdn` to `rum/v<version>/` (immutable; refuses to overwrite) and
   `rum/v<major>/`, prints the SRI hash and invalidates `/rum/v<major>/*`. Then `make probe`.
   Rollback: copy the previous release's files over `rum/v2/` and invalidate.
