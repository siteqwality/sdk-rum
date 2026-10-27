# RUM SDK fixtures

A fixture site, a mock intake and a Playwright harness that drive the SDK in a real browser and
assert on everything it sends: the verification bed for SDK 2.x. Not part of the npm package (`files` in the root `package.json` lists `dist/` only).

## Run

```bash
npm ci                          # at the repo root, once
cd fixtures
npm ci                          # Playwright 1.60.0
npx playwright install chromium # once per machine
npm test                        # builds the SDK at the root, then runs every spec (about 3 min)
```

`npm test` starts its own fixture server, so stop any `npm run serve` first. `npm run serve` starts the fixture on its own: open http://localhost:4310 and click around. By hand
the site uses the token `fixture-manual`, which records every session; see what arrived with
`curl -s http://127.0.0.1:4320/__mock/summary`.

Another build: `SQ_SDK_DIR=/path/to/dist/cdn SQ_SDK_VERSION=2.1.0 npm test`. The harness tests 2.1 and
later and refuses older builds.

| Variable | Effect |
|---|---|
| `SQ_SDK_DIR` | Directory with `sdk.min.js` and its chunks (default `../dist/cdn`); skips the build |
| `SQ_SDK_VERSION` | Version of that build, when no `package.json` sits two levels above it |
| `SQ_SKIP_BUILD=1` | Test the existing `dist/cdn` without rebuilding |
| `SQ_LOADER` | `classic` (the dashboard snippet, the default) or `module` |
| `SQ_ACTIVE_SECONDS` | Length of the scripted replay session behind the per-minute numbers (default 60) |
| `SQ_SLOW=1` | Also run tests that wait for a 60 s checkout |
| `SQ_BROWSERS` | `chromium,firefox,webkit` (install them first). Only Chromium blocks DNS for other hosts |
| `SQ_SITE_PORT` and friends | Ports: site 4310, third party 4311, ingest 4320, replay 4321, CDN 4322 |

## Layout

- `server/`: one Node process, no dependencies. `index.js` serves the site on `localhost:4310`, a
  third-party origin on `127.0.0.1:4311`, the CDN on `:4322` (SDK files under `/rum/<prefix>/`,
  config v2 under `/rum/config/v2/<app>.json`) and the mock intake on `:4320` and `:4321`.
  `ingest.js` records every request, validates payloads against the intake contract, and answers
  like production. `app-config.js` builds config v2 from one spec (`capture`: none, analyze, replay,
  replay_on_error; `level`: strict, balanced, relaxed).
- `site/`: a dependency-free SPA (`/`, `/products/:id`, `/forms`, `/network`, `/errors`, `/console`,
  `/mutations`, `/canvas`, `/iframes`, `/heavy-css`, `/hash`) plus full pages under `/mpa/`.
  `boot.js` is the dashboard snippet. `canaries.js` lists the planted PII.
- `e2e/`: the specs (`*.e2e.js`, so neither vitest nor a root Playwright run picks them up) and
  `lib/`: sessions, the mock client, one view over batch and segment payloads (`captures.js`),
  canary rules, budgets.

Mock control API (`http://127.0.0.1:4320/__mock`): `POST /reset`, `PUT /apps/<token>` with
`{applicationId, spec}`, `GET /records?token=`, `GET /summary?token=`, `GET /quiet?token=&ms=`,
`PUT /faults` with `[{path, status, times, retryAfter}]`.

## Reading a run

- Each test opens its own browser context with its own app and token. Requests to any host
  outside the fixture fail the test, as do malformed payloads, refused requests and errors thrown by
  SDK code.
- **Canaries**: every planted value is grepped for in the URL, headers and decoded body of every SDK
  request, at each privacy level. A canary also needs proof its channel ran (input events recorded,
  the error captured, the fetch recorded), so absence means something.
- **Budgets** (`e2e/lib/budgets.js`): the SDK's size and request targets. Each target prints beside
  its measurement.
- **Clock** (`clock.e2e.js`): `/mpa/patched-date.html` patches `Date.now` and the `Date` constructor;
  RUM events and replay segments must still carry sane, monotonic times.
- **Long-lived tabs** (`long-lived.e2e.js`): `/mpa/ticking-clock.html` ticks a clock every second.
  With the page clock faked, an hour hidden or idle must cost a few requests, then resume from a
  full snapshot.
- **Two tabs** (`multi-tab.e2e.js`, `subdomains.e2e.js`): two tabs share one session, on one
  origin or on two subdomains through `cookieDomain` (`*.sq.test` maps to the fixture in
  Chromium). Each tab records its own window: every stream (session, window, page load) numbers
  from 0, opens with a Meta event and a full snapshot, and plays alone.
- **Replay ring** (`errors.e2e.js`, `privacy.e2e.js`, `replay_on_error`): nothing leaves the page
  before the first error; then the replay starts 60 to 120 s before it (page clock), and the
  canaries hold through the ring at every privacy level.
- **Segments v2** (`server/ingest.js`): every `/v2/segments` request is checked against the segments contract:
  UUID `s`, `w`, `p`; a u32 `q`; `ft`, `lt` and `n` matching the events; `fs` and `fin` as `1` or
  absent; the content type matching the encoding; a page load opening with a Meta event; and the
  same key never sent twice with different events.
- Tests finish like a user: hide the tab (simulated, headless pages never hide), then close it.
