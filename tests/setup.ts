// Deterministic stand-ins for browser APIs jsdom lacks or Node implements differently.
import { afterEach } from 'vitest';

type Listener = (e: { data: unknown }) => void;

/** In-process BroadcastChannel: messages reach the other channels of the same name, async. */
export class FakeBroadcastChannel {
  static all: FakeBroadcastChannel[] = [];
  onmessage: Listener | null = null;
  constructor(public name: string) {
    FakeBroadcastChannel.all.push(this);
  }
  postMessage(data: unknown): void {
    for (const c of FakeBroadcastChannel.all) {
      if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data }));
    }
  }
  close(): void {
    FakeBroadcastChannel.all = FakeBroadcastChannel.all.filter((c) => c !== this);
  }
}

/** A PerformanceObserver tests drive with `FakePerformanceObserver.emit(type, entries)`. */
export class FakePerformanceObserver {
  static supportedEntryTypes = ['resource', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input', 'paint', 'long-animation-frame', 'longtask'];
  static observers: FakePerformanceObserver[] = [];
  static buffer: Record<string, PerformanceEntry[]> = {};
  types: string[] = [];
  queue: PerformanceEntry[] = [];
  constructor(private cb: (list: { getEntries(): PerformanceEntry[] }) => void) {}
  observe(o: { type: string; buffered?: boolean }): void {
    this.types.push(o.type);
    FakePerformanceObserver.observers.push(this);
    const past = FakePerformanceObserver.buffer[o.type];
    if (o.buffered && past?.length) this.cb({ getEntries: () => past });
  }
  disconnect(): void {
    FakePerformanceObserver.observers = FakePerformanceObserver.observers.filter((x) => x !== this);
  }
  takeRecords(): PerformanceEntry[] {
    return this.queue.splice(0);
  }
  static emit(type: string, entries: Array<Partial<PerformanceEntry> & Record<string, unknown>>): void {
    const list = entries.map((e) => ({ entryType: type, name: '', startTime: 0, duration: 0, ...e })) as unknown as PerformanceEntry[];
    (FakePerformanceObserver.buffer[type] ||= []).push(...list);
    for (const o of [...FakePerformanceObserver.observers]) if (o.types.includes(type)) o.cb({ getEntries: () => list });
  }
  static reset(): void {
    FakePerformanceObserver.observers = [];
    FakePerformanceObserver.buffer = {};
  }
}

Object.assign(globalThis, { BroadcastChannel: FakeBroadcastChannel, PerformanceObserver: FakePerformanceObserver });

afterEach(() => {
  FakeBroadcastChannel.all = [];
  FakePerformanceObserver.reset();
});
