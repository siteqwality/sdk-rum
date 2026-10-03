// When each planted canary may leave the browser, and how to find it if it does.
import { CANARIES } from '../../site/canaries.js';
import { RRWEB, RRWEB_SOURCE } from './captures.js';

export { CANARIES };

// 'absent' fails on a hit; 'gap' is a known miss of this version; 'allowed' is permitted by the level.
// On 1.x, strict means mask_text on; balanced and relaxed mean mask_text off.
export function expectation(guard, sdk, level) {
  switch (guard) {
    case 'always':
    case 'inputs':
      return 'absent';
    case 'text':
      if (level === 'strict') return 'absent';
      if (level === 'balanced') return sdk.v2 ? 'absent' : 'gap';
      return 'allowed';
    case 'frame_text':
    case 'console':
      // 1.x drops iframe documents from replay and records no console; 2.0 scrubs both by level.
      if (!sdk.v2) return 'absent';
      return level === 'relaxed' ? 'allowed' : 'absent';
    case 'dom_urls':
      return sdk.v2 ? 'absent' : 'gap';
    case 'hidden_input':
      // Blocked at every level from 1.1, and in 2.0 as a hard rule, not an app setting.
      return sdk.wave1 ? 'absent' : 'gap';
    case 'action_text':
      // Strict hides click text in every version from 1.0.6; Balanced scrubs it from 2.0 (7.1).
      if (level === 'strict') return 'absent';
      if (level === 'balanced') return sdk.v2 ? 'absent' : 'gap';
      return 'allowed';
    case 'pattern_scrub':
      if (level === 'relaxed') return 'allowed';
      return sdk.v2 ? 'absent' : 'gap';
    default:
      throw new Error(`unknown canary guard ${guard}`);
  }
}

// Each canary is a gap on 1.x for its own reason; recorded so the report says why.
export const GAP_REASONS = {
  text: '1.x has no PII pattern scrubbing; Balanced arrives with 2.0 (design 7.1)',
  dom_urls: '1.x leaves DOM attribute URLs in replay as rrweb serialises them (README)',
  hidden_input: "1.0.x records input[type=hidden] values: rrweb's maskAllInputs does not cover hidden",
  pattern_scrub: '1.x sends error messages unscrubbed (URLs only are minimised)',
  action_text: '1.x puts button text in click names unscrubbed unless click text is hidden',
};

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
  // Not the input's own name: from 1.1 the hidden input is blocked, attributes and all.
  hidden_input: (c) => replayHas(c, 'in-prefilled') || 'forms page not in replay',
  blocked_text: (c) => replayHas(c, 'forms') || 'forms page not in replay',
  url_query_token: (c) => hasPath(c.views, '/forms') || 'no view of /forms',
  url_fragment_token: (c) => hasPath(c.views, '/forms') || 'no view of /forms',
  fetch_query_token: (c) => hasPath([...c.resources, ...c.network], '/api/search') || 'search fetch not recorded',
  xhr_query_email: (c) => hasPath([...c.resources, ...c.network], '/api/search') || 'search XHR not recorded',
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
  dom_src_sig: (c) => replayHas(c, 'pixel.svg') || 'forms page not in replay',
  console_email: () => true,
  action_text_email: (c) => c.actions.length > 0 || 'no clicks recorded',
  // 1.x captures no referrer; 2.0 sends it on the first view (5.6).
  referrer_token: (c) => c.views.length > 0 || 'no views recorded',
};
