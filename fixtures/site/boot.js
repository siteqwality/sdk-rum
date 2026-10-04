// Installs the dashboard snippet stub and loads the SDK under test, like a customer page.
// The harness sets window.__SQ_FIXTURE__ before any script runs; ?sq_* params override by hand.
(function () {
  var origins = /*__SQ_ORIGINS__*/ null;
  var cfg = {
    sdk: 'on',
    loader: 'classic',
    sdkPath: '/rum/v1/sdk.min.js',
    applicationId: '00000000-0000-4000-8000-00000000f1f1',
    clientToken: 'fixture-manual',
    service: 'fixture',
    env: 'test',
    version: 'fixture-1.0.0',
    init: {},
  };
  var preset = window.__SQ_FIXTURE__ || {};
  for (var k in preset) cfg[k] = preset[k];
  try {
    var q = new URLSearchParams(location.search);
    ['sdk', 'loader', 'clientToken', 'applicationId'].forEach(function (key) {
      var v = q.get('sq_' + key);
      if (v) sessionStorage.setItem('sq_fixture_' + key, v);
      v = sessionStorage.getItem('sq_fixture_' + key);
      if (v && !(key in preset)) cfg[key] = v;
    });
  } catch (e) {}

  var fixture = (window.fixture = window.fixture || {});
  fixture.config = cfg;
  fixture.origins = origins;
  fixture.sdk = { state: cfg.sdk === 'off' ? 'off' : 'loading' };
  // Calls an SDK method only if this SDK version has it, so 2.0-only calls never throw on 1.x.
  fixture.call = function (method) {
    var rum = window.SiteQwalityRUM;
    if (!rum || typeof rum[method] !== 'function') return { called: false };
    try {
      return { called: true, value: rum[method].apply(rum, [].slice.call(arguments, 1)) };
    } catch (err) {
      return { called: true, threw: String(err && err.message) };
    }
  };
  if (cfg.sdk === 'off') return;

  var w = window, d = document;
  var methods = [
    'init', 'setUser', 'clearUser', 'setGlobalAttribute', 'removeGlobalAttribute', 'addError', 'addAction',
    'setView', 'setTrackingConsent', 'optOut', 'optIn', 'startReplay', 'stopReplay',
  ];
  var r = (w.SiteQwalityRUM = w.SiteQwalityRUM || { _q: [] });
  if (r._q && !r._h) {
    methods.forEach(function (m) {
      r[m] = function () {
        r._q.push([m, arguments]);
      };
    });
    r._h = function (e) {
      r._q.push(['_e', [e]]);
    };
    w.addEventListener('error', r._h);
    w.addEventListener('unhandledrejection', r._h);
    var s = d.createElement('script');
    s.async = true;
    if (cfg.loader === 'module') s.type = 'module';
    s.src = origins.cdn + cfg.sdkPath;
    s.onload = function () {
      fixture.sdk.state = w.SiteQwalityRUM !== r ? 'loaded' : 'stub';
    };
    s.onerror = function () {
      fixture.sdk.state = 'failed';
    };
    (d.head || d.documentElement).appendChild(s);
  }
  fixture.sdk.stub = r;

  var options = {
    applicationId: cfg.applicationId,
    clientToken: cfg.clientToken,
    service: cfg.service,
    env: cfg.env,
    version: cfg.version,
    ingestBase: origins.ingest,
    replayBase: origins.replay,
    configBase: origins.cdn,
  };
  for (var o in cfg.init) options[o] = cfg.init[o];
  w.SiteQwalityRUM.init(options);
})();
