// SDK 2.0 (design 5.2 to 5.7, 6.1): one instance per page, started synchronously by init().
import type { Consent, InitOptions, SdkConfig, SdkStatus, SqEvent, SqEventKind, UserContext } from './types';
import { OBSERVE, ANALYZE, type EmitOptions, type Hub, type Tier } from './hub';
import { VERSION } from './version';
import { PUBLIC_METHODS } from './api';
import { createUrlSanitizer, createTextUrlSanitizer } from './core/url';
import { createScrubber } from './core/sanitize';
import { normalizeConfig, loadCachedConfig, saveCachedConfig, clearCachedConfig, fetchConfig, DEFAULT_CONFIG_BASE, CONFIG_MAX_AGE_MS } from './core/config';
import { createSession, anonymousId, type Decision } from './core/session';
import { createTransport, type Ctx } from './core/transport';
import { createBudget } from './core/budget';
import { createRules, type RuleInput } from './core/rules';
import { sampledIn, uuid, toHex } from './core/hash';
import { parseStack, topFrame, normalisePath, errorKey } from './core/stack';
import { now, epochOf, cut, isHidden, storage, strings, on, read, nonEmpty, byteLength } from './core/util';
import { startViews, pageUrl, type Views } from './collectors/views';
import { startVitals } from './collectors/vitals';
import { listenErrors, createErrorPipeline, fromValue, fromErrorEvent, fromRejection, isRejectionEvent, type RawError } from './collectors/errors';
import { startActionCollector, type ActionCollector } from './collectors/actions';
import { startNetwork, type Network } from './collectors/network';
import { startResources, createOwnRequestMatcher, createExclusionMatcher, type Resources } from './collectors/resources';
import { startConsole, type Console } from './collectors/console';
import { startFrames } from './collectors/frames';
import { loadReplay } from './replay/load-record';
import type { ReplayHandle } from './replay/chunk';

const APP_URL = 'https://app.siteqwality.com';
export const RING_MS = 60_000;
export const RING_MAX = 500;
const OPT_OUT = '_sq_optout';

// beforeSend never changes these.
const FIXED = 'k t view_id id seq final error_key'.split(' ');

const warn = (message: string, detail?: unknown) => read(() => console.warn(`[SiteQwality RUM] ${message}`, detail ?? ''));

function isMobile(): boolean {
  const ua = read(() => navigator.userAgent) ?? '';
  return (
    read(() => (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile) === true ||
    /Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle/i.test(ua) ||
    (/Macintosh/.test(ua) && (read(() => navigator.maxTouchPoints) ?? 0) > 1)
  );
}

const keyOf = (e: SqEvent) =>
  errorKey(String(e.error_type), String(e.message), normalisePath(topFrame(parseStack(String(e.stack)))?.file ?? ''));

export type Instance = ReturnType<typeof createInstance>;

export function createInstance(opts: InitOptions) {
  const appId = opts.applicationId;
  const token = opts.clientToken;
  const trim = (b: string | undefined, d: string) => (b || d).replace(/\/+$/, '');
  const ingestBase = trim(opts.ingestBase, 'https://in.siteqwality.com');
  const replayBase = trim(opts.replayBase, 'https://replay.siteqwality.com');
  const configBase = trim(opts.configBase, DEFAULT_CONFIG_BASE);
  const f0 = window.fetch;
  const nativeFetch = ((...a: Parameters<typeof fetch>) => f0.apply(window, a)) as typeof fetch;
  const isOwn = createOwnRequestMatcher([ingestBase, replayBase, configBase]);
  const sanitizeUrl = createUrlSanitizer({ allowedQueryParams: opts.allowedQueryParams, deniedQueryParams: opts.deniedQueryParams });
  const sanitizeText = createTextUrlSanitizer(sanitizeUrl);

  if (/[?&]sq_debug=1(&|$)/.test(read(() => location.search) ?? '')) storage.set('localStorage', 'sq_debug', '1');
  const debug = opts.debug === true || storage.get('localStorage', 'sq_debug') === '1';
  const log = (...a: unknown[]) => debug && read(() => console.log('[SiteQwality RUM]', ...a));

  const cached = loadCachedConfig(appId);
  let cfg: SdkConfig = cached?.config ?? normalizeConfig(null, appId);
  let configAt = cached?.at ?? 0;
  let configKnown = !!cached;
  const explicit = opts.trackingConsent;
  let consent: Consent = explicit ?? (cfg.privacy.require_consent ? 'pending' : 'granted');
  let optedOut = storage.get('localStorage', OPT_OUT) === '1';
  const gpcOn = read(() => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) === true;
  const gpc = () => gpcOn && cfg.privacy.honor_gpc;
  const target = () =>
    consent !== 'granted' || opts.persistence === 'memory' ? 'memory' : cfg.privacy.cookieless || gpc() ? 'session' : 'persist';

  const session = createSession({ persistence: opts.persistence, cookieDomain: opts.cookieDomain, mode: target() });
  const counters: Record<string, number> = {};
  const totals: Record<string, number> = {};
  const count = (name: string, n = 1) => {
    counters[name] = (counters[name] ?? 0) + n;
    totals[name] = (totals[name] ?? 0) + n;
  };
  // Every SDK request (batches, segments, config, identity) passes the request budget.
  const budget = createBudget(() => (session.mode === 'session' ? 'sessionStorage' : session.mode === 'memory' ? undefined : 'localStorage'));
  let overBudget = false;
  const sdkFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const bytes = typeof body === 'string' ? byteLength(body) : body instanceof Blob ? body.size : 0;
    if (overBudget || !budget.take(session.id, bytes)) {
      spent();
      return Promise.reject(new Error('request budget'));
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  const transport = createTransport({
    url: `${ingestBase}/v2/batch`,
    token,
    fetch: sdkFetch,
    count,
    log: (o, n) => log('batch', n, o),
    onStop: () => stopRecording('refused'),
  });
  transport.hold(consent !== 'granted');

  let scrub = createScrubber(cfg.privacy.pii_patterns);
  let user: UserContext = {};
  let attrs: Record<string, string> = {};
  let ctx: Ctx | null = null;
  let analyzeOn = false;
  let observeIn = true;
  let dnr = false;
  let urlPaused = false;
  let neverRecord = createExclusionMatcher(cfg.privacy.never_record_urls);
  let ring: Array<{ e: SqEvent; t: number }> = [];
  let crumbs: Array<Record<string, unknown>> = [];
  let inHook = false;
  let viewStarting = false;
  let lastInput = 0;
  let recording: SdkStatus['recording'] = 'off';
  let reason: string | undefined;
  let replay: ReplayHandle | null = null;
  let loading = false;
  let forced = false;
  let userStopped = false;
  let views: Views | undefined;
  let actions: ActionCollector | undefined;
  let network: Network | undefined;
  let resources: Resources | undefined;
  let consoleCol: Console | undefined;
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string, detail?: unknown) => {
    if (!warned.has(key)) warned.add(key) && warn(message, detail);
  };

  const canSend = () => !optedOut && !overBudget && consent !== 'not-granted' && cfg.status !== 'paused' && !transport.stopped && observeIn;

  /** The budget is spent: stop sending until a new session, and say so once, locally. */
  function spent(): void {
    if (overBudget) return;
    overBudget = true;
    count('request_budget');
    transport.block(true);
    ring = [];
    stopRecording('request_budget');
    warnOnce('budget', 'Stopped sending: this session reached its request budget');
  }
  const resample = () => {
    observeIn = sampledIn(`${session.id}:observe`, cfg.observe.sample_rate);
  };
  resample();

  function ctxFor(sid: string): Ctx {
    if (sid === session.id && ctx) return ctx;
    const anon = consent === 'granted' && !gpc() && !cfg.privacy.cookieless && opts.persistence !== 'memory';
    const u: Record<string, unknown> = {};
    if (!gpc() && !dnr) {
      if (user.id) u.id = user.id;
      if (user.email && cfg.privacy.capture_user_email) u.email = user.email;
      if (user.name) u.name = user.name;
      if (user.traits) u.traits = user.traits;
    }
    const d = session.decision;
    const c: Ctx = {
      service: opts.service,
      env: opts.env,
      release: opts.version,
      session_id: sid,
      get window_id() {
        return session.windowId;
      },
      page_load_id: session.pageLoadId,
      anonymous_id: anon ? anonymousId() : undefined,
      user: Object.keys(u).length ? u : undefined,
      attrs: Object.keys(attrs).length ? attrs : undefined,
      sampling: { analyze: analyzeOn, replay: recording === 'recording', rule_id: d.rule_id },
      consent,
      viewport: [innerWidth, innerHeight],
      screen: [read(() => screen.width) ?? 0, read(() => screen.height) ?? 0],
      dpr: devicePixelRatio || 1,
      lang: read(() => navigator.language) ?? '',
      tz: read(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ?? '',
    };
    if (sid === session.id) ctx = c;
    return c;
  }

  /** beforeSend for every kind (6.1): ids and times never change; the result is re-sanitised. */
  function hook(e: SqEvent, kind: SqEventKind): SqEvent | null {
    const fn = opts.beforeSend;
    if (typeof fn !== 'function') return e;
    const draft = JSON.parse(JSON.stringify(e)) as SqEvent;
    let r: unknown;
    inHook = true;
    try {
      r = fn(draft, kind);
    } catch (err) {
      warnOnce('hook', 'beforeSend threw; the event was sent unchanged', err);
      return e;
    } finally {
      inHook = false;
    }
    if ((r === false || r === null) && kind !== 'view') {
      count('before_send_dropped');
      return null;
    }
    if (typeof (r as { then?: unknown } | null)?.then === 'function') {
      warnOnce('hookAsync', 'beforeSend must return synchronously');
      r = undefined;
    }
    const chosen = (r && typeof r === 'object' ? r : draft) as Record<string, unknown>;
    const out = { ...e };
    // Known fields only, of the same type; a removed field keeps its original value.
    for (const key of Object.keys(e)) {
      const v = read(() => chosen[key]);
      if (FIXED.includes(key) || v === undefined || typeof v !== typeof e[key] || Array.isArray(v) !== Array.isArray(e[key])) continue;
      out[key] = typeof v !== 'string' ? v : key === 'url' || key === 'referrer' ? sanitizeUrl(v) : /^(message|stack|name)$/.test(key) ? scrub(sanitizeText(v)) : v;
    }
    if ('_h' in e) Object.defineProperty(out, '_h', { value: (e as { _h?: string })._h });
    if (kind === 'error') out.error_key = keyOf(out);
    return out;
  }

  function sessionFor(rotate: boolean): string | null {
    if (session.sync()) changed();
    if (session.expired()) {
      if (!rotate) return null;
      session.rotate();
      changed();
    }
    return session.id;
  }

  function emit(e: SqEvent, tier: Tier, o: EmitOptions = {}): boolean {
    if (inHook) return false;
    // Only a new session lifts a spent request budget.
    if (overBudget && !o.sid) sessionFor(!!o.rotate);
    if (!canSend()) return false;
    const sid = o.sid ?? sessionFor(!!o.rotate);
    if (!sid || (tier === ANALYZE && (gpc() || dnr || urlPaused))) return false;
    const kept = o.kind ? hook(e, o.kind) : e;
    if (!kept) return false;
    if (tier === ANALYZE && !analyzeOn) {
      const t = now();
      ring.push({ e: kept, t });
      while (ring.length > RING_MAX || t - ring[0].t > RING_MS) ring.shift();
    } else transport.push(kept, ctxFor(sid), o.urgent);
    return true;
  }

  const status = (fields: Record<string, unknown>) => emit({ k: 'status', t: now(), view_id: views?.current.id, ...fields }, OBSERVE);

  function setRecording(state: SdkStatus['recording'], why?: string): void {
    if (state === recording && why === reason) return;
    recording = state;
    reason = why;
    ctx = null;
    log('recording', state, why);
    status({ state, reason: why });
  }

  const wantReplay = () =>
    !userStopped && configKnown && canSend() && consent === 'granted' && !gpc() && !dnr && (forced || session.decision.replay);

  function startRecording(): void {
    if (replay || loading || !wantReplay()) return;
    loading = true;
    const sid = session.id;
    loadReplay(opts.recorderUrl).then(
      (start) => {
        loading = false;
        if (replay || sid !== session.id || !wantReplay()) return;
        replay = start({
          mode: 'stream',
          sessionId: sid,
          replayBase,
          token,
          fetch: sdkFetch,
          url: sanitizeUrl,
          text: sanitizeText,
          privacy: cfg.privacy,
          mask: createScrubber(cfg.privacy.pii_patterns, true),
          now,
          onStatus: (state, why) => {
            if (state === 'stopped') replay = null;
            setRecording(state, why);
          },
        });
        if (urlPaused) replay.pause('privacy_url');
      },
      (err) => {
        loading = false;
        warnOnce('recorder', 'Could not load the session replay recorder', err);
        setRecording('stopped', 'load_failed');
      },
    );
  }

  function stopRecording(why?: string): void {
    replay?.stop();
    replay = null;
    if (recording !== 'off' || why) setRecording(why ? 'stopped' : 'off', why);
  }

  /** A rule decision, latched for the session and shared with other tabs through the cookie. */
  function decide(d: Decision): void {
    const cur = session.decision;
    // rule_id names the rule that started replay, else the one that started Analyze.
    const next = { analyze: cur.analyze || d.analyze, replay: cur.replay || d.replay, rule_id: d.replay && !cur.replay ? d.rule_id : cur.rule_id || d.rule_id };
    if (next.analyze !== cur.analyze || next.replay !== cur.replay || next.rule_id !== cur.rule_id) {
      session.setDecision(next);
      log('decision', next);
    }
    ctx = null;
    if (!configKnown) return;
    if (next.analyze && !analyzeOn && !gpc() && !dnr) {
      analyzeOn = true;
      const hide = cfg.privacy.hide_action_text;
      for (const { e } of ring) {
        const h = (e as { _h?: string })._h;
        if (hide && h) e.name = h;
        transport.push(e, ctxFor(session.id));
      }
      ring = [];
    }
    if (next.replay) startRecording();
  }

  const rules = createRules({ device: isMobile() ? 'mobile' : 'desktop', release: nonEmpty(opts.version), env: nonEmpty(opts.env) }, decide);
  const input = (i: RuleInput) => rules.input(i);
  const identity = () => {
    if (user.id) input({ k: 'identified' });
    for (const [key, value] of Object.entries({ ...attrs, ...user.traits })) input({ k: 'attribute', key, value });
  };
  const setRules = (fresh: boolean) => rules.set(cfg.rules, session.id, session.started, session.decision, fresh);

  /** A new session (rotated, or another tab's adopted): state, rules and the view start over. */
  function changed(): void {
    if (overBudget) {
      overBudget = false;
      transport.block(false);
      reason = undefined;
    }
    ctx = null;
    ring = [];
    crumbs = [];
    analyzeOn = dnr = forced = false;
    resample();
    stopRecording();
    setRules(true);
    identity();
    if (!viewStarting) views?.restart('route_change', 'session');
    decide(session.decision);
  }

  function pauseFor(url: string): void {
    const paused = neverRecord(url);
    if (paused === urlPaused) return;
    urlPaused = paused;
    if (paused) replay?.pause('privacy_url');
    else replay?.resume();
  }

  function applyConfig(raw: unknown, fresh: boolean): void {
    const prev = cfg;
    cfg = normalizeConfig(raw, appId);
    log('config', cfg);
    if (fresh) {
      configAt = now();
      if (consent === 'granted') saveCachedConfig(appId, raw);
    }
    hub.scrub = scrub = createScrubber(cfg.privacy.pii_patterns);
    neverRecord = createExclusionMatcher(cfg.privacy.never_record_urls);
    consoleCol?.sync();
    if (cfg.status === 'paused') {
      transport.clear();
      return stopRecording('paused');
    }
    if (cfg.privacy.require_consent && !explicit && consent === 'granted' && !prev.privacy.require_consent) setConsent('pending');
    if (session.setMode(target())) changed();
    if (gpc()) {
      analyzeOn = false;
      ring = [];
      stopRecording();
    }
    resample();
    ctx = null;
    const first = !configKnown;
    configKnown = true;
    setRules(false);
    if (views) pauseFor(views.current.url);
    const d = session.decision;
    if (first || d.analyze || d.replay) decide(d);
    if (replay && fresh && JSON.stringify(prev.privacy) !== JSON.stringify(cfg.privacy)) {
      // New privacy settings apply from a fresh snapshot.
      stopRecording();
    }
    startRecording();
  }

  const refresh = () =>
    fetchConfig(configBase, appId, sdkFetch).then(
      (raw) => applyConfig(raw, true),
      (err) => {
        log('config failed', err);
        // The safe defaults are known too; nothing beyond Observe starts from them.
        if (!configKnown) {
          configKnown = true;
          setRules(false);
          startRecording();
        }
      },
    );

  function setConsent(next: Consent): void {
    if (!['granted', 'pending', 'not-granted'].includes(next)) return;
    const prev = consent;
    consent = next;
    ctx = null;
    log('consent', next);
    if (next === 'granted') {
      if (session.setMode(target())) {
        changed();
        transport.rekey(ctxFor(session.id));
      }
      session.setDecision(session.decision);
      if (configAt) saveCachedConfig(appId, cfg);
      transport.hold(false);
      return decide(session.decision);
    }
    transport.hold(true);
    stopRecording();
    if (next === 'not-granted') {
      transport.clear();
      ring = [];
      clearCachedConfig(appId);
    }
    if (prev === 'granted') session.clear();
    session.setMode('memory');
  }

  async function checkIdentity(id: string): Promise<void> {
    if (!cfg.limits.dnr) return;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${appId}:${id}`));
      const res = await sdkFetch(`${ingestBase}/v2/identity?h=${toHex(new Uint8Array(digest))}`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit',
      });
      if ((await res.json())?.record === false && user.id === id) {
        dnr = true;
        analyzeOn = false;
        ring = [];
        ctx = null;
        stopRecording('do_not_record');
      }
    } catch {
      // Fail open: the intake drops do-not-record users as well.
    }
  }

  const hub: Hub = {
    opts,
    cfg: () => cfg,
    url: sanitizeUrl,
    text: sanitizeText,
    scrub,
    emit,
    input,
    crumb(k, msg, data) {
      if (crumbs.push({ t: now(), k, msg: cut(msg, 256), data }) > 30) crumbs.shift();
    },
    count,
    isOwn,
    pageUrl: () => pageUrl(location.href, sanitizeUrl, opts.hashRouting === true),
    viewId: () => views?.current.id ?? '',
  };

  setRules(true);

  const errors = createErrorPipeline(hub, {
    crumbs: () => crumbs,
    orphan: () => session.expired(),
    sent: (raw: RawError, e: SqEvent) => {
      input({ k: 'error', type: raw.type, message: String(e.message), handling: raw.handling });
      if (views) views.current.errors += Number(e.repeat) || 1;
      actions?.noteError();
    },
  });

  // Each collector starts on its own, so one failing leaves the others running.
  const start = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      warnOnce(name, `could not start ${name}`, err);
    }
  };
  start('views', () => {
    views = startViews(hub, {
      session: () => {
        viewStarting = true;
        try {
          const id = sessionFor(true) ?? session.id;
          session.touch();
          return { id, isNew: session.isNew };
        } finally {
          viewStarting = false;
        }
      },
      onView: (v) => {
        input({ k: 'url', url: v.url, path: v.url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '') || '/' });
        pauseFor(v.url);
        hub.crumb('navigation', v.url);
        network?.flush();
      },
      onHistory: () => actions?.noteReaction(),
    });
  });
  start('vitals', () =>
    startVitals(hub, (fields, metric, value) => {
      views?.vital(fields);
      if (views?.initial.sid === session.id) input({ k: 'vital', metric, value });
      const url = (fields.lcp as { resource_url?: string } | undefined)?.resource_url;
      if (url) resources?.lcp(url);
    }),
  );
  start('errors', () => listenErrors((raw) => errors.report(raw)));
  start('actions', () => {
    actions = startActionCollector<{ sid: string; view: string; t: number }>({
      begin: () => {
        const sid = sessionFor(true);
        if (!sid) throw 0;
        return { sid, view: views?.current.id ?? '', t: now() };
      },
      emit: (a, c) => {
        const e: SqEvent = {
          k: 'action',
          t: c.t,
          view_id: c.view,
          id: uuid(),
          action_type: a.action_type,
          name: scrub(a.name),
          selector: scrub(a.selector),
          frustration: a.frustration,
          click_count: a.click_count,
          offset_pct: a.offset_pct,
          page_xy: a.page_xy,
          viewport_w: a.viewport_w,
        };
        Object.defineProperty(e, '_h', { value: scrub(a.hiddenName) });
        const v = views?.current;
        if (v?.id === c.view) {
          v.actions++;
          if (a.frustration) v.frustrations++;
        }
        if (a.frustration) input({ k: 'frustration', type: a.frustration });
        if (a.action_type === 'click' || a.action_type === 'tap') hub.crumb('click', String(e.name));
        emit(e, a.frustration ? OBSERVE : ANALYZE, { kind: 'action', sid: c.sid });
      },
      hideText: () => cfg.privacy.hide_action_text,
      ignoreSelectors: () => cfg.capture.frustration_ignore_selectors,
    });
  });
  start('network', () => {
    network = startNetwork(hub, {
      // A request after a click is its reaction (not a dead click).
      netStart: () => (actions?.noteReaction(), views?.netStart()),
      failed: (row) => {
        input({ k: 'network_error', status: row.status, url: row.url });
        hub.crumb('network', `${row.method} ${row.url} ${row.status}`);
      },
    });
  });
  start('resources', () => {
    resources = startResources(hub, { onRequestEntry: (e) => network?.entry(e) });
  });
  start('console', () => {
    consoleCol = startConsole(hub, (m) => hub.crumb('console', m));
  });
  start('frames', () => startFrames(hub));

  // Input keeps the session alive (at most every 5 s); the SDK's own sends never do.
  const onInput = (e: Event) => {
    const t = now();
    views?.input(t);
    if (e.type !== 'scroll') rules.interaction();
    if (t - lastInput < 5_000) return;
    lastInput = t;
    if (sessionFor(true)) session.touch();
  };
  for (const type of ['pointerdown', 'keydown', 'touchstart', 'scroll']) on(window, type, onInput);

  const flushAll = (final: boolean) => {
    if (final) views?.pagehide();
    else views?.hide();
    network?.flush();
    resources?.flush();
    consoleCol?.flush();
    const c = { ...counters };
    for (const k in counters) delete counters[k];
    if (Object.keys(c).length) status({ counters: c });
    if (final) transport.unload();
    else transport.hide();
  };
  on(document, 'visibilitychange', () => {
    if (isHidden()) return flushAll(false);
    if (sessionFor(true)) session.touch();
    if (now() - configAt > CONFIG_MAX_AGE_MS) void refresh();
  }, false);
  on(window, 'pagehide', () => flushAll(true), false);
  on(window, 'pageshow', (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    transport.restore();
    session.newPageLoad();
    ctx = null;
    views?.restart('bfcache_restore', 'back_forward_cache');
  }, false);

  if (cached) applyConfig(cached.raw, false);
  const ready = refresh();
  if (explicit && explicit !== 'granted') setConsent(explicit);
  log('started', session.id, consent);

  const strArg = (v: unknown) => (typeof v === 'string' && v ? cut(v, 256) : undefined);

  return {
    ready,
    errors,
    getStatus(): SdkStatus {
      const d = session.decision;
      const why =
        reason ??
        (optedOut ? 'opted_out' : consent !== 'granted' ? 'consent' : gpc() ? 'gpc' : urlPaused ? 'privacy_url' : !d.replay && configKnown ? 'not_sampled' : undefined);
      return {
        session_id: session.id,
        window_id: session.windowId,
        consent,
        opted_out: optedOut,
        sampled: { analyze: analyzeOn, replay: d.replay || forced, ...(d.rule_id ? { rule_id: d.rule_id } : {}) },
        recording,
        ...(why ? { reason: why } : {}),
        sdk_version: VERSION,
        ...(cfg.revision !== undefined ? { config_revision: cfg.revision } : {}),
        dropped: { ...totals },
      };
    },
    getSessionUrl: (o?: { atCurrentTime?: boolean }) =>
      `${APP_URL}/rum/${encodeURIComponent(appId)}/sessions/${session.id}${o?.atCurrentTime ? `?at=${now()}` : ''}`,
    setUser(u?: UserContext | null): void {
      const out: UserContext = {};
      for (const key of ['id', 'email', 'name'] as const) {
        const v: unknown = read(() => u?.[key]);
        if ((typeof v === 'string' && v) || (typeof v === 'number' && isFinite(v))) out[key] = cut(String(v), 1024);
      }
      const traits = strings(read(() => u?.traits), 20);
      if (traits) out.traits = traits;
      user = out;
      ctx = null;
      identity();
      if (out.id) void checkIdentity(out.id);
    },
    clearUser(): void {
      user = {};
      ctx = null;
    },
    /** Caps: 50 keys of 128 chars, values cut at 1024, 4 KB in all; anything else is ignored. */
    setGlobalAttribute(key: unknown, value: unknown): void {
      if (typeof key !== 'string' || typeof value !== 'string' || !key.trim() || key.length > 128) return;
      if (!(key in attrs) && Object.keys(attrs).length >= 50) return;
      const next = { ...attrs, [key]: cut(value, 1024) };
      if (byteLength(JSON.stringify(next)) > 4096) return;
      attrs = next;
      ctx = null;
      input({ k: 'attribute', key, value: next[key] });
    },
    removeGlobalAttribute(key: unknown): void {
      if (typeof key !== 'string' || !(key in attrs)) return;
      attrs = { ...attrs };
      delete attrs[key];
      ctx = null;
    },
    addError(error: unknown, context?: unknown): void {
      errors.report(fromValue(error), now(), context);
    },
    /** A custom event, always recorded (Observe). */
    addAction(name: unknown, context?: unknown): void {
      const n = strArg(name);
      if (!n) return;
      emit({ k: 'custom', t: now(), view_id: hub.viewId(), id: uuid(), name: n, context: strings(context) }, OBSERVE, { kind: 'custom', rotate: true });
      input({ k: 'event', name: n });
    },
    setView(name: unknown): void {
      const n = strArg(name);
      if (n) views?.setRoute(n);
    },
    setTrackingConsent: setConsent,
    optOut(): void {
      optedOut = true;
      storage.set('localStorage', OPT_OUT, '1');
      transport.clear();
      ring = [];
      stopRecording('opted_out');
    },
    optIn(): void {
      optedOut = false;
      storage.del('localStorage', OPT_OUT);
      decide(session.decision);
    },
    isOptedOut: () => optedOut,
    startReplay(o?: { force?: boolean }): void {
      userStopped = false;
      if (o?.force === true) forced = true;
      startRecording();
    },
    stopReplay(): void {
      userStopped = true;
      stopRecording('stopped_by_api');
    },
  };
}

// ── Public facade ────────────────────────────────────────────────────────────

export interface SiteQwalityRUMApi {
  /** @internal Marks the loaded SDK, so a second copy of the CDN script does nothing. */
  readonly __sq: true;
  /** Starts collecting before it returns; resolves once config is applied or has failed. Never rejects. */
  init(options: InitOptions): Promise<void>;
  setUser(user: UserContext): void;
  clearUser(): void;
  setGlobalAttribute(key: string, value: string): void;
  removeGlobalAttribute(key: string): void;
  /** Any value; `context['sq.fingerprint']` sets a custom fingerprint. */
  addError(error: unknown, context?: Record<string, string>): void;
  /** A custom event, always recorded. */
  addAction(name: string, context?: Record<string, string>): void;
  /** The route name of the current view. */
  setView(name: string): void;
  setTrackingConsent(consent: Consent): void;
  optOut(): void;
  optIn(): void;
  isOptedOut(): boolean;
  /** `force` records regardless of sampling; consent and quota still apply. */
  startReplay(options?: { force?: boolean }): void;
  stopReplay(): void;
  getSessionUrl(options?: { atCurrentTime?: boolean }): string;
  getStatus(): SdkStatus | undefined;
  /** @internal */
  _captureEarly(event: unknown): void;
  /** @internal */
  _holdEarly(): void;
  /** @internal Tests only: forget the instance, as a new page load would. */
  _reset(): void;
}

let instance: Instance | null = null;
let early: Array<{ raw: RawError; t: number }> = [];
let detach: (() => void) | null = null;

function eventTime(event: unknown): number {
  const t = now();
  const stamp = read(() => (event as Event).timeStamp);
  if (typeof stamp !== 'number' || !(stamp > 0)) return t;
  // Older engines stamp events in epoch ms; trust that only near our own clock.
  const at = stamp > 1e12 ? Math.round(stamp) : epochOf(stamp);
  return at <= t && t - at < 3_600_000 ? at : t;
}

function captureEarly(event: unknown): void {
  const raw = read(() => (isRejectionEvent(event) ? fromRejection(event) : fromErrorEvent(event)));
  if (!raw) return;
  const t = eventTime(event);
  if (instance) read(() => instance!.errors.report(raw, t));
  else if (early.length < 100) early.push({ raw, t });
}

// Before init, optOut and friends work on storage alone.
const before: Record<string, (...a: unknown[]) => unknown> = {
  optOut: () => storage.set('localStorage', OPT_OUT, '1'),
  optIn: () => storage.del('localStorage', OPT_OUT),
  isOptedOut: () => storage.get('localStorage', OPT_OUT) === '1',
  getSessionUrl: () => '',
};

export const SiteQwalityRUM = {
  __sq: true,
  init(options: InitOptions): Promise<void> {
    try {
      if (instance) return Promise.resolve();
      const o = options as Partial<InitOptions> | null;
      if (!o || typeof o.applicationId !== 'string' || !o.applicationId || typeof o.clientToken !== 'string' || !o.clientToken) {
        warn('init needs an applicationId and a clientToken');
        return Promise.resolve();
      }
      detach?.();
      detach = null;
      instance = createInstance(options);
      for (const { raw, t } of early.splice(0)) instance.errors.report(raw, t);
      return instance.ready.catch(() => undefined);
    } catch (err) {
      warn('init failed', err);
      return Promise.resolve();
    }
  },
  _captureEarly: (event: unknown) => read(() => captureEarly(event)),
  _holdEarly(): void {
    if (instance || detach) return;
    const forward = (e: Event) => captureEarly(e);
    on(window, 'error', forward, false);
    on(window, 'unhandledrejection', forward, false);
    detach = () => {
      removeEventListener('error', forward);
      removeEventListener('unhandledrejection', forward);
    };
  },
  _reset(): void {
    instance = null;
    early = [];
    detach?.();
    detach = null;
  },
} as unknown as SiteQwalityRUMApi;

for (const m of PUBLIC_METHODS) {
  if (m === 'init') continue;
  (SiteQwalityRUM as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
    try {
      const i = instance as unknown as Record<string, (...a: unknown[]) => unknown> | null;
      return i ? i[m](...args) : before[m]?.(...args);
    } catch (err) {
      warn('internal error', err);
    }
  };
}
