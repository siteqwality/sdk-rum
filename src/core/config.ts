// Config v2 (design 5.8, 6.2): fetched from the CDN as a simple CORS request (no preflight),
// cached in localStorage, and safe defaults until it arrives.
import type { RecordingRule, SdkConfig } from '../types';
import { isNum, isObj, storage, strList, now } from './util';

export const DEFAULT_CONFIG_BASE = 'https://cdn.siteqwality.com';
/** A cached copy older than this is refreshed when the page becomes visible. */
export const CONFIG_MAX_AGE_MS = 5 * 60_000;
const BALANCED = ['email', 'card', 'digits9'];

const cacheKey = (appId: string) => `_sq_cfg_${appId}`;

/** Safe defaults: no Analyze or replay, inputs masked, Balanced patterns, GPC honoured. */
const defaults = (): Omit<SdkConfig, 'application_id' | 'rules'> => ({
  v: 2,
  status: 'active',
  observe: { sample_rate: 1 },
  privacy: {
    level: 'balanced',
    mask_inputs: true,
    mask_text: false,
    hide_action_text: false,
    mask_selectors: [],
    unmask_selectors: [],
    block_selectors: [],
    ignore_input_selectors: [],
    pii_patterns: BALANCED,
    never_record_urls: [],
    require_consent: false,
    honor_gpc: true,
    cookieless: false,
    capture_user_email: true,
  },
  capture: {
    resource_exclusions: [],
    network: { header_allowlist: ['content-type', 'x-request-id'], body_urls: [], trace_urls: [], max_body_bytes: 10_240 },
    console: ['error', 'warn'],
    errors: { ignore: [], deny_urls: [], suppressed_keys: [] },
    frustration_ignore_selectors: [],
  },
  limits: { idle_pause_ms: 300_000, session_max_ms: 14_400_000, dnr: false },
});

/** Each default replaced by a value of the same shape; string lists keep only strings. */
function merge<T>(base: T, raw: unknown): T {
  if (!isObj(raw)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, d] of Object.entries(base as object)) {
    const v = raw[k];
    if (Array.isArray(d)) {
      if (Array.isArray(v)) out[k] = k === 'suppressed_keys' ? v.filter(isNum) : strList(v);
    } else if (isObj(d)) out[k] = merge(d, v);
    else if (typeof v === typeof d && (!isNum(d) || isNum(v))) out[k] = v;
  }
  return out as T;
}

function rule(r: unknown): RecordingRule | null {
  if (!isObj(r) || typeof r.id !== 'string' || !r.id || (r.capture !== 'analyze' && r.capture !== 'replay')) return null;
  return {
    id: r.id,
    capture: r.capture,
    sample_rate: isNum(r.sample_rate) ? r.sample_rate : 0,
    auto: r.auto === true,
    conditions: Array.isArray(r.conditions) ? r.conditions.filter(isObj).map((c) => ({ ...c, kind: String(c.kind) })) : [],
    min_duration_ms: isNum(r.min_duration_ms) ? r.min_duration_ms : 0,
    require_interaction: r.require_interaction === true,
  };
}

export function normalizeConfig(raw: unknown, appId: string): SdkConfig {
  const c = isObj(raw) ? raw : {};
  const p = isObj(c.privacy) ? c.privacy : {};
  const out = merge(defaults(), c) as SdkConfig;
  out.application_id = appId;
  out.revision = isNum(c.revision) ? c.revision : undefined;
  out.status = c.status === 'paused' ? 'paused' : 'active';
  out.rules = Array.isArray(c.rules) ? c.rules.map(rule).filter((r): r is RecordingRule => !!r) : [];
  // A null level is the legacy "Custom": the individual flags apply.
  const level = ['strict', 'balanced', 'relaxed'].includes(p.level as string) ? (p.level as 'strict' | 'balanced' | 'relaxed') : 'level' in p ? null : 'balanced';
  out.privacy.level = level;
  if (!Array.isArray(p.pii_patterns)) out.privacy.pii_patterns = level === 'relaxed' ? [] : BALANCED;
  if (typeof p.mask_text !== 'boolean') out.privacy.mask_text = level === 'strict';
  if (typeof p.hide_action_text !== 'boolean') out.privacy.hide_action_text = level === 'strict';
  out.observe.sample_rate = Math.min(1, Math.max(0, out.observe.sample_rate));
  out.capture.network.max_body_bytes = Math.min(65_536, Math.max(0, out.capture.network.max_body_bytes));
  return out;
}

export interface CachedConfig {
  config: SdkConfig;
  raw: unknown;
  at: number;
}

export function loadCachedConfig(appId: string): CachedConfig | null {
  try {
    const d = JSON.parse(storage.get('localStorage', cacheKey(appId)) || 'null');
    return isObj(d) && isNum(d.at) && isObj(d.c) && d.c.v === 2 ? { config: normalizeConfig(d.c, appId), raw: d.c, at: d.at } : null;
  } catch {
    return null;
  }
}

export const saveCachedConfig = (appId: string, raw: unknown): unknown =>
  storage.set('localStorage', cacheKey(appId), JSON.stringify({ at: now(), c: raw }));

export const clearCachedConfig = (appId: string): void => storage.del('localStorage', cacheKey(appId));

/** GET `<base>/rum/config/v2/<app>.json` without credentials or custom headers, 3 s timeout. */
export function fetchConfig(base: string, appId: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error('timeout'));
    }, 3_000);
    fetchFn(`${base.replace(/\/+$/, '')}/rum/config/v2/${encodeURIComponent(appId)}.json`, { credentials: 'omit', signal: ctl?.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => (isObj(json) && json.v === 2 ? resolve(json) : reject(new Error('shape'))), reject)
      .finally(() => clearTimeout(timer));
  });
}
