// Client for the mock intake's control API and the site's request log.
import { CONTROL, SITE_CONTROL } from '../../server/origins.js';

async function call(method, path, body) {
  const res = await fetch(`${CONTROL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`mock ${method} ${path}: ${res.status}`);
  return res.json();
}

const q = (token) => (token ? `?token=${encodeURIComponent(token)}` : '');

export const mock = {
  reset: () => call('POST', '/reset'),
  register: (token, applicationId, spec) => call('PUT', `/apps/${encodeURIComponent(token)}`, { applicationId, spec }),
  faults: (list) => call('PUT', '/faults', list),
  records: (token) => call('GET', `/records${q(token)}`),
  summary: (token) => call('GET', `/summary${q(token)}`),
  quiet: (token, ms = 1000, timeout = 20000) =>
    call('GET', `/quiet?token=${encodeURIComponent(token)}&ms=${ms}&timeout=${timeout}`),
};

export const site = {
  // App API requests the fixture made, with any tracing headers an SDK added.
  requests: async ({ clear = false } = {}) => (await fetch(`${SITE_CONTROL}/requests`, { method: clear ? 'POST' : 'GET' })).json(),
};

export async function poll(fn, { timeout = 15000, interval = 200, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
