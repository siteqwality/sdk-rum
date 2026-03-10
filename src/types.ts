export interface RumConfig {
  applicationId: string;
  clientToken: string;
  service?: string;
  version?: string;
  env?: string;
  /** Override the default API base URL */
  apiBase?: string;
  /** Override the default ingestion base URL */
  ingestBase?: string;
  /** Override the default replay ingestion base URL */
  replayBase?: string;
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
