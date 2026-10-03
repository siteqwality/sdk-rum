// fetch and XHR outcomes: 200, 4xx, 5xx, network failure, abort, timeout, CORS. Each records
// what the page saw, so the harness can prove an SDK wrapper never changes app behaviour.
import { canary } from '../canaries.js';

const results = () => window.fixture.results.network;
const third = () => window.fixture.origins.third;

async function viaFetch(id, url, init) {
  const started = performance.now();
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    results()[id] = { ok: res.ok, status: res.status, bodyLength: body.length, ms: performance.now() - started };
  } catch (err) {
    results()[id] = { error: err.name, message: String(err.message), ms: performance.now() - started };
  }
  return results()[id];
}

function viaXhr(id, url, setup = () => {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const done = (outcome) => {
      results()[id] = { status: xhr.status, outcome, bodyLength: (xhr.responseText || '').length };
      resolve(results()[id]);
    };
    xhr.open('GET', url);
    xhr.onload = () => done('load');
    xhr.onerror = () => done('error');
    xhr.onabort = () => done('abort');
    xhr.ontimeout = () => done('timeout');
    setup(xhr);
    xhr.send();
  });
}

export const CALLS = {
  fetch_ok: () => viaFetch('fetch_ok', '/api/ok'),
  fetch_404: () => viaFetch('fetch_404', '/api/notfound'),
  fetch_500: () => viaFetch('fetch_500', '/api/fail'),
  fetch_drop: () => viaFetch('fetch_drop', '/api/drop'),
  fetch_abort: () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    return viaFetch('fetch_abort', '/api/slow?ms=2000', { signal: ctl.signal });
  },
  fetch_timeout: () => viaFetch('fetch_timeout', '/api/slow?ms=2000', { signal: AbortSignal.timeout(100) }),
  fetch_cors: () => viaFetch('fetch_cors', `${third()}/api/nocors`),
  fetch_post: () =>
    viaFetch('fetch_post', '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'fixture', password: canary('body_password') }),
    }),
  xhr_ok: () => viaXhr('xhr_ok', '/api/ok'),
  xhr_500: () => viaXhr('xhr_500', '/api/fail'),
  xhr_drop: () => viaXhr('xhr_drop', '/api/drop'),
  xhr_abort: () => viaXhr('xhr_abort', '/api/slow?ms=2000', (xhr) => setTimeout(() => xhr.abort(), 50)),
  xhr_timeout: () => viaXhr('xhr_timeout', '/api/slow?ms=2000', (xhr) => (xhr.timeout = 100)),
  beacon: () => {
    results().beacon = { queued: navigator.sendBeacon('/api/beacon', 'fixture beacon') };
    return results().beacon;
  },
};

// What the page must see whatever the SDK does.
export const EXPECTED = {
  fetch_ok: { ok: true, status: 200 },
  fetch_404: { ok: false, status: 404 },
  fetch_500: { ok: false, status: 500 },
  fetch_drop: { error: 'TypeError' },
  fetch_abort: { error: 'AbortError' },
  fetch_timeout: { error: 'TimeoutError' },
  fetch_cors: { error: 'TypeError' },
  fetch_post: { ok: true, status: 200 },
  xhr_ok: { status: 200, outcome: 'load' },
  xhr_500: { status: 500, outcome: 'load' },
  xhr_drop: { status: 0, outcome: 'error' },
  xhr_abort: { status: 0, outcome: 'abort' },
  xhr_timeout: { status: 0, outcome: 'timeout' },
  beacon: { queued: true },
};

export async function runAll() {
  for (const call of Object.values(CALLS)) await call();
  return results();
}

export function loadProfile() {
  return viaFetch('profile', '/api/profile', { headers: { Authorization: `Bearer ${canary('auth_header')}` } });
}

export function search() {
  return Promise.all([
    viaFetch('search_fetch', `/api/search?q=widgets&api_key=${canary('fetch_query_token')}`),
    viaXhr('search_xhr', `/api/search?email=${encodeURIComponent(canary('xhr_query_email'))}`),
  ]);
}

let poller = null;
export function startPolling(ms = 500) {
  stopPolling();
  poller = setInterval(() => fetch('/api/poll').then((r) => r.json()).catch(() => {}), ms);
}
export function stopPolling() {
  clearInterval(poller);
  poller = null;
}

export function render(view) {
  view.innerHTML = `<h1>Network</h1>
    <div class="buttons">${Object.keys(CALLS).map((id) => `<button data-testid="net-${id}">${id}</button>`).join('')}
      <button data-testid="net-all">Run all</button>
      <button data-testid="net-poll-start">Start polling</button>
      <button data-testid="net-poll-stop">Stop polling</button></div>
    <pre data-testid="net-results"></pre>`;
  const out = view.querySelector('[data-testid=net-results]');
  const show = () => (out.textContent = JSON.stringify(results(), null, 1));
  for (const [id, call] of Object.entries(CALLS)) {
    view.querySelector(`[data-testid=net-${id}]`).onclick = () => Promise.resolve(call()).then(show);
  }
  view.querySelector('[data-testid=net-all]').onclick = () => runAll().then(show);
  view.querySelector('[data-testid=net-poll-start]').onclick = () => startPolling();
  view.querySelector('[data-testid=net-poll-stop]').onclick = () => stopPolling();
  return stopPolling;
}
