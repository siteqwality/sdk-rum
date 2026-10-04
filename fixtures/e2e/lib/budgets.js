// Byte and request budgets. 2.0 targets come from the design doc (5.2, 5.5, 8.2). The 1.x limits
// are regression guards: 1.0.7 as measured on this fixture on 2026-10-03, plus headroom.
import { SDK } from './env.js';
import { kb } from './ledger.js';

const KB = 1024;

export const TARGETS = {
  // key: [2.0 target, 1.x limit, unit]. Comments give the source and the 1.0.7 measurement.
  'core.gzip_bytes': [18 * KB, 30 * KB, 'bytes'], // 5.2; 1.x limit is the Wave 1 F2 gate; 1.0.7: 9.9 KB
  'recorder.gzip_bytes': [30 * KB, 30 * KB, 'bytes'], // 5.2; 1.0.7: 22.0 KB
  'observe.requests': [3, 5, 'count'], // 5.2, preflights excluded; 1.0.7: 4
  'observe.gzip_bytes': [5 * KB, 3 * KB, 'bytes'], // 8.2; 1.0.7: 0.6 KB (1.2 KB as sent)
  'analyze.gzip_bytes': [30 * KB, 10 * KB, 'bytes'], // 8.2; 1.0.7: 1.4 KB (7.0 KB as sent)
  'replay.wire_bytes_per_min': [100 * KB, 512 * KB, 'bytes'], // 8.2 SaaS fixture; 1.0.7: 214 KB
  'replay.segments_per_min': [3, 6, 'count'], // 8.2; 1.0.7: 3
  'flood.raw_bytes': [400 * KB, 12 * 1024 * KB, 'bytes'], // 5.5: 64 KB/s over 5 s plus 25%; 1.0.7: 6.3 MB
  'heavy.snapshot_wire_bytes': [300 * KB, 1600 * KB, 'bytes'], // B1: gzip of the 1.0.7 snapshot is 234 KB; 1.0.7: 1088 KB
  'hidden.requests': [3, 4, 'count'], // the 2026-10-03 hidden-tab loop, 12 s with polling; 1.0.7: 2
};

const show = (value, unit) => (unit === 'bytes' ? kb(value) : String(value));

// Replay pipeline budgets apply from the replay chunk v2 (WP 2.1); the rest from the 2.0 core.
const REPLAY_V2 = new Set(['replay.wire_bytes_per_min', 'replay.segments_per_min', 'flood.raw_bytes', 'heavy.snapshot_wire_bytes']);

// 2.0 targets the 2.0 core misses, until the decision they name is made.
const GAPS_V2 = {
  'core.gzip_bytes': 'the 2.0 core measures about 25 KB: the 5.2 estimate of 18 KB left out stack parsing, resource timing and the URL minimiser (decision: raise the 5.2 budget or cut features)',
};

// Checks a measurement against this SDK's limit and prints the 2.0 target beside it.
export function budget(ledger, key, actual, { detail = '' } = {}) {
  const [target, legacy, unit] = TARGETS[key];
  const v2 = REPLAY_V2.has(key) ? SDK.replayV2 : SDK.v2;
  const limit = v2 ? target : legacy;
  const note = v2 ? `target ${show(target, unit)}` : `1.x limit ${show(legacy, unit)}, 2.0 target ${show(target, unit)}`;
  const why = SDK.v2 && !REPLAY_V2.has(key) ? GAPS_V2[key] : undefined;
  return ledger.check(key, actual <= limit, { gap: !!why, why, detail: `${show(actual, unit)} (${note})${detail ? `; ${detail}` : ''}` });
}
