// Web Vitals with attribution (design 5.6), ported from web-vitals 5 to fit the core budget:
// the same metric definitions, finalisation rules and attribution sub-parts.
import type { Hub } from '../hub';
import { round, read, on, observe, navEntry as nav } from '../core/util';
import { recentFrames } from './frames';
import { selectorOf } from './actions';

export type VitalSink = (fields: Record<string, unknown>, metric: string, value: number) => void;

interface Shift extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
  sources?: Array<{ node?: Node | null }>;
}
interface Timing extends PerformanceEntry {
  interactionId?: number;
  processingStart: number;
  processingEnd: number;
  target?: Node | null;
}
interface Lcp extends PerformanceEntry {
  element?: Element | null;
  url?: string;
}

/** Attribution targets use the action selector: stable across deploys, unlike hashed classes. */
export const selector = (node: Node | null | undefined): string | undefined =>
  node?.nodeType === 1 ? selectorOf(node as Element) || undefined : undefined;

export function startVitals(h: Hub, sink: VitalSink): void {
  const start = () => {
    const activation = nav()?.activationStart || 0;
    let firstHidden = document.visibilityState === 'hidden' ? 0 : Infinity;
    const hiddenCbs: Array<() => void> = [];
    on(window, 'visibilitychange', (e: Event) => {
      if (document.visibilityState !== 'hidden') return;
      firstHidden = Math.min(firstHidden, e.timeStamp);
      for (const cb of hiddenCbs) cb();
    });

    // FCP
    const fcp = observe('paint', (list) => {
      for (const e of list) {
        if (e.name !== 'first-contentful-paint') continue;
        fcp?.disconnect();
        if (e.startTime < firstHidden) {
          const v = Math.max(e.startTime - activation, 0);
          sink({ fcp_ms: round(v) }, 'fcp', v);
        }
      }
    });

    // TTFB, once the page has loaded.
    const ttfb = () => {
      const n = nav();
      if (n && n.responseStart > 0) {
        const v = Math.max(n.responseStart - activation, 0);
        sink({ ttfb_ms: round(v) }, 'ttfb', v);
      }
    };
    if (document.readyState === 'complete') setTimeout(ttfb);
    else on(window, 'load', () => setTimeout(ttfb), { once: true });

    // LCP, final at the first trusted key or click, or when hidden.
    let lcp: Lcp | undefined;
    let lcpTarget: string | undefined;
    const lcpPo = observe('largest-contentful-paint', (list) => {
      const e = list[list.length - 1] as Lcp | undefined;
      if (e && e.startTime < firstHidden) {
        lcp = e;
        lcpTarget = selector(e.element);
      }
    });
    let lcpDone = false;
    const finishLcp = () => {
      if (lcpDone || !lcpPo) return;
      lcpDone = true;
      const last = lcpPo.takeRecords().pop() as Lcp | undefined;
      if (last && last.startTime < firstHidden) {
        lcp = last;
        lcpTarget = selector(last.element);
      }
      lcpPo.disconnect();
      if (!lcp) return;
      const value = Math.max(lcp.startTime - activation, 0);
      const n = nav();
      const res = lcp.url ? (read(() => performance.getEntriesByName(lcp!.url!, 'resource')[0]) as PerformanceResourceTiming | undefined) : undefined;
      const first = Math.max(0, (n?.responseStart ?? 0) - activation);
      const reqStart = Math.max(first, res ? (res.requestStart || res.startTime) - activation : 0);
      const resEnd = Math.min(value, Math.max(reqStart, res ? res.responseEnd - activation : 0));
      sink(
        {
          lcp_ms: round(value),
          lcp: {
            target: lcpTarget,
            resource_url: lcp.url ? h.url(lcp.url) : undefined,
            load_delay_ms: round(reqStart - first),
            load_time_ms: round(resEnd - reqStart),
            render_delay_ms: round(value - resEnd),
          },
        },
        'lcp',
        value,
      );
    };
    for (const type of ['keydown', 'click']) on(window, type, (e: Event) => e.isTrusted && setTimeout(finishLcp));
    hiddenCbs.push(finishLcp);

    // CLS: the largest session window (gaps under 1 s, at most 5 s), reported on hide.
    let cls = 0;
    let clsEntries: Shift[] = [];
    let win: Shift[] = [];
    let winValue = 0;
    const clsPo = observe('layout-shift', (list) => {
      for (const e of list as Shift[]) {
        if (e.hadRecentInput) continue;
        const first = win[0];
        const last = win[win.length - 1];
        if (winValue && first && last && e.startTime - last.startTime < 1000 && e.startTime - first.startTime < 5000) {
          winValue += e.value;
          win.push(e);
        } else {
          winValue = e.value;
          win = [e];
        }
        if (winValue > cls) {
          cls = winValue;
          clsEntries = win;
        }
      }
    });
    let clsSent = -1;
    hiddenCbs.push(() => {
      if (!clsPo) return;
      clsPo.takeRecords();
      if (cls === clsSent) return;
      clsSent = cls;
      const big = clsEntries.reduce<Shift | undefined>((a, b) => (a && a.value > b.value ? a : b), undefined);
      const src = big?.sources?.find((s) => s.node?.nodeType === 1) || big?.sources?.[0];
      sink({ cls: Math.round(cls * 10000) / 10000, cls_target: selector(src?.node) }, 'cls', cls);
    });

    // INP: the p98 of the longest interactions (one per 50), reported on hide.
    const longest: Array<{ id: number; d: number; e: Timing; end: number }> = [];
    const seen = new Set<number>();
    const onEvents = (list: PerformanceEntry[]) => {
      for (const e of list as Timing[]) {
        const id = e.interactionId || (e.entryType === 'first-input' ? -1 : 0);
        if (!id) continue;
        seen.add(id);
        const known = longest.find((i) => i.id === id);
        if (known) {
          known.end = Math.max(known.end, e.processingEnd);
          if (e.duration > known.d) Object.assign(known, { d: e.duration, e });
        } else if (longest.length < 10 || e.duration > longest[longest.length - 1].d) {
          longest.push({ id, d: e.duration, e, end: e.processingEnd });
        }
        longest.sort((a, b) => b.d - a.d).splice(10);
      }
    };
    const timing = read(() => (window as { PerformanceEventTiming?: { prototype: object } }).PerformanceEventTiming?.prototype);
    const inpPo = timing && 'interactionId' in timing ? observe('event', onEvents, { durationThreshold: 40 }) : undefined;
    if (inpPo) observe('first-input', onEvents);
    let inpSent = -1;
    hiddenCbs.push(() => {
      if (!inpPo) return;
      onEvents(inpPo.takeRecords());
      const count = (performance as Performance & { interactionCount?: number }).interactionCount ?? seen.size;
      const c = longest[Math.min(longest.length - 1, Math.floor(count / 50))];
      if (!c || c.d === inpSent) return;
      inpSent = c.d;
      const e = c.e;
      const paint = Math.max(e.startTime + e.duration, e.processingStart);
      const end = Math.min(c.end, paint);
      // The longest LoAF script intersecting the interaction.
      let script: { url?: string; d: number } = { d: 0 };
      for (const f of recentFrames) {
        if (f.startTime + f.duration < e.startTime || f.startTime > end) continue;
        for (const s of f.scripts || []) {
          const d = s.startTime + s.duration - Math.max(e.startTime, s.startTime);
          if (d > script.d) script = { url: s.sourceURL, d };
        }
      }
      sink(
        {
          inp_ms: round(c.d),
          inp: {
            target: selector(e.target),
            event_type: e.name,
            input_delay_ms: round(e.processingStart - e.startTime),
            processing_ms: round(Math.max(0, end - e.processingStart)),
            presentation_ms: round(Math.max(0, paint - end)),
            script_url: script.url ? h.url(script.url) : undefined,
          },
        },
        'inp',
        c.d,
      );
    });
  };
  if ((document as Document & { prerendering?: boolean }).prerendering) on(document, 'prerenderingchange', start, { once: true });
  else start();
}
