// The lazy replay chunk (design 5.2): rrweb, the segmenter and its transport. SDK 2.0.0 sends
// segments to /v1/segments; WP 2.1 adds the replay ring, gzip and /v2/segments behind this API.
import { record } from '@rrweb/record';
import { ReplayRecorder, replayPrivacy, type ReplayState } from './recorder';
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
  /** The core's clock, so replay and RUM events share one tamper-proof time line. */
  now: () => number;
}

export interface ReplayHandle {
  stop(): void;
  pause(reason: string): void;
  resume(): void;
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
    now: o.now,
  });
  return {
    stop: () => recorder.stop(),
    pause: (reason) => recorder.pause(reason),
    resume: () => recorder.resume(),
  };
}
