import type {
  RumConfig,
  RumMeasureEvent,
  RumDetailEvent,
  RumErrorEvent,
  SdkConfig,
  ViewEvent,
  UserContext,
} from './types';
import { SessionManager } from './session';
import { ConfigManager } from './config';
import { ContextManager } from './context';
import { TransportManager } from './transport';
import { startVitalsCollector } from './collectors/vitals';
import {
  startViewCollector,
  pageUrl,
  type LoadTimings,
  type ViewCollector,
} from './collectors/views';
import {
  startErrorCollector,
  rawFromErrorEvent,
  rawFromRejection,
  rawFromValue,
  isRejectionEvent,
  type RawError,
} from './collectors/errors';
import {
  startResourceCollector,
  createExclusionMatcher,
  createOwnRequestMatcher,
  type CollectedResource,
} from './collectors/resources';
import {
  startActionCollector,
  type ActionCollector,
  type CollectedAction,
} from './collectors/actions';
import { startLongTaskCollector } from './collectors/long-tasks';
import { ReplayRecorder } from './replay/recorder';
import { ReplayTransport } from './replay/transport';
import { evaluateFilters, type SessionState } from './sampling/evaluator';
import { loadDecision, saveDecision } from './sampling/decision';
import {
  isBrowserNoise,
  normalizeErrorMessage,
  createIgnoreErrorsMatcher,
  ErrorRateLimiter,
  rateLimitKey,
  MAX_ERRORS_PER_PAGE,
  type IgnoreErrorsMatcher,
} from './errors/filter';
import {
  createUrlSanitizer,
  createTextUrlSanitizer,
  type UrlSanitizer,
  type TextUrlSanitizer,
} from './privacy/url';
import { uuid } from './uuid';

const DEFAULT_INGEST_BASE = 'https://rum.siteqwality.com';
const DEFAULT_REPLAY_BASE = 'https://replay.siteqwality.com';
const FLUSH_INTERVAL_MS = 10_000;

/** Detail events held until the remote config says whether to keep them. */
export const PRE_CONFIG_BUFFER_MAX = 500;

/** User input refreshes session activity at most this often. */
export const INPUT_ACTIVITY_THROTTLE_MS = 5_000;

/** Snippet-captured errors held until init runs. */
const EARLY_ERRORS_MAX = 100;

/** Sessions whose not-yet-sent error and action counts are kept apart. */
const MAX_COUNTED_SESSIONS = 4;

interface ViewRef {
  session_id: string;
  view_id: string;
  url: string;
}

interface ActionContext extends ViewRef {
  timestamp: number;
}

interface PendingCounts {
  errors: number;
  actions: number;
  /** Where and when the last one happened, for a counts-only measure. */
  view_id: string;
  url: string;
  at: number;
}

interface BufferedDetail {
  event: RumDetailEvent;
  hiddenTarget?: string;
}

interface EarlyError {
  raw: RawError;
  timestamp: number;
}

export class SiteQwalityRUM {
  private static instance: SiteQwalityRUM | null = null;

  /** @internal Marks the loaded SDK, so a second copy of the CDN script does nothing. */
  static readonly __sq = true;

  private static earlyErrors: EarlyError[] = [];
  private static detachEarly: (() => void) | null = null;

  private options!: RumConfig;
  private session!: SessionManager;
  private config!: ConfigManager;
  private context!: ContextManager;
  private measureTransport!: TransportManager;
  private eventTransport!: TransportManager;
  private errorTransport!: TransportManager;
  private replayRecorder: ReplayRecorder | null = null;
  private replayTransport: ReplayTransport | null = null;
  private views: ViewCollector | null = null;
  private actions: ActionCollector | null = null;
  private started = false;

  private currentViewId = '';
  /** The document's first view: Web Vitals and load timings always belong to it. */
  private initialView: ViewRef | null = null;
  private sessionState: SessionState = freshSessionState();

  // Per session, errors and actions since its last measure: a delta, because the
  // server sums the column per session and across the application.
  private pendingCounts = new Map<string, PendingCounts>();

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

  private configReady = false;
  private detailActive = false;
  private replayActive = false;
  // A stored decision resumes only with a config from the server, whose privacy
  // settings apply; the fallback defaults never turn detail or replay on.
  private resumeDetail = false;
  private resumeReplay = false;
  private preConfig: BufferedDetail[] = [];
  private emittingView = false;
  private lastInputAt = 0;

  private ignoreErrors: IgnoreErrorsMatcher = () => false;
  private errorLimiter = new ErrorRateLimiter();
  private errorsSent = 0;
  private inBeforeSend = false;

  /** Starts collecting before it returns. The promise resolves once the remote
   * config is applied or has failed; it never rejects. */
  static init(options: RumConfig): Promise<void> {
    try {
      if (SiteQwalityRUM.instance) return Promise.resolve();
      if (!isValidOptions(options)) {
        console.warn('[SiteQwality RUM] init needs an applicationId and a clientToken');
        return Promise.resolve();
      }
      const inst = new SiteQwalityRUM();
      SiteQwalityRUM.instance = inst;
      return inst.start(options).catch(warnInitFailed);
    } catch (err) {
      warnInitFailed(err);
      return Promise.resolve();
    }
  }

  /** The id and email are sent with every event, measures included. */
  static setUser(user: UserContext): void {
    SiteQwalityRUM.call((inst) => inst.setUserContext(user));
  }

  /**
   * Adds a string to custom_attributes on later error and detail events.
   * Caps: 50 keys, 128-char keys, 1024-char values (cut), 4 KB in all;
   * bad input or a set past the caps is ignored.
   */
  static setGlobalAttribute(key: string, value: string): void {
    SiteQwalityRUM.call((inst) => inst.context.setGlobalAttribute(key, value));
  }

  static removeGlobalAttribute(key: string): void {
    SiteQwalityRUM.call((inst) => inst.context.removeGlobalAttribute(key));
  }

  /** Report a handled error; a non-Error is sent as `String(value)` with no stack.
   * `context` goes to custom_attributes and wins over global attributes. */
  static addError(error: unknown, context?: Record<string, string>): void {
    SiteQwalityRUM.call((inst) =>
      inst.handleError(rawFromValue(error), Date.now(), context),
    );
  }

  /**
   * Record a custom user action. `context` is attached to the event's
   * custom_attributes; on key collision the per-call context wins over
   * ambient global attributes.
   */
  static addAction(name: string, context?: Record<string, string>): void {
    SiteQwalityRUM.call((inst) => inst.addCustomAction(name, context));
  }

  /** @internal An error or rejection event the CDN snippet caught before this
   * script loaded, sent with the time it happened. */
  static _captureEarly(event: unknown): void {
    try {
      const raw = isRejectionEvent(event)
        ? rawFromRejection(event)
        : rawFromErrorEvent(event);
      if (!raw) return;
      const timestamp = eventTime(event);
      const inst = SiteQwalityRUM.instance;
      if (inst?.started) {
        inst.guard(() => inst.handleError(raw, timestamp));
      } else if (SiteQwalityRUM.earlyErrors.length < EARLY_ERRORS_MAX) {
        SiteQwalityRUM.earlyErrors.push({ raw, timestamp });
      }
    } catch {
      // Monitoring must never break the host page.
    }
  }

  /** @internal Until init runs, page errors wait in the early queue (CDN script
   * loaded before a deferred init, e.g. behind a consent banner). */
  static _holdEarly(): void {
    try {
      if (SiteQwalityRUM.instance?.started || SiteQwalityRUM.detachEarly) return;
      const forward = (event: Event) => SiteQwalityRUM._captureEarly(event);
      window.addEventListener('error', forward);
      window.addEventListener('unhandledrejection', forward);
      SiteQwalityRUM.detachEarly = () => {
        window.removeEventListener('error', forward);
        window.removeEventListener('unhandledrejection', forward);
      };
    } catch {
      // Monitoring must never break the host page.
    }
  }

  /** Runs a public method on a started instance; calls before init are ignored. */
  private static call(fn: (inst: SiteQwalityRUM) => void): void {
    try {
      const inst = SiteQwalityRUM.instance;
      if (inst?.started) fn(inst);
    } catch {
      // Monitoring must never break the host page.
    }
  }

  /** Synchronous set-up; the returned promise is the remote config. */
  private start(options: RumConfig): Promise<void> {
    this.options = options;
    // Built before anything else: every collector below captures a URL.
    this.sanitizeUrl = createUrlSanitizer({
      allowedQueryParams: options.allowedQueryParams,
      deniedQueryParams: options.deniedQueryParams,
    });
    this.sanitizeText = createTextUrlSanitizer(this.sanitizeUrl);
    this.ignoreErrors = createIgnoreErrorsMatcher(options.ignoreErrors);
    const ingestBase = options.ingestBase || DEFAULT_INGEST_BASE;
    const replayBase = options.replayBase || DEFAULT_REPLAY_BASE;

    this.session = new SessionManager();
    this.session.onRotate(() => this.onRotate());
    this.context = new ContextManager(options);
    this.config = new ConfigManager();

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
    this.replayRecorder = new ReplayRecorder();
    this.replayTransport = new ReplayTransport(
      `${replayBase}/v1/segments`,
      options.clientToken,
    );

    this.restoreDecision();
    // The error collector takes over from the early listeners.
    SiteQwalityRUM.detachEarly?.();
    SiteQwalityRUM.detachEarly = null;
    // A valid id even if the view collector fails; the intake rejects a batch without one.
    this.currentViewId = uuid();
    // The resource and action collectors are handed both bases so the SDK's
    // own requests are never recorded and never count as a click reaction.
    this.startCollectors([ingestBase, replayBase]);
    this.startActivityTracking();
    this.started = true;
    this.drainEarlyErrors();

    return this.config
      .init(options.applicationId, options.clientToken, ingestBase, () =>
        this.guard(() => this.onConfig()),
      )
      .then(() => undefined);
  }

  /** Each collector starts on its own, so one failing leaves the others running. */
  private startCollectors(ownBases: readonly string[]): void {
    this.guard(() => {
      this.views = startViewCollector(
        (view) => this.guard(() => this.onView(view)),
        this.sanitizeUrl,
        {
          onLoadTimings: (timings) => this.guard(() => this.onLoadTimings(timings)),
          onHistoryChange: () => this.actions?.noteReaction(),
        },
      );
    });

    this.guard(() =>
      startVitalsCollector((name, value) =>
        this.guard(() => this.onVital(name, value)),
      ),
    );

    this.guard(() =>
      startErrorCollector((raw) => this.guard(() => this.handleError(raw))),
    );

    // Exclusions are read per batch so a config refresh applies without a reload.
    this.guard(() =>
      startResourceCollector(
        (resource) => this.guard(() => this.onResource(resource)),
        this.sanitizeUrl,
        ownBases,
        () => this.config.getConfig()?.settings.resource_exclusions,
      ),
    );

    this.guard(() => this.startActions(ownBases));

    this.guard(() =>
      startLongTaskCollector((durationMs) =>
        this.guard(() => this.onLongTask(durationMs)),
      ),
    );
  }

  private startActions(ownBases: readonly string[]): void {
    const isOwnRequest = createOwnRequestMatcher(ownBases);
    this.actions = startActionCollector<ActionContext>({
      begin: () => {
        let context: ActionContext | undefined;
        this.guard(() => (context = this.beginAction()));
        if (!context) throw new Error('inactive');
        return context;
      },
      emit: (action, context) => this.guard(() => this.emitAction(action, context)),
      hideText: () => this.hideActionText(),
      ignoreSelectors: () =>
        this.config.getConfig()?.settings.frustration_ignore_selectors,
      isOwnRequest: (url) => isOwnRequest(url),
    });
  }

  /** Input, a visible tab and a view start keep the session alive; SDK emits do not. */
  private startActivityTracking(): void {
    const onInput = () =>
      this.guard(() => {
        const now = Date.now();
        if (now - this.lastInputAt < INPUT_ACTIVITY_THROTTLE_MS) return;
        this.lastInputAt = now;
        this.session.activity();
      });
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ['pointerdown', 'keydown', 'touchstart', 'scroll']) {
      window.addEventListener(type, onInput, opts);
    }
    document.addEventListener('visibilitychange', () =>
      this.guard(() => {
        if (document.visibilityState === 'visible') this.session.activity();
        else this.flushCounts();
      }),
    );
    window.addEventListener('pagehide', () => this.guard(() => this.flushCounts()), {
      capture: true,
    });
  }

  private onConfig(): void {
    const first = !this.configReady;
    this.configReady = true;
    this.evaluate();
    if (first) this.flushPreConfig();
  }

  /** Sends the pre-config buffer if a rule latched detail, with the config's privacy rules. */
  private flushPreConfig(): void {
    const buffered = this.preConfig;
    this.preConfig = [];
    if (!this.detailActive) return;
    const settings = this.config.getConfig()?.settings;
    const isExcluded = createExclusionMatcher(settings?.resource_exclusions ?? []);
    const hide = settings?.privacy?.hide_action_text === true;
    for (const { event, hiddenTarget } of buffered) {
      if (event.type === 'resource' && event.resource_url && isExcluded(event.resource_url)) {
        continue;
      }
      if (event.type === 'action' && hide && hiddenTarget !== undefined) {
        event.action_target = hiddenTarget;
      }
      this.eventTransport.enqueue(event);
    }
  }

  private onView(view: ViewEvent): void {
    // A view start is activity; if it rotates the session, this view opens the new one.
    this.emittingView = true;
    try {
      this.session.activity();
    } finally {
      this.emittingView = false;
    }
    const sessionId = this.session.current();
    this.currentViewId = view.view_id;
    this.sessionState.pageCount++;
    if (!this.initialView) {
      this.initialView = { session_id: sessionId, view_id: view.view_id, url: view.url };
    }

    const measure: RumMeasureEvent = {
      type: 'view',
      session_id: sessionId,
      view_id: view.view_id,
      timestamp: view.timestamp,
      url: view.url,
      loading_type: view.loading_type,
      ...(view.load_time_ms !== undefined ? { load_time_ms: view.load_time_ms } : {}),
      ...(view.dom_ready_ms !== undefined ? { dom_ready_ms: view.dom_ready_ms } : {}),
      ...this.takeCounts(sessionId),
      resource_count: 0,
      ...this.userFields(),
    };
    this.measureTransport.enqueue(measure);
  }

  /** The initial view's load timings, when the load ended after init. */
  private onLoadTimings(timings: LoadTimings): void {
    const view = this.initialView;
    if (!view) return;
    const measure: RumMeasureEvent = {
      type: 'vital',
      session_id: view.session_id,
      view_id: view.view_id,
      timestamp: Date.now(),
      url: view.url,
      loading_type: 'initial_load',
      load_time_ms: timings.load_time_ms,
      ...(timings.dom_ready_ms !== undefined ? { dom_ready_ms: timings.dom_ready_ms } : {}),
      ...this.takeCounts(view.session_id),
      resource_count: 0,
      ...this.userFields(),
    };
    this.measureTransport.enqueue(measure);
  }

  /** A vital never rotates a session: it goes to the view it was measured on. */
  private onVital(name: string, value: number): void {
    const view = this.initialView;
    if (!view) return;
    if (view.session_id === this.session.current()) {
      if (name === 'lcp_ms') this.sessionState.lcpMs = value;
      if (name === 'fcp_ms') this.sessionState.fcpMs = value;
      if (name === 'cls') this.sessionState.cls = value;
    }
    const measure: RumMeasureEvent = {
      type: 'vital',
      session_id: view.session_id,
      view_id: view.view_id,
      timestamp: Date.now(),
      url: view.url,
      [name]: value,
      ...this.takeCounts(view.session_id),
      resource_count: 0,
      ...this.userFields(),
    };
    this.measureTransport.enqueue(measure);
    this.evaluate();
  }

  // Noise, ignoreErrors, burst limits, then beforeSend; only a sent error counts.
  // Classification reads raw text; what is sent is minimised before and after the hook.
  private handleError(
    raw: RawError,
    timestamp: number = Date.now(),
    context?: unknown,
  ): void {
    // An error the hook itself raises (addError inside beforeSend) is dropped.
    if (this.inBeforeSend) return;
    if (isBrowserNoise(raw.message, raw.stack, raw.filename)) return;
    if (this.ignoreErrors(normalizeErrorMessage(raw.message))) return;
    // Nobody is at a hidden tab whose session expired, so there is no session for it.
    if (isHidden() && this.session.isExpired()) return;
    const message = this.sanitizeText(raw.message);
    const stack = this.sanitizeText(raw.stack);
    if (this.errorsSent >= MAX_ERRORS_PER_PAGE) return;
    if (!this.errorLimiter.allow(rateLimitKey(message))) return;

    const original: RumErrorEvent = {
      session_id: this.session.current(),
      view_id: this.currentViewId,
      event_id: uuid(),
      timestamp,
      url: this.currentUrl(),
      error_message: message,
      error_source: raw.source,
      error_stack: stack,
      ...this.versionField(),
      ...this.userFields(),
      // Per-call context wins over ambient global attributes on collision
      custom_attributes: { ...this.context.getGlobalAttributes(), ...stringEntries(context) },
    };
    const event = this.applyBeforeSend(original);
    if (!event) return;
    // Rotates only once the error is kept, so a dropped one never opens a session.
    const sessionId = this.session.idForEmit();
    event.session_id = sessionId;
    event.view_id = this.currentViewId;

    this.errorTransport.enqueue(event);
    this.errorsSent++;
    this.sessionState.hasError = true;
    this.sessionState.errorCount++;
    this.count(sessionId, 'errors');
    this.actions?.noteError();
    this.evaluate();
  }

  /** The customer's hook, on a copy; its result is reshaped to what the intake accepts. */
  private applyBeforeSend(original: RumErrorEvent): RumErrorEvent | null {
    const hook = this.options.beforeSend;
    if (typeof hook !== 'function') return original;
    const draft: RumErrorEvent = {
      ...original,
      custom_attributes: { ...original.custom_attributes },
    };
    let result: unknown;
    this.inBeforeSend = true;
    try {
      result = hook(draft, 'error');
    } catch (err) {
      this.warnOnce('beforeSendThrew', '[SiteQwality RUM] beforeSend threw; the error was sent unchanged', err);
      return original;
    } finally {
      this.inBeforeSend = false;
    }
    if (result === false || result === null) return null;
    if (isThenable(result)) {
      this.warnOnce('beforeSend', '[SiteQwality RUM] beforeSend must return synchronously');
      result = undefined;
    }
    const chosen = result && typeof result === 'object' ? result : draft;
    return this.reshapeErrorEvent(chosen as Record<string, unknown>, original);
  }

  // Required fields fall back to the original when missing or mistyped, optional
  // ones are dropped. Ids and the timestamp never come from the hook.
  private reshapeErrorEvent(
    candidate: Record<string, unknown>,
    original: RumErrorEvent,
  ): RumErrorEvent {
    const field = (key: keyof RumErrorEvent, fallback: string): string => {
      const value = read(() => candidate[key]);
      return typeof value === 'string' ? value : fallback;
    };
    const optional = (key: keyof RumErrorEvent): string | undefined => {
      const value = read(() => candidate[key]);
      return typeof value === 'string' ? value : undefined;
    };
    const out: RumErrorEvent = {
      session_id: original.session_id,
      view_id: original.view_id,
      event_id: original.event_id,
      timestamp: original.timestamp,
      url: this.sanitizeUrl(field('url', original.url)),
      error_message: this.sanitizeText(field('error_message', original.error_message)),
      error_source: field('error_source', original.error_source),
      error_stack: this.sanitizeText(field('error_stack', original.error_stack)),
    };
    const version = optional('version');
    const userId = optional('user_id');
    const userEmail = optional('user_email');
    if (version !== undefined) out.version = version;
    if (userId !== undefined) out.user_id = userId;
    if (userEmail !== undefined) out.user_email = userEmail;
    out.custom_attributes = stringEntries(read(() => candidate.custom_attributes));
    return out;
  }

  /** At the click: counts it, evaluates the rules and fixes where it happened. */
  private beginAction(): ActionContext {
    const sessionId = this.session.idForEmit();
    this.sessionState.actionCount++;
    this.count(sessionId, 'actions');
    const context: ActionContext = {
      session_id: sessionId,
      view_id: this.currentViewId,
      url: this.currentUrl(),
      timestamp: Date.now(),
    };
    this.evaluate();
    this.persistDecision();
    return context;
  }

  private addCustomAction(name: unknown, context?: unknown): void {
    if (typeof name !== 'string' || name === '') return;
    const at = this.beginAction();
    this.emitAction({ action_type: 'custom', action_target: name }, at, context);
  }

  private emitAction(
    action: CollectedAction,
    at: ActionContext,
    context?: unknown,
  ): void {
    if (this.configReady && !this.detailActive) return;
    const hidden = action.action_target_hidden;
    const event: RumDetailEvent = {
      type: 'action',
      session_id: at.session_id,
      view_id: at.view_id,
      event_id: uuid(),
      timestamp: at.timestamp,
      url: at.url,
      action_type: action.action_type,
      action_target:
        hidden !== undefined && this.hideActionText() ? hidden : action.action_target,
      frustration: action.frustration,
      ...this.userFields(),
      // Per-call context wins over ambient global attributes on collision
      custom_attributes: { ...this.context.getGlobalAttributes(), ...stringEntries(context) },
    };
    this.emitDetail(event, hidden);
  }

  private onResource(resource: CollectedResource): void {
    if (!this.acceptsBackgroundDetail()) return;
    this.emitDetail({
      type: 'resource',
      session_id: this.session.current(),
      view_id: this.currentViewId,
      event_id: uuid(),
      timestamp: Date.now(),
      url: this.currentUrl(),
      resource_type: resource.resource_type,
      resource_url: resource.resource_url,
      duration_ms: resource.duration_ms,
      transfer_size: resource.transfer_size,
      ...this.userFields(),
      custom_attributes: this.context.getGlobalAttributes(),
    });
  }

  private onLongTask(durationMs: number): void {
    if (!this.acceptsBackgroundDetail()) return;
    this.emitDetail({
      type: 'long_task',
      session_id: this.session.current(),
      view_id: this.currentViewId,
      event_id: uuid(),
      timestamp: Date.now(),
      url: this.currentUrl(),
      long_task_duration_ms: durationMs,
      ...this.userFields(),
      custom_attributes: this.context.getGlobalAttributes(),
    });
  }

  // Resources and long tasks happen with nobody at the page (polling, timers), so
  // in an expired session they are dropped rather than starting a new one.
  private acceptsBackgroundDetail(): boolean {
    if (this.configReady && !this.detailActive) return false;
    return !this.session.isExpired();
  }

  /** Before config, detail is held; after it, sent only while a rule has latched. */
  private emitDetail(event: RumDetailEvent, hiddenTarget?: string): void {
    if (!this.configReady) {
      this.preConfig.push({ event, hiddenTarget });
      if (this.preConfig.length > PRE_CONFIG_BUFFER_MAX) this.preConfig.shift();
      return;
    }
    if (this.detailActive) this.eventTransport.enqueue(event);
  }

  // On config load and refresh, after each sent error, vital, action and setUser.
  // Detail and replay latch on for the rest of the session.
  private evaluate(): void {
    const config = this.config.getConfig();
    if (!this.configReady || !config) return;
    const { captureDetail, captureReplay } = evaluateFilters(
      config.filters,
      this.sessionState,
    );
    const remote = this.config.isRemote();
    let changed = false;
    if ((captureDetail || (this.resumeDetail && remote)) && !this.detailActive) {
      this.detailActive = true;
      changed = true;
    }
    const resume =
      this.resumeReplay &&
      remote &&
      config.filters.some((rule) => rule?.capture_replay === true);
    if ((captureReplay || resume) && !this.replayActive) {
      this.replayActive = true;
      changed = true;
      this.startReplay(config.settings.privacy);
    }
    if (changed) this.persistDecision();
  }

  private restoreDecision(): void {
    const decision = loadDecision(this.session.current());
    if (!decision) return;
    this.resumeDetail = decision.detail;
    this.resumeReplay = decision.replay;
    this.sessionState.actionCount = decision.actions;
  }

  private persistDecision(): void {
    saveDecision(this.session.current(), {
      detail: this.detailActive || this.resumeDetail,
      replay: this.replayActive || this.resumeReplay,
      actions: this.sessionState.actionCount,
    });
  }

  /** A new session starts clean, with a view of its own and fresh rule decisions. */
  private onRotate(): void {
    this.sessionState = freshSessionState(this.context.getUser().id);
    this.detailActive = false;
    this.replayActive = false;
    this.resumeDetail = false;
    this.resumeReplay = false;
    this.replayRecorder?.stop();
    this.preConfig = [];
    if (!this.emittingView) this.views?.restart();
    this.evaluate();
  }

  private setUserContext(user: UserContext): void {
    this.context.setUser(user);
    this.sessionState.userId = this.context.getUser().id;
    this.evaluate();
  }

  private startReplay(privacy: SdkConfig['settings']['privacy'] | undefined): void {
    const recorder = this.replayRecorder;
    const transport = this.replayTransport;
    if (!recorder || !transport) return;
    const sessionId = this.session.current();
    recorder
      .start(
        sessionId,
        (segment) => {
          void transport.sendSegment(sessionId, segment);
        },
        {
          maskInputs: privacy?.mask_inputs !== false,
          maskText: privacy?.mask_text === true,
        },
        this.sanitizeUrl,
        stringOrUndefined(this.options.recorderUrl),
      )
      .catch(() => {
        this.warnOnce('recorder', '[SiteQwality RUM] Could not load the session replay recorder');
      });
  }

  private drainEarlyErrors(): void {
    const early = SiteQwalityRUM.earlyErrors;
    SiteQwalityRUM.earlyErrors = [];
    for (const { raw, timestamp } of early) {
      this.guard(() => this.handleError(raw, timestamp));
    }
  }

  private count(sessionId: string, kind: 'errors' | 'actions'): void {
    let counts = this.pendingCounts.get(sessionId);
    if (!counts) {
      counts = { errors: 0, actions: 0, view_id: '', url: '', at: 0 };
      this.pendingCounts.set(sessionId, counts);
      if (this.pendingCounts.size > MAX_COUNTED_SESSIONS) {
        const oldest = this.pendingCounts.keys().next().value as string;
        this.sendCounts(oldest);
      }
    }
    counts[kind]++;
    counts.view_id = this.currentViewId;
    counts.url = this.currentUrl();
    counts.at = Date.now();
  }

  /** On hide, counts no view or vital carried yet go out on their own. */
  private flushCounts(): void {
    for (const sessionId of [...this.pendingCounts.keys()]) this.sendCounts(sessionId);
  }

  // A counts-only `action` measure, at the last counted event's view and time.
  private sendCounts(sessionId: string): void {
    const counts = this.pendingCounts.get(sessionId);
    this.pendingCounts.delete(sessionId);
    if (!counts || (counts.errors === 0 && counts.actions === 0)) return;
    this.measureTransport.enqueue({
      type: 'action',
      session_id: sessionId,
      view_id: counts.view_id,
      timestamp: counts.at,
      url: counts.url,
      error_count: counts.errors,
      action_count: counts.actions,
      resource_count: 0,
      ...this.userFields(),
    } satisfies RumMeasureEvent);
  }

  /** Drains a session's counts since its previous measure. */
  private takeCounts(sessionId: string): { error_count: number; action_count: number } {
    const counts = this.pendingCounts.get(sessionId);
    this.pendingCounts.delete(sessionId);
    return { error_count: counts?.errors ?? 0, action_count: counts?.actions ?? 0 };
  }

  private hideActionText(): boolean {
    return this.config.getConfig()?.settings.privacy?.hide_action_text === true;
  }

  /** The release, omitted unless a non-empty string. */
  private versionField(): { version?: string } {
    const version = stringOrUndefined(this.options.version);
    return version ? { version } : {};
  }

  /** The current user's id and email, each omitted when unset. */
  private userFields(): { user_id?: string; user_email?: string } {
    const { id, email } = this.context.getUser();
    return {
      ...(id ? { user_id: id } : {}),
      ...(email ? { user_email: email } : {}),
    };
  }

  /** The current page URL, minimised. Never the raw `location.href`. */
  private currentUrl(): string {
    return pageUrl(window.location.href, this.sanitizeUrl);
  }

  private warned = new Set<string>();

  /** Each kind of warning once per page. */
  private warnOnce(key: string, message: string, detail?: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try {
      if (detail === undefined) console.warn(message);
      else console.warn(message, detail);
    } catch {
      // No console.
    }
  }

  // Collector callbacks run inside host events, so a failure stays here. Only the
  // registered instance acts (tests replace it; production never does).
  private guard(fn: () => void): void {
    if (SiteQwalityRUM.instance !== this) return;
    try {
      fn();
    } catch (err) {
      this.warnOnce('internal', '[SiteQwality RUM] internal error', err);
    }
  }
}

function freshSessionState(userId?: string): SessionState {
  return { hasError: false, errorCount: 0, pageCount: 0, actionCount: 0, userId };
}

function isValidOptions(options: unknown): options is RumConfig {
  const o = options as Partial<RumConfig> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.applicationId === 'string' &&
    o.applicationId !== '' &&
    typeof o.clientToken === 'string' &&
    o.clientToken !== ''
  );
}

function warnInitFailed(err: unknown): void {
  try {
    console.warn('[SiteQwality RUM] init failed', err);
  } catch {
    // No console.
  }
}


/** When an event happened, in epoch ms, from its high-resolution timeStamp. */
function eventTime(event: unknown): number {
  const now = Date.now();
  try {
    const stamp = (event as Event).timeStamp;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return now;
    // Older engines stamped events in epoch milliseconds.
    const at = stamp > 1e12 ? stamp : performance.timeOrigin + stamp;
    return Number.isFinite(at) && at <= now ? Math.round(at) : now;
  } catch {
    return now;
  }
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The string-valued entries only; the intake rejects a batch holding anything else. */
function stringEntries(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  try {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out[key] = entry;
    }
  } catch {
    // A hostile object; send none of it.
  }
  return out;
}

function isThenable(value: unknown): boolean {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}
