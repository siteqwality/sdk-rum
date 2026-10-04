/** Methods the CDN snippet stub queues and replays once the script loads (design 6.1). */
export const PUBLIC_METHODS = [
  'init',
  'setUser',
  'clearUser',
  'setGlobalAttribute',
  'removeGlobalAttribute',
  'addError',
  'addAction',
  'setView',
  'setTrackingConsent',
  'optOut',
  'optIn',
  'isOptedOut',
  'startReplay',
  'stopReplay',
  'getSessionUrl',
  'getStatus',
] as const;
