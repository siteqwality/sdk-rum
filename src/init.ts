import type {
  RumConfig,
  RumMeasureEvent,
  RumDetailEvent,
  RumErrorEvent,
  ViewEvent,
  UserContext,
} from './types';
import { SessionManager } from './session';
import { ConfigManager } from './config';
import { ContextManager } from './context';
import { TransportManager } from './transport';
import { startVitalsCollector } from './collectors/vitals';
import { startViewCollector } from './collectors/views';
import {
  startErrorCollector,
  type CollectedError,
} from './collectors/errors';
import {
  startResourceCollector,
  type CollectedResource,
} from './collectors/resources';
import {
  startActionCollector,
  type CollectedAction,
} from './collectors/actions';
import { startLongTaskCollector } from './collectors/long-tasks';
import { ReplayRecorder } from './replay/recorder';
import { ReplayTransport } from './replay/transport';
import {
  evaluateFilters,
  type SessionState,
} from './sampling/evaluator';

const DEFAULT_INGEST_BASE = 'https://rum.siteqwality.com';
const DEFAULT_REPLAY_BASE = 'https://replay.siteqwality.com';
const FLUSH_INTERVAL_MS = 10_000;
const SAMPLING_EVAL_INTERVAL_MS = 5_000;

export class SiteQwalityRUM {
  private static instance: SiteQwalityRUM | null = null;

  private session!: SessionManager;
  private config!: ConfigManager;
  private context!: ContextManager;
  private measureTransport!: TransportManager;
  private eventTransport!: TransportManager;
  private errorTransport!: TransportManager;
  private replayRecorder: ReplayRecorder | null = null;
  private replayTransport: ReplayTransport | null = null;

  private currentViewId = '';
  private sessionState: SessionState = {
    hasError: false,
    errorCount: 0,
    pageCount: 0,
    actionCount: 0,
  };

  private detailActive = false;
  private replayActive = false;
  private samplingTimer: ReturnType<typeof setInterval> | null = null;
  private options!: RumConfig;

  static async init(options: RumConfig): Promise<void> {
    if (SiteQwalityRUM.instance) return;
    SiteQwalityRUM.instance = new SiteQwalityRUM();
    try {
      await SiteQwalityRUM.instance.start(options);
    } catch (err) {
      // Monitoring must never break the host page.
      console.warn('[SiteQwality RUM] init failed', err);
    }
  }

  static setUser(user: UserContext): void {
    const inst = SiteQwalityRUM.instance;
    if (!inst) return;
    inst.context.setUser(user);
    inst.sessionState.userId = user.id;
  }

  static addError(error: Error, context?: Record<string, string>): void {
    const inst = SiteQwalityRUM.instance;
    if (!inst) return;
    inst.handleError({
      message: error.message,
      source: 'custom',
      stack: error.stack || '',
    });
  }

  static addAction(name: string, context?: Record<string, string>): void {
    const inst = SiteQwalityRUM.instance;
    if (!inst) return;
    inst.handleAction({
      action_type: 'custom',
      action_target: name,
    });
  }

  private async start(options: RumConfig): Promise<void> {
    this.options = options;
    const ingestBase = options.ingestBase || DEFAULT_INGEST_BASE;
    const replayBase = options.replayBase || DEFAULT_REPLAY_BASE;

    this.session = new SessionManager();
    this.config = new ConfigManager();
    this.context = new ContextManager(options);

    // Fetch server-side config (filters, privacy settings) from the ingest
    // host; the client token authorizes it. Falls back to safe defaults
    // internally and never throws.
    await this.config.init(
      options.applicationId,
      options.clientToken,
      ingestBase,
    );

    // Set up transports
    this.measureTransport = new TransportManager(
      `${ingestBase}/v1/measure`,
      options.clientToken,
      FLUSH_INTERVAL_MS,
    );
    this.eventTransport = new TransportManager(
      `${ingestBase}/v1/events`,
      options.clientToken,
      FLUSH_INTERVAL_MS,
    );
    this.errorTransport = new TransportManager(
      `${ingestBase}/v1/errors`,
      options.clientToken,
      FLUSH_INTERVAL_MS,
    );

    // Set up replay
    this.replayRecorder = new ReplayRecorder();
    this.replayTransport = new ReplayTransport(
      `${replayBase}/v1/segments`,
      options.clientToken,
    );

    // Start all collectors
    this.startCollectors();

    // Periodically evaluate sampling rules
    this.samplingTimer = setInterval(() => {
      this.evaluateSampling();
    }, SAMPLING_EVAL_INTERVAL_MS);
  }

  private startCollectors(): void {
    // Views — always active, updates current view
    startViewCollector((view) => {
      this.currentViewId = view.view_id;
      this.sessionState.pageCount++;

      const measure: RumMeasureEvent = {
        type: 'view',
        session_id: this.session.getSessionId(),
        view_id: view.view_id,
        timestamp: view.timestamp,
        url: view.url,
        load_time_ms: view.load_time_ms,
        dom_ready_ms: view.dom_ready_ms,
        error_count: 0,
        action_count: 0,
        resource_count: 0,
      };
      this.measureTransport.enqueue(measure);
    });

    // Web Vitals — lightweight, always sent as measures
    startVitalsCollector((name, value) => {
      // Update session state for sampling evaluation
      if (name === 'lcp_ms') this.sessionState.lcpMs = value;
      if (name === 'fcp_ms') this.sessionState.fcpMs = value;
      if (name === 'cls') this.sessionState.cls = value;

      const measure: RumMeasureEvent = {
        type: 'vital',
        session_id: this.session.getSessionId(),
        view_id: this.currentViewId,
        timestamp: Date.now(),
        url: window.location.href,
        [name]: value,
        error_count: 0,
        action_count: 0,
        resource_count: 0,
      };
      this.measureTransport.enqueue(measure);
    });

    // Errors — always tracked (count goes to measures, detail if sampling active)
    startErrorCollector((error) => this.handleError(error));

    // Resources — detail only (activated by sampling)
    startResourceCollector((resource) => this.handleResource(resource));

    // Actions — count always tracked, detail if sampling active
    startActionCollector((action) => this.handleAction(action));

    // Long tasks — detail only
    startLongTaskCollector((durationMs) => this.handleLongTask(durationMs));
  }

  private handleError(error: CollectedError): void {
    this.sessionState.hasError = true;
    this.sessionState.errorCount++;

    // Always send errors to the error endpoint for fingerprinting
    const errorEvent: RumErrorEvent = {
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: window.location.href,
      error_message: error.message,
      error_source: error.source,
      error_stack: error.stack,
      version: this.options.version,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      custom_attributes: this.context.getGlobalAttributes(),
    };
    this.errorTransport.enqueue(errorEvent);
  }

  private handleResource(resource: CollectedResource): void {
    if (!this.detailActive) return;

    const event: RumDetailEvent = {
      type: 'resource',
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: window.location.href,
      resource_type: resource.resource_type,
      resource_url: resource.resource_url,
      duration_ms: resource.duration_ms,
      transfer_size: resource.transfer_size,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      custom_attributes: this.context.getGlobalAttributes(),
    };
    this.eventTransport.enqueue(event);
  }

  private handleAction(action: CollectedAction): void {
    this.sessionState.actionCount++;

    if (!this.detailActive) return;

    const event: RumDetailEvent = {
      type: 'action',
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: window.location.href,
      action_type: action.action_type,
      action_target: action.action_target,
      frustration: action.frustration,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      custom_attributes: this.context.getGlobalAttributes(),
    };
    this.eventTransport.enqueue(event);
  }

  private handleLongTask(durationMs: number): void {
    if (!this.detailActive) return;

    const event: RumDetailEvent = {
      type: 'long_task',
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: window.location.href,
      long_task_duration_ms: durationMs,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      custom_attributes: this.context.getGlobalAttributes(),
    };
    this.eventTransport.enqueue(event);
  }

  private evaluateSampling(): void {
    const config = this.config.getConfig();
    if (!config) return;

    const { captureDetail, captureReplay } = evaluateFilters(
      config.filters,
      this.sessionState,
    );

    // Activate detail collection if a filter matches (one-way: once on, stays on)
    if (captureDetail && !this.detailActive) {
      this.detailActive = true;
    }

    // Activate replay if a filter with capture_replay matches
    if (captureReplay && !this.replayActive) {
      this.replayActive = true;
      this.startReplay(config.settings.privacy);
    }
  }

  private async startReplay(privacy: {
    mask_inputs: boolean;
    mask_text: boolean;
  }): Promise<void> {
    if (!this.replayRecorder || !this.replayTransport) return;

    const sessionId = this.session.getSessionId();
    await this.replayRecorder.start(
      (segment) => {
        this.replayTransport!.sendSegment(sessionId, segment);
      },
      { maskInputs: privacy.mask_inputs, maskText: privacy.mask_text },
    );
  }
}
