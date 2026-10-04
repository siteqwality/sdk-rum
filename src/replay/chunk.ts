// The lazy replay chunk (design 5.2): rrweb, the segmenter and its transport. SDK 2.0.0 sends
// segments to /v1/segments; WP 2.1 adds the replay ring, gzip and /v2/segments behind this API.
import { record } from '@rrweb/record';
import { ReplayRecorder, type ReplayPrivacy, type ReplayState } from './recorder';
import { ReplayTransport } from './transport';
import type { UrlSanitizer } from '../core/url';
import type { SdkConfig } from '../types';

export interface ReplayStartOptions {
  /** 'stream' records and sends; 2.1 adds 'buffer' (the 60 s ring flushed on a rule match). */
  mode: 'stream';
  sessionId: string;
  replayBase: string;
  token: string;
  fetch: typeof fetch;
  url: UrlSanitizer;
  text: (s: string) => string;
  privacy: SdkConfig['privacy'];
  /** PII patterns masked with `*`. */
  mask: (s: string) => string;
  onStatus: (state: ReplayState, reason?: string) => void;
}

export interface ReplayHandle {
  stop(): void;
  pause(reason: string): void;
  resume(): void;
}

const STRICT_MEDIA = ['img', 'video', 'audio', 'picture', 'svg'];

function valid(list: string[]): string | undefined {
  const probe = document.createElement('div');
  return (
    list
      .filter((s) => {
        try {
          probe.matches(s);
          return true;
        } catch {
          return false;
        }
      })
      .join(',') || undefined
  );
}

/** rrweb privacy from the app's level and selectors (design 7.1); block selectors always win. */
export function replayPrivacy(p: SdkConfig['privacy'], mask: (s: string) => string): ReplayPrivacy {
  const strict = p.level === 'strict';
  return {
    maskInputs: p.level !== null || p.mask_inputs,
    maskAllText: strict || p.mask_text,
    maskSelector: valid(p.mask_selectors),
    unmaskSelector: strict ? valid(p.unmask_selectors) : undefined,
    blockSelector: valid([...p.block_selectors, ...(strict ? STRICT_MEDIA : [])]) ?? '',
    ignoreSelector: valid(p.ignore_input_selectors),
    scrub: p.pii_patterns.length ? mask : undefined,
  };
}

export function startReplay(o: ReplayStartOptions): ReplayHandle {
  const transport = new ReplayTransport(`${o.replayBase}/v1/segments`, o.token, o.fetch);
  const recorder = new ReplayRecorder();
  recorder.start({
    sessionId: o.sessionId,
    record,
    onSegment: (segment) => void transport.sendSegment(o.sessionId, segment),
    privacy: replayPrivacy(o.privacy, o.mask),
    url: o.url,
    text: o.text,
    onStatus: o.onStatus,
  });
  return {
    stop: () => recorder.stop(),
    pause: (reason) => recorder.pause(reason),
    resume: () => recorder.resume(),
  };
}
