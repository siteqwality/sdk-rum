// Byte and request budgets, from the design doc (5.2, 5.5, 8.2) unless noted.
import { kb } from './ledger.js';

const KB = 1024;

export const TARGETS = {
  // key: [limit, unit]. Comments give the source.
  // 5.2 estimated 18 KB, leaving out stack parsing, resource timing and the URL minimizer; 26 KB
  // accepted for 2.0 (2026-10-04).
  'core.gzip_bytes': [26 * KB, 'bytes'],
  'recorder.gzip_bytes': [30 * KB, 'bytes'], // 5.2
  'observe.requests': [3, 'count'], // 5.2, preflights excluded
  'observe.gzip_bytes': [5 * KB, 'bytes'], // 8.2
  'analyze.gzip_bytes': [30 * KB, 'bytes'], // 8.2
  'replay.wire_bytes_per_min': [100 * KB, 'bytes'], // 8.2 SaaS fixture
  'replay.segments_per_min': [3, 'count'], // 8.2
  'flood.raw_bytes': [400 * KB, 'bytes'], // 5.5: 64 KB/s over 5 s plus 25%
  'heavy.snapshot_wire_bytes': [300 * KB, 'bytes'], // B1: the gzipped snapshot of the 1 MB stylesheet page
  'hidden.requests': [3, 'count'], // the 2026-10-03 hidden-tab loop, 12 s with polling
};

const show = (value, unit) => (unit === 'bytes' ? kb(value) : String(value));

// Checks a measurement against its limit and prints the limit beside it.
export function budget(ledger, key, actual, { detail = '' } = {}) {
  const [limit, unit] = TARGETS[key];
  return ledger.check(key, actual <= limit, { detail: `${show(actual, unit)} (target ${show(limit, unit)})${detail ? `; ${detail}` : ''}` });
}
