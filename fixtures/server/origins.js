// Every origin the fixture uses. Shared by the server and the harness.
const port = (name, fallback) => Number(process.env[name] || fallback);

export const PORTS = {
  site: port('SQ_SITE_PORT', 4310),
  third: port('SQ_THIRD_PORT', 4311),
  ingest: port('SQ_INGEST_PORT', 4320),
  replay: port('SQ_REPLAY_PORT', 4321),
  cdn: port('SQ_CDN_PORT', 4322),
};

// The third-party origin uses another host name, so it is cross-origin and cross-site.
export const ORIGINS = {
  site: `http://localhost:${PORTS.site}`,
  third: `http://127.0.0.1:${PORTS.third}`,
  ingest: `http://localhost:${PORTS.ingest}`,
  replay: `http://localhost:${PORTS.replay}`,
  cdn: `http://localhost:${PORTS.cdn}`,
};

// Node-side access to the mock control API, avoiding localhost resolving to ::1.
export const CONTROL = `http://127.0.0.1:${PORTS.ingest}/__mock`;
export const SITE_CONTROL = `http://127.0.0.1:${PORTS.site}/__site`;

// Where SDK traffic goes. Anything the SDK sends must land on one of these.
export const SDK_HOSTS = [ORIGINS.ingest, ORIGINS.replay, ORIGINS.cdn];
