// Starts the fixture site, the third-party origin, the CDN and the mock intake.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PORTS, ORIGINS } from './origins.js';
import { MockIngest } from './ingest.js';
import { readBody, send, serveFile, resolveInside } from './http.js';
import { heavyCss, hugePage } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(here, '../site');
const SDK_DIR = path.resolve(process.env.SQ_SDK_DIR || path.resolve(here, '../../dist/cdn'));

const mock = new MockIngest();
// The token boot.js uses when the site is opened by hand: records every session.
mock.register('fixture-manual', '00000000-0000-4000-8000-00000000f1f1', { capture: 'replay', level: 'balanced' });
const HEAVY_CSS = heavyCss();
const BOOT_TAG = '<script src="/boot.js"></script>';

// Headers an SDK might add to app requests; recorded so tests can assert on them.
const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage', 'sentry-trace', 'x-request-id'];
let appRequests = [];

const json = (res, status, body, headers) => send(res, status, body, headers);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function siteApi(req, res, url) {
  const headers = Object.fromEntries(TRACE_HEADERS.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
  const body = req.method === 'POST' ? (await readBody(req)).toString('utf8') : '';
  appRequests.push({ at: Date.now(), method: req.method, path: url.pathname, headers, bodyBytes: body.length });
  switch (url.pathname) {
    case '/api/ok':
      return json(res, 200, { ok: true, at: Date.now() });
    case '/api/fail':
      return json(res, 500, { ok: false, error: 'fixture failure' });
    case '/api/notfound':
      return json(res, 404, { ok: false });
    case '/api/drop':
      return req.socket.destroy();
    case '/api/slow':
      await delay(Math.min(Number(url.searchParams.get('ms') || 2000), 30000));
      return json(res, 200, { ok: true, slow: true });
    case '/api/search':
      return json(res, 200, { results: [{ id: 1, name: 'Widget' }] });
    case '/api/login':
      return json(res, 200, { ok: true, user: 'fixture' });
    case '/api/profile':
      return json(res, 200, { name: 'Fixture User', secret: 'sqcanaryresp_5d0c', plan: 'pro' });
    case '/api/poll':
      return json(res, 200, { ok: true, at: Date.now() });
    case '/api/beacon':
      return send(res, 204);
    default:
      return json(res, 404, { error: 'no such fixture api' });
  }
}

async function site(req, res) {
  const url = new URL(req.url, ORIGINS.site);
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, 'ok');
  if (p === '/__site/requests') {
    const out = appRequests;
    if (req.method === 'POST') appRequests = [];
    return json(res, 200, out);
  }
  if (p.startsWith('/api/')) return siteApi(req, res, url);
  if (p === '/boot.js') {
    const src = fs.readFileSync(path.join(SITE_ROOT, 'boot.js'), 'utf8');
    return send(res, 200, src.replace('/*__SQ_ORIGINS__*/ null', JSON.stringify(ORIGINS)), {
      'Content-Type': 'text/javascript; charset=utf-8',
    });
  }
  if (p === '/assets/heavy.css') return send(res, 200, HEAVY_CSS, { 'Content-Type': 'text/css; charset=utf-8' });
  if (p === '/mpa/huge.html') {
    const mb = Math.min(Math.max(Number(url.searchParams.get('mb') || 5), 1), 20);
    return send(res, 200, hugePage(mb, BOOT_TAG), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (p.startsWith('/missing/')) return send(res, 404, 'missing');
  const file = resolveInside(SITE_ROOT, p);
  if (file && path.extname(file) && serveFile(res, file)) return;
  if (path.extname(p)) return send(res, 404, 'not found');
  // History API fallback: every extensionless path is the SPA shell.
  return serveFile(res, path.join(SITE_ROOT, 'index.html'));
}

function third(req, res) {
  const url = new URL(req.url, ORIGINS.third);
  const p = url.pathname;
  if (p === '/healthz') return send(res, 200, 'ok');
  // No Access-Control-Allow-Origin: a cross-origin fetch of this fails like a CORS error.
  if (p === '/api/nocors') return json(res, 200, { ok: true });
  if (p.startsWith('/frames/') || p.startsWith('/third-party/')) {
    const file = resolveInside(SITE_ROOT, p);
    if (file && serveFile(res, file)) return;
  }
  return send(res, 404, 'not found');
}

function cdn(req, res) {
  const url = new URL(req.url, ORIGINS.cdn);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    mock.record({ host: 'cdn', method: 'OPTIONS', path: url.pathname, kind: 'preflight', status: 204, wireBytes: 0, headers: req.headers });
    return send(res, 204, '', { ...cors, 'Access-Control-Allow-Headers': '*' });
  }
  const config = /^\/rum\/config\/v2\/([^/]+)\.json$/.exec(url.pathname);
  if (config) {
    const appId = decodeURIComponent(config[1]);
    const body = mock.config2(appId);
    const token = mock.appsById.get(appId)?.token ?? null;
    mock.record({ host: 'cdn', method: req.method, path: url.pathname, url: url.href, kind: 'config_v2', token, status: body ? 200 : 404, wireBytes: 0, headers: req.headers });
    if (!body) return send(res, 404, '', cors);
    return json(res, 200, body, { ...cors, 'Cache-Control': 'public, max-age=300, s-maxage=60', ETag: `"${body.revision}"` });
  }
  // Every other /rum/<prefix>/<file> is a file of the SDK build under test.
  const asset = /^\/rum\/[^/]+\/(.+)$/.exec(url.pathname);
  const file = asset && resolveInside(SDK_DIR, `/${asset[1]}`);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const bytes = fs.readFileSync(file);
    mock.record({
      host: 'cdn', method: req.method, path: url.pathname, url: url.href, kind: 'sdk_asset', status: 200,
      wireBytes: bytes.length, gzipBytes: zlib.gzipSync(bytes).length, headers: req.headers,
    });
    return send(res, 200, bytes, { ...cors, 'Content-Type': 'text/javascript; charset=utf-8' });
  }
  mock.record({ host: 'cdn', method: req.method, path: url.pathname, kind: 'sdk_asset', status: 404, wireBytes: 0, headers: req.headers, problems: ['no such SDK file'] });
  return send(res, 404, 'not found', cors);
}

function ingest(req, res) {
  const url = new URL(req.url, ORIGINS.ingest);
  if (url.pathname.startsWith('/__mock')) return mock.control(req, res, url);
  return mock.handle('ingest', req, res, url);
}

function replay(req, res) {
  return mock.handle('replay', req, res, new URL(req.url, ORIGINS.replay));
}

function guard(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('[fixtures]', req.method, req.url, err);
      send(res, 500, 'fixture server error');
    });
  };
}

// localhost may resolve to either loopback address, so those ports listen on both.
function listen(port, handler, hosts) {
  for (const host of hosts) {
    const server = http.createServer(guard(handler));
    server.keepAliveTimeout = 2000;
    server.on('error', (err) => {
      if (host === '::1' && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT')) return;
      console.error(`[fixtures] cannot listen on ${host}:${port}: ${err.message}`);
      process.exit(1);
    });
    server.listen(port, host);
  }
}

const LOCAL = ['127.0.0.1', '::1'];
listen(PORTS.site, site, LOCAL);
listen(PORTS.third, third, ['127.0.0.1']);
listen(PORTS.ingest, ingest, LOCAL);
listen(PORTS.replay, replay, LOCAL);
listen(PORTS.cdn, cdn, LOCAL);

if (!fs.existsSync(path.join(SDK_DIR, 'sdk.min.js'))) {
  console.warn(`[fixtures] ${SDK_DIR}/sdk.min.js is missing: run npm run build at the repo root, or set SQ_SDK_DIR`);
}
console.log(`[fixtures] site ${ORIGINS.site}  third-party ${ORIGINS.third}`);
console.log(`[fixtures] ingest ${ORIGINS.ingest}  replay ${ORIGINS.replay}  cdn ${ORIGINS.cdn}`);
console.log(`[fixtures] SDK under test: ${SDK_DIR}`);
