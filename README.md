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
SiteQwalityRUM.addError(new Error('custom error'));
SiteQwalityRUM.addAction('checkout-clicked');
```

Init is fail-safe: if the remote config fetch fails or times out the SDK
falls back to safe defaults (no replay, inputs masked) and never breaks the
host page.

## URL minimisation

Every URL the SDK captures is minimised in the browser before it is sent:

- the fragment is removed entirely,
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

A CDN bundle is also built (`dist/cdn/sdk.min.js`, rrweb lazy-loaded) and
deployed separately via `make deploy`; it is not part of the npm package.

## Development

```bash
npm install
npm test             # vitest
npm run build        # rollup: dist/esm + dist/cjs + dist/cdn
npm run build:types  # tsc: dist/types
```

## Publish checklist

`prepublishOnly` runs clean + build + build:types + tests automatically, but
walk this list before any `npm publish`:

1. Decide the license. The package currently ships `"license": "UNLICENSED"`;
   pick a real license (or `SEE LICENSE IN LICENSE`) before the first public
   publish.
2. Bump `version` per semver and tag the release commit (`git tag vX.Y.Z`).
3. `npm run clean && npm run build && npm run build:types && npm test` all
   green locally.
4. `npm pack --dry-run` and confirm the tarball contains only `dist/esm`,
   `dist/cjs`, `dist/types`, `README.md`, `package.json`.
5. Confirm the ingest endpoints the SDK targets are live in prod:
   `POST /v1/measure|events|errors` and `GET /v1/config` on
   `rum.siteqwality.com`.
6. `npm publish` (scoped package; `publishConfig.access: public` is already
   set). Requires npm org membership for `@siteqwality`.
7. Deploy the matching CDN bundle: `make deploy`.
