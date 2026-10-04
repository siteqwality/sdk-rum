// What collectors see of the SDK instance.
import type { InitOptions, SdkConfig, SqEvent, SqEventKind } from './types';
import type { UrlSanitizer, TextUrlSanitizer } from './core/url';
import type { Scrub } from './core/sanitize';
import type { RuleInput } from './core/rules';

export const OBSERVE = 0;
export const ANALYZE = 1;
export type Tier = typeof OBSERVE | typeof ANALYZE;

export interface EmitOptions {
  /** beforeSend kind; events without one skip the hook. */
  kind?: SqEventKind;
  /** The session the event belongs to (a view's, a vital's); default the current one. */
  sid?: string;
  /** Start a new session when the current one expired; otherwise the event is dropped. */
  rotate?: boolean;
  /** Flush within a second (errors). */
  urgent?: boolean;
}

export interface Hub {
  readonly opts: InitOptions;
  cfg(): SdkConfig;
  url: UrlSanitizer;
  /** Minimises the URLs inside free text. */
  text: TextUrlSanitizer;
  /** PII patterns of the privacy level, as tokens. */
  scrub: Scrub;
  /** False when the event was dropped (opted out, consent, sampling, beforeSend). */
  emit(e: SqEvent, tier: Tier, o?: EmitOptions): boolean;
  input(i: RuleInput): void;
  crumb(k: string, msg: string, data?: Record<string, unknown>): void;
  count(name: string, n?: number): void;
  isOwn(url: string): boolean;
  /** The current page URL, minimised. */
  pageUrl(): string;
  viewId(): string;
}
