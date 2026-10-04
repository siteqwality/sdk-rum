// PII pattern scrubbing (7.1), body redaction and the header denylist (6.10). URL
// minimisation lives in privacy/url.ts.
import { cut } from './util';

export type Scrub = (text: string) => string;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const CARD = /\d(?:[ -]?\d){12,18}/g;
const DIGITS = /\d{9,}/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = +digits[digits.length - 1 - i];
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * Replaces emails, Luhn-valid card numbers of 13 to 19 digits and digit runs of 9 or more.
 * `mask` keeps the length with `*` (replay text); otherwise each match becomes a token.
 */
export function createScrubber(patterns: readonly string[], mask = false): Scrub {
  const email = patterns.includes('email');
  const card = patterns.includes('card');
  const digits = patterns.includes('digits9');
  if (!email && !card && !digits) return (s) => s;
  const sub = (token: string) => (m: string) => (mask ? m.replace(/\S/g, '*') : token);
  return (s) => {
    if (typeof s !== 'string' || s === '') return s;
    let out = s;
    if (email && out.includes('@')) out = out.replace(EMAIL, sub('<email>'));
    if (card) {
      out = out.replace(CARD, (m, at: number, all: string) => {
        const d = m.replace(/\D/g, '');
        if (isDigit(all[at - 1]) || isDigit(all[at + m.length]) || !luhn(d)) return m;
        return sub('<card>')(m);
      });
    }
    if (digits) out = out.replace(DIGITS, sub('<digits>'));
    return out;
  };
}

/** Header and body keys whose values are never kept. */
const SECRET = /pass|secret|token|auth|api.?key|cookie|session|card|cvv|cvc|ssn/i;

/** Header names that are never captured, whatever the allowlist says. */
export function allowedHeaders(list: readonly string[]): string[] {
  return list
    .map((h) => h.toLowerCase())
    .filter((h) => h !== 'cookie' && h !== 'set-cookie' && !/token|secret|key|auth/.test(h));
}

/** A body for capture: secret JSON keys and form fields redacted, patterns scrubbed, cut. */
export function redactBody(text: string, maxChars: number, scrub: Scrub): { body: string; truncated?: true } {
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), (k, v) =>
      k && SECRET.test(k) && (v === null || typeof v !== 'object') ? '[redacted]' : v,
    );
  } catch {
    out = text.replace(/((?:^|[?&;])[^=&;]*?)=([^&;]*)/g, (m, name: string) =>
      SECRET.test(name) ? `${name}=[redacted]` : m,
    );
  }
  out = scrub(out);
  return out.length > maxChars ? { body: cut(out, maxChars), truncated: true } : { body: out };
}
