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
import {
  createUrlSanitizer,
  createTextUrlSanitizer,
  type UrlSanitizer,
  type TextUrlSanitizer,
} from './privacy/url';

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

  // Errors and actions seen since the last measure was emitted. Measures carry a
  // DELTA, not a running total, because the server sums this column both per
  // session and across the whole application, so a cumulative value would be
  // counted once per measure. Read and reset together by takeCountsSinceLastMeasure.
  private errorsSinceLastMeasure = 0;
  private actionsSinceLastMeasure = 0;

  /**
   * Strips the fragment, the query string and any credentials from every URL
   * before it is enqueued. Built as the first statement of `start()` so no
   * collector can be wired up before it exists.
   */
  private sanitizeUrl: UrlSanitizer = createUrlSanitizer();

  /**
   * The same reduction, applied to the URLs embedded in a free-text field: an
   * error message, a stack trace, a script filename. Always built from
   * `sanitizeUrl`, so the two can never apply different rules.
   */
  private sanitizeText: TextUrlSanitizer = createTextUrlSanitizer(
    this.sanitizeUrl,
  );

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

  /**
   * Report a handcaught error. `context` is attached to the event's
   * custom_attributes; on key collision the per-call context wins over
   * ambient global attributes.
   *
   * The message and the stack are URL-minimised here, exactly as
   * `startErrorCollector` does for browser-raised errors, because this is the
   * other route that constructs a `CollectedError`.
   */
  static addError(error: Error, context?: Record<string, string>): void {
    const inst = SiteQwalityRUM.instance;
    if (!inst) return;
    inst.handleError(
      {
        message: inst.sanitizeText(error.message),
        source: 'custom',
        stack: inst.sanitizeText(error.stack || ''),
      },
      context,
    );
  }

  /**
   * Record a custom user action. `context` is attached to the event's
   * custom_attributes; on key collision the per-call context wins over
   * ambient global attributes.
   */
  static addAction(name: string, context?: Record<string, string>): void {
    const inst = SiteQwalityRUM.instance;
    if (!inst) return;
    inst.handleAction(
      {
        action_type: 'custom',
        action_target: name,
      },
      context,
    );
  }

  private async start(options: RumConfig): Promise<void> {
    this.options = options;
    // Built before anything else in start(): every collector below captures a
    // URL, and a collector wired up before the sanitiser exists would send raw
    // hrefs for the life of the page.
    this.sanitizeUrl = createUrlSanitizer({
      allowedQueryParams: options.allowedQueryParams,
      deniedQueryParams: options.deniedQueryParams,
    });
    this.sanitizeText = createTextUrlSanitizer(this.sanitizeUrl);
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

  /**
   * Drain the errors and actions counted since the previous measure.
   *
   * Every measure a session emits carries one of these, so summing the column
   * over a session yields the session total and summing it over an application
   * yields the application total. The tail of a session is covered by web-vitals
   * finalizing CLS and INP when the page is hidden, which emits a last measure
   * carrying whatever happened after the previous one.
   */
  private takeCountsSinceLastMeasure(): {
    error_count: number;
    action_count: number;
  } {
    const counts = {
      error_count: this.errorsSinceLastMeasure,
      action_count: this.actionsSinceLastMeasure,
    };
    this.errorsSinceLastMeasure = 0;
    this.actionsSinceLastMeasure = 0;
    return counts;
  }

  private startCollectors(): void {
    // Views: always active, updates current view
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
        ...this.takeCountsSinceLastMeasure(),
        resource_count: 0,
      };
      this.measureTransport.enqueue(measure);
    }, this.sanitizeUrl);

    // Web Vitals are lightweight, so they are always sent as measures
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
        url: this.currentUrl(),
        [name]: value,
        ...this.takeCountsSinceLastMeasure(),
        resource_count: 0,
      };
      this.measureTransport.enqueue(measure);
    });

    // Errors are always tracked: the count goes to measures, the detail only if
    // sampling is active. The collector is handed the text sanitiser because it
    // constructs the CollectedError, and a CollectedError is minimised by
    // whoever builds it.
    startErrorCollector((error) => this.handleError(error), this.sanitizeText);

    // Resources are detail only, activated by sampling
    startResourceCollector(
      (resource) => this.handleResource(resource),
      this.sanitizeUrl,
    );

    // Actions: the count is always tracked, the detail only if sampling is
    // active
    startActionCollector((action) => this.handleAction(action));

    // Long tasks are detail only
    startLongTaskCollector((durationMs) => this.handleLongTask(durationMs));
  }

  private handleError(
    error: CollectedError,
    context?: Record<string, string>,
  ): void {
    this.sessionState.hasError = true;
    this.sessionState.errorCount++;
    this.errorsSinceLastMeasure++;

    // Always send errors to the error endpoint for fingerprinting.
    //
    // `error.message` and `error.stack` are already URL-minimised: both routes
    // that build a CollectedError do it (see `collectors/errors.ts`). They are
    // not re-sanitised here, so there is exactly one place per route that has to
    // be right, and `error.filename` is deliberately not part of this payload.
    const errorEvent: RumErrorEvent = {
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: this.currentUrl(),
      error_message: error.message,
      error_source: error.source,
      error_stack: error.stack,
      version: this.options.version,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      // Per-call context wins over ambient global attributes on collision
      custom_attributes: { ...this.context.getGlobalAttributes(), ...context },
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
      url: this.currentUrl(),
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

  private handleAction(
    action: CollectedAction,
    context?: Record<string, string>,
  ): void {
    // Counted before the detail-sampling gate below: the count belongs on the
    // measure for every session, while the action's detail row is only recorded
    // for sessions a filter has latched onto.
    this.sessionState.actionCount++;
    this.actionsSinceLastMeasure++;

    if (!this.detailActive) return;

    const event: RumDetailEvent = {
      type: 'action',
      session_id: this.session.getSessionId(),
      view_id: this.currentViewId,
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      url: this.currentUrl(),
      action_type: action.action_type,
      action_target: action.action_target,
      frustration: action.frustration,
      user_id: this.context.getUser().id,
      user_email: this.context.getUser().email,
      // Per-call context wins over ambient global attributes on collision
      custom_attributes: { ...this.context.getGlobalAttributes(), ...context },
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
      url: this.currentUrl(),
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

  /** The current page URL, minimised. Never the raw `location.href`. */
  private currentUrl(): string {
    return this.sanitizeUrl(window.location.href);
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
      this.sanitizeUrl,
    );
  }
}
