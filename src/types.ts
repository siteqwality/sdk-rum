export interface RumConfig {
  applicationId: string;
  clientToken: string;
  service?: string;
  version?: string;
  env?: string;
  /**
   * @deprecated No longer used. Remote config is fetched from `ingestBase`
   * (`GET {ingestBase}/v1/config`); kept only for backwards compatibility.
   */
  apiBase?: string;
  /** Override the default ingestion base URL */
  ingestBase?: string;
  /** Override the default replay ingestion base URL */
  replayBase?: string;
  /**
   * Query parameter names to keep on captured URLs.
   *
   * Every URL the SDK sends (page views, subresources, fetch/XHR, the page URL
   * embedded in a replay segment, and the URLs inside an error message or stack
   * trace) has its fragment and its whole query string removed by default,
   * because those are where tokens, session ids, email addresses and search
   * terms live and the data is retained for months. Name a parameter here to
   * opt it back in, for example `['plan', 'tab']`.
   *
   * A deny list still applies to anything named here: see
   * `DEFAULT_DENIED_QUERY_PARAMS`. It cannot be switched off.
   *
   * **What this changes, precisely.** It changes what leaves the browser. It
   * does not decide what is stored for most fields: the ingestor re-applies the
   * strict default with no allow list (it cannot tell an allowed parameter from
   * a stale bundle sending everything) to the view URL, `resource_url`,
   * `error_message` and `error_stack`, so a parameter named here is removed
   * again server-side for those. The one field where an allowed parameter is
   * stored as sent is the page URL inside a session-replay segment, which the
   * server stores byte for byte.
   */
  allowedQueryParams?: string[];
  /**
   * Extra query parameter names to refuse, on top of the built-in deny list.
   * Only useful alongside `allowedQueryParams`.
   */
  deniedQueryParams?: string[];
}

export interface RumMeasureEvent {
  type: 'view' | 'action' | 'vital';
  session_id: string;
  view_id: string;
  timestamp: number;
  url: string;
  lcp_ms?: number;
  fcp_ms?: number;
  cls?: number;
  inp_ms?: number;
  ttfb_ms?: number;
  load_time_ms?: number;
  dom_ready_ms?: number;
  error_count: number;
  action_count: number;
  resource_count: number;
}

export interface RumDetailEvent {
  type: 'view' | 'resource' | 'error' | 'action' | 'long_task';
  session_id: string;
  view_id: string;
  event_id: string;
  timestamp: number;
  url: string;
  resource_type?: string;
  resource_url?: string;
  duration_ms?: number;
  transfer_size?: number;
  error_message?: string;
  error_source?: string;
  error_stack?: string;
  action_type?: string;
  action_target?: string;
  frustration?: string;
  long_task_duration_ms?: number;
  user_id?: string;
  user_email?: string;
  custom_attributes?: Record<string, string>;
}

export interface RumErrorEvent {
  session_id: string;
  view_id: string;
  event_id: string;
  timestamp: number;
  url: string;
  error_message: string;
  error_source: string;
  error_stack: string;
  version?: string;
  user_id?: string;
  user_email?: string;
  custom_attributes?: Record<string, string>;
}

export interface SessionFilterRule {
  filter_type: string;
  conditions: Record<string, unknown>;
  capture_replay: boolean;
}

export interface SdkConfig {
  application_id: string;
  filters: SessionFilterRule[];
  settings: {
    privacy: {
      mask_inputs: boolean;
      mask_text: boolean;
    };
  };
}

export interface ViewEvent {
  view_id: string;
  url: string;
  timestamp: number;
  load_time_ms?: number;
  dom_ready_ms?: number;
}

export interface UserContext {
  id?: string;
  email?: string;
  name?: string;
}
