// The config the mock serves, as 1.x (GET /v1/config) and 2.0 (design 6.2) shapes, from one spec:
// { capture: none|analyze|replay|replay_on_error, level: strict|balanced|relaxed, v1?, v2? overrides }.

export const DEFAULT_SPEC = { capture: 'none', level: 'balanced' };

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function merge(base, extra) {
  if (!isObject(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

export function v1Config(applicationId, spec) {
  const filters = [];
  if (spec.capture === 'replay') filters.push({ filter_type: 'custom', conditions: {}, capture_replay: true });
  if (spec.capture === 'replay_on_error') filters.push({ filter_type: 'error', conditions: {}, capture_replay: true });
  if (spec.capture === 'analyze') filters.push({ filter_type: 'custom', conditions: {}, capture_replay: false });
  const strict = spec.level === 'strict';
  return merge(
    {
      application_id: applicationId,
      filters,
      settings: {
        privacy: { mask_inputs: true, mask_text: strict, hide_action_text: strict },
        resource_exclusions: [],
      },
    },
    spec.v1,
  );
}

export function v2Config(applicationId, spec) {
  const rule = (id, capture, conditions) => ({
    id, capture, sample_rate: 1, conditions, min_duration_ms: 0, require_interaction: false,
  });
  const rules = [];
  if (spec.capture === 'replay') rules.push(rule('r_fx_replay', 'replay', []));
  if (spec.capture === 'replay_on_error') rules.push(rule('r_fx_error', 'replay', [{ kind: 'error' }]));
  if (spec.capture === 'analyze') rules.push(rule('r_fx_analyze', 'analyze', []));
  const strict = spec.level === 'strict';
  return merge(
    {
      v: 2,
      application_id: applicationId,
      revision: 1,
      status: 'active',
      observe: { sample_rate: 1 },
      rules,
      privacy: {
        level: spec.level,
        mask_inputs: true,
        mask_text: strict,
        hide_action_text: strict,
        mask_selectors: [],
        unmask_selectors: [],
        block_selectors: ['[data-sq-block]'],
        ignore_input_selectors: [],
        pii_patterns: spec.level === 'relaxed' ? [] : ['email', 'card', 'digits9'],
        never_record_urls: [],
        require_consent: false,
        honor_gpc: true,
        cookieless: false,
        capture_user_email: true,
      },
      capture: {
        resource_exclusions: [],
        network: {
          header_allowlist: ['content-type', 'x-request-id'],
          body_urls: [],
          trace_urls: [],
          max_body_bytes: 10240,
        },
        console: strict ? ['error'] : ['error', 'warn'],
        errors: { ignore: [], deny_urls: [], suppressed_keys: [] },
        frustration_ignore_selectors: [],
        canvas: { enabled: false, selectors: [], fps: 2, quality: 0.4 },
      },
      limits: { idle_pause_ms: 300000, session_max_ms: 14400000, dnr: false },
    },
    spec.v2,
  );
}
