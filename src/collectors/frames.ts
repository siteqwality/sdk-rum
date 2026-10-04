// Long animation frames with script attribution (design 5.6), long tasks where LoAF is missing.
import { ANALYZE, type Hub } from '../hub';
import { epochOf, round, cut, read, observe } from '../core/util';

const MAX_PER_PAGE = 200;

interface LoafScript {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  invokerType?: string;
  startTime: number;
  duration: number;
}

export interface Loaf extends PerformanceEntry {
  blockingDuration?: number;
  styleAndLayoutStart?: number;
  scripts?: LoafScript[];
}

/** The last 50 long animation frames, for INP script attribution. */
export const recentFrames: Loaf[] = [];

export function startFrames(h: Hub): void {
  let sent = 0;
  const loaf = !!read(() => PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'));
  // Long animation frames, else long tasks.
  observe(loaf ? 'long-animation-frame' : 'longtask', (list) => {
    for (const e of list as Loaf[]) {
      if (loaf && recentFrames.push(e) > 50) recentFrames.shift();
      if (sent++ >= MAX_PER_PAGE) continue;
      const scripts = (e.scripts || [])
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map((s) => ({
          url: s.sourceURL ? h.url(s.sourceURL) : '',
          fn: cut(s.sourceFunctionName || '', 128),
          invoker: cut(h.text(s.invoker || ''), 256),
          invoker_type: s.invokerType || '',
          duration_ms: round(s.duration),
        }));
      h.emit(
        {
          k: 'long_frame',
          t: epochOf(e.startTime),
          view_id: h.viewId(),
          duration_ms: round(e.duration),
          blocking_ms: round(loaf ? e.blockingDuration ?? 0 : Math.max(0, e.duration - 50)),
          ...(e.styleAndLayoutStart ? { style_layout_ms: round(e.startTime + e.duration - e.styleAndLayoutStart) } : {}),
          ...(scripts.length ? { scripts } : {}),
        },
        ANALYZE,
      );
    }
  });
}
