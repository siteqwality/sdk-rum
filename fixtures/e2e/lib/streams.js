// Replay segments grouped into streams: one page load of one window in one session (design 6.4).
import { expect } from '@playwright/test';
import { RRWEB } from './captures.js';

export function streams(segments) {
  const by = new Map();
  for (const g of segments) {
    const key = `${g.sessionId}|${g.windowId}|${g.pageLoadId}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(g);
  }
  for (const list of by.values()) list.sort((a, b) => a.index - b.index);
  return [...by.values()];
}

const span = (g) => {
  const ts = g.events.map((e) => e.timestamp);
  return [Math.min(...ts), Math.max(...ts)];
};

// Each stream plays alone: numbered 0..n from a Meta and a full snapshot, in time order.
export function expectPlayable(stream) {
  const [first] = stream;
  const where = `stream ${first.windowId}/${first.pageLoadId}`;
  expect(stream.map((g) => g.index), `${where}: numbered from 0 without gaps`).toEqual(stream.map((_, i) => i));
  expect(first.events.slice(0, 2).map((e) => e.type), `${where}: opens with a Meta and a full snapshot`).toEqual([RRWEB.META, RRWEB.FULL_SNAPSHOT]);
  for (let i = 1; i < stream.length; i++) {
    expect(span(stream[i])[0], `${where}: segment ${i} starts before segment ${i - 1} ends`).toBeGreaterThanOrEqual(span(stream[i - 1])[1]);
  }
  for (const g of stream) expect(g.final ? g === stream.at(-1) : true, `${where}: only the last segment is final`).toBe(true);
}

export const pathsOf = (stream) => new Set(stream.flatMap((g) => g.events.filter((e) => e.type === RRWEB.META).map((e) => new URL(e.data.href).pathname)));
export const originsOf = (stream) => new Set(stream.flatMap((g) => g.events.filter((e) => e.type === RRWEB.META).map((e) => new URL(e.data.href).origin)));
