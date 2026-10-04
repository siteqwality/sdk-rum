// Public types of SDK 2.0 (design 6.1) and the config v2 shape it reads (6.2).

export type Consent = 'granted' | 'pending' | 'not-granted';

export type SqEventKind = 'error' | 'view' | 'action' | 'custom' | 'network' | 'console';

/** One event as sent to `/v2/batch` (design 6.3): `k` is its kind, `t` epoch ms. */
export interface SqEvent {
  k: string;
  t: number;
  view_id?: string;
  id?: string;
  [field: string]: unknown;
}

export interface InitOptions {
  applicationId: string;
  clientToken: string;
  /** Sent on every event. */
  service?: string;
  /** Sent on every event, e.g. 'production'. */
  env?: string;
  /** Your release; sent on every event and matched to source maps. */
  version?: string;
  /** Default 'granted'. 'pending' collects in memory and sends or stores nothing. */
  trackingConsent?: Consent;
  /** Where the session lives. Default 'cookie' (shared by tabs). */
  persistence?: 'cookie' | 'localStorage' | 'memory';
  /** Shares the session cookie across subdomains, e.g. 'example.com'. */
  cookieDomain?: string;
  /** One view per `#/route`. Default false. */
  hashRouting?: boolean;
  /** Query parameters kept on captured URLs (a deny list still applies). */
  allowedQueryParams?: string[];
  /** Query parameters always removed, on top of the built-in deny list. */
  deniedQueryParams?: string[];
  /** Errors not to send: a substring of the message, or a RegExp tested against it. */
  ignoreErrors?: Array<string | RegExp>;
  /** Errors whose top frame URL matches are not sent. */
  denyUrls?: Array<string | RegExp>;
  /** Last look at an event: false or null drops it (views cannot be dropped), an object replaces it. */
  beforeSend?: (event: SqEvent, kind: SqEventKind) => SqEvent | false | null | void;
  /** Route name for a path, e.g. '/users/:id'. */
  routeName?: (path: string) => string | undefined;
  /** First-party proxy bases. */
  ingestBase?: string;
  replayBase?: string;
  configBase?: string;
  /** CDN build: where the session replay recorder is loaded from. */
  recorderUrl?: string;
  /** Logs config, rule decisions, recording state and transport outcomes to the console. */
  debug?: boolean;
}

/** @deprecated Use `InitOptions`. */
export type RumConfig = InitOptions;

export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
  /** String values, at most 20 keys. */
  traits?: Record<string, string>;
}

export interface SdkStatus {
  session_id: string;
  window_id: string;
  consent: Consent;
  opted_out: boolean;
  sampled: { analyze: boolean; replay: boolean; rule_id?: string };
  recording: 'off' | 'buffering' | 'recording' | 'paused' | 'stopped';
  reason?: string;
  sdk_version: string;
  config_revision?: number;
  dropped: Record<string, number>;
}

export interface RuleCondition {
  kind: string;
  [field: string]: unknown;
}

export interface RecordingRule {
  id: string;
  capture: 'analyze' | 'replay';
  sample_rate: number;
  auto?: boolean;
  conditions: RuleCondition[];
  min_duration_ms: number;
  require_interaction: boolean;
}

/** Config v2 after normalisation: every field present. */
export interface SdkConfig {
  v: 2;
  application_id: string;
  revision?: number;
  status: 'active' | 'paused';
  observe: { sample_rate: number };
  rules: RecordingRule[];
  privacy: {
    level: 'strict' | 'balanced' | 'relaxed' | null;
    mask_inputs: boolean;
    mask_text: boolean;
    hide_action_text: boolean;
    mask_selectors: string[];
    unmask_selectors: string[];
    block_selectors: string[];
    ignore_input_selectors: string[];
    pii_patterns: string[];
    never_record_urls: string[];
    require_consent: boolean;
    honor_gpc: boolean;
    cookieless: boolean;
    capture_user_email: boolean;
  };
  capture: {
    resource_exclusions: string[];
    network: { header_allowlist: string[]; body_urls: string[]; trace_urls: string[]; max_body_bytes: number };
    console: string[];
    errors: { ignore: string[]; deny_urls: string[]; suppressed_keys: number[] };
    frustration_ignore_selectors: string[];
  };
  limits: { idle_pause_ms: number; session_max_ms: number; dnr: boolean };
}
