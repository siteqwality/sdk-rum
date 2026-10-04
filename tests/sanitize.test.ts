import { describe, it, expect } from 'vitest';
import { createScrubber, redactBody, allowedHeaders } from '../src/core/sanitize';

const all = createScrubber(['email', 'card', 'digits9']);

describe('PII patterns (7.1)', () => {
  it('replaces emails, Luhn-valid card numbers and long digit runs', () => {
    expect(all('write to jane.doe+x@example.co.uk now')).toBe('write to <email> now');
    expect(all('card 4539 5827 1604 3814 on file')).toBe('card <card> on file');
    expect(all('card 4539-5827-1604-3814')).toBe('card <card>');
    expect(all('order 8675309123456')).toBe('order <digits>');
  });

  it('leaves short numbers, non-Luhn 16-digit groups and plain text alone', () => {
    expect(all('id 12345678 and 4539 5827 1604 3815 ok')).toBe('id 12345678 and 4539 5827 1604 3815 ok');
    expect(all('no pii here')).toBe('no pii here');
    expect(all('')).toBe('');
  });

  it('a card match never takes part of a longer digit run', () => {
    expect(createScrubber(['card'])('12345394582716043814')).toBe('12345394582716043814');
  });

  it('masks with stars of the same length for replay text', () => {
    const mask = createScrubber(['email', 'digits9'], true);
    expect(mask('mail a@b.io, ref 123456789')).toBe('mail ******, ref *********');
  });

  it('honours the configured patterns only', () => {
    expect(createScrubber([])('a@b.io 123456789')).toBe('a@b.io 123456789');
    expect(createScrubber(['digits9'])('a@b.io 123456789')).toBe('a@b.io <digits>');
  });
});

describe('redactBody', () => {
  it('redacts secret JSON keys at any depth, scrubs patterns and cuts', () => {
    const r = redactBody(JSON.stringify({ user: 'j@x.io', password: 'hunter2', nested: { apiKey: 'k', ok: 1 } }), 1000, all);
    expect(JSON.parse(r.body)).toEqual({ user: '<email>', password: '[redacted]', nested: { apiKey: '[redacted]', ok: 1 } });
    expect(r.truncated).toBeUndefined();
    expect(redactBody('x'.repeat(50), 10, all)).toEqual({ body: 'x'.repeat(10), truncated: true });
  });

  it('redacts secret form fields', () => {
    expect(redactBody('user=j&password=hunter2&token=t&n=1', 1000, (s) => s).body).toBe('user=j&password=[redacted]&token=[redacted]&n=1');
  });
});

describe('allowedHeaders', () => {
  it('never allows credentials-carrying names', () => {
    expect(allowedHeaders(['Content-Type', 'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth', 'x-session-token', 'proxy-authorization', 'x-request-id'])).toEqual(['content-type', 'x-request-id']);
  });
});
