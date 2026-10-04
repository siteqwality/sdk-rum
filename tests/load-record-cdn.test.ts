import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recorderUrlFor, DEFAULT_RECORDER_BASE } from '../src/replay/load-record.cdn';
import { VERSION } from '../src/version';

describe('VERSION', () => {
  it('matches package.json, which names the recorder file', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('recorderUrlFor', () => {
  const file = `recorder-${VERSION}.min.js`;

  it('sits beside the core script', () => {
    expect(recorderUrlFor(undefined, 'https://cdn.siteqwality.com/rum/v1/sdk.min.js')).toBe(
      `https://cdn.siteqwality.com/rum/v1/${file}`,
    );
    expect(recorderUrlFor(undefined, `https://cdn.siteqwality.com/rum/v${VERSION}/sdk.min.js?x=1`)).toBe(
      `https://cdn.siteqwality.com/rum/v${VERSION}/${file}`,
    );
    expect(recorderUrlFor(undefined, 'https://static.customer.example/vendor/sq/sdk.min.js')).toBe(
      `https://static.customer.example/vendor/sq/${file}`,
    );
  });

  it('falls back to the CDN v2 path without a script URL (module scripts)', () => {
    expect(DEFAULT_RECORDER_BASE).toBe('https://cdn.siteqwality.com/rum/v2/');
    expect(recorderUrlFor(undefined, undefined)).toBe(`${DEFAULT_RECORDER_BASE}${file}`);
    expect(recorderUrlFor(undefined, '')).toBe(`${DEFAULT_RECORDER_BASE}${file}`);
  });

  it('uses recorderUrl when set, resolved against the page', () => {
    expect(recorderUrlFor('https://static.customer.example/rec.js', 'https://cdn.siteqwality.com/rum/v1/sdk.min.js')).toBe(
      'https://static.customer.example/rec.js',
    );
    expect(recorderUrlFor('/vendor/rec.js')).toBe('http://localhost:3000/vendor/rec.js');
  });
});
