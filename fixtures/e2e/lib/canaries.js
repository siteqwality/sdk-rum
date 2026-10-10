// When each planted canary may leave the browser, and how to find it if it does.
import { CANARIES } from '../../site/canaries.js';
import { RRWEB, RRWEB_SOURCE } from './captures.js';

export { CANARIES };

// 'absent' fails on a hit; 'allowed' is permitted by the level.
export function expectation(guard, level) {
  switch (guard) {
    case 'always':
    case 'inputs':
    case 'dom_urls':
    // Hidden inputs are blocked at every level, as a hard rule, not an app setting.
    case 'hidden_input':
      return 'absent';
    // Strict and Balanced mask or scrub these; Relaxed allows them (7.1).
    case 'text':
    case 'frame_text':
    case 'console':
    case 'action_text':
    case 'pattern_scrub':
      return level === 'relaxed' ? 'allowed' : 'absent';
    default:
      throw new Error(`unknown canary guard ${guard}`);
  }
}

// Spellings a value can take on the wire.
export function variants(value) {
  const out = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  if (/^[\d ]+$/.test(value)) {
    out.add(value.replace(/ /g, ''));
    out.add(value.replace(/ /g, '-'));
  }
  out.add(value.replace(/@/g, '%40'));
  return [...out].filter((v) => v.length >= 8);
}

export function findCanary(captures, value) {
  const hits = [];
  const needles = variants(value);
  for (const { record, text } of captures.haystacks()) {
    for (const needle of needles) {
      const at = text.indexOf(needle);
      if (at === -1) continue;
      hits.push({ kind: record.kind, path: record.path, context: text.slice(Math.max(0, at - 60), at + needle.length + 30).replace(/\s+/g, ' ') });
      break;
    }
  }
  return hits;
}

// Proof that a canary's channel was exercised, so its absence means something.
const hasPath = (list, path) => list.some((r) => (r.url || '').includes(path));
const replayHas = (c, marker) => c.replayEvents.some((e) => JSON.stringify(e).includes(marker));
const typed = (c) => c.replayEventsOf(RRWEB.INCREMENTAL, RRWEB_SOURCE.INPUT).length > 0;

export const PROOF = {
  password_input: (c) => typed(c) || 'no rrweb input events recorded',
  email_input: (c) => typed(c) || 'no rrweb input events recorded',
  card_input: (c) => typed(c) || 'no rrweb input events recorded',
  text_input: (c) => typed(c) || 'no rrweb input events recorded',
  textarea: (c) => typed(c) || 'no rrweb input events recorded',
  prefilled_input: (c) => replayHas(c, 'in-prefilled') || 'forms page not in replay',
  // Not the input's own name: the hidden input is blocked, attributes and all.
  hidden_input: (c) => replayHas(c, 'in-prefilled') || 'forms page not in replay',
  blocked_text: (c) => replayHas(c, 'forms') || 'forms page not in replay',
  url_query_token: (c) => hasPath(c.views, '/forms') || 'no view of /forms',
  url_fragment_token: (c) => hasPath(c.views, '/forms') || 'no view of /forms',
  fetch_query_token: (c) => hasPath(c.network, '/api/search') || 'search fetch not recorded',
  xhr_query_email: (c) => hasPath(c.network, '/api/search') || 'search XHR not recorded',
  error_url_token: (c) => c.errors.some((e) => e.message?.includes('fx:url-token')) || 'error not captured',
  error_email: (c) => c.errors.some((e) => e.message?.includes('fx:email')) || 'error not captured',
  body_password: (c, app) => app.some((r) => r.path === '/api/login') || 'login POST not made',
  response_secret: (c, app) => app.some((r) => r.path === '/api/profile') || 'profile fetch not made',
  auth_header: (c, app) => app.some((r) => r.path === '/api/profile') || 'profile fetch not made',
  cookie_value: () => true,
  storage_value: () => true,
  xframe_input: (c) => replayHas(c, 'frame-cross') || 'iframes page not in replay',
  xframe_text: (c) => replayHas(c, 'frame-cross') || 'iframes page not in replay',
  frame_text: (c) => replayHas(c, 'frame-same') || 'iframes page not in replay',
  page_text_email: (c) => replayHas(c, 'text-email') || 'forms page not in replay',
  page_text_card: (c) => replayHas(c, 'text-card') || 'forms page not in replay',
  page_text_digits: (c) => replayHas(c, 'text-digits') || 'forms page not in replay',
  dom_href_token: (c) => replayHas(c, 'reset-link') || 'forms page not in replay',
  // Strict blocks images outright (7.1), so the forms page itself is the proof there.
  dom_src_sig: (c, app, level) => replayHas(c, level === 'strict' ? 'reset-link' : 'pixel.svg') || 'forms page not in replay',
  console_email: () => true,
  action_text_email: (c) => c.actions.length > 0 || 'no clicks recorded',
  // The first view carries the referrer (5.6).
  referrer_token: (c) => c.views.length > 0 || 'no views recorded',
};
