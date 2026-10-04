import type { SdkConfig } from './types';

const CONFIG_FETCH_TIMEOUT_MS = 5_000;
const CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Default configuration used when the remote config cannot be fetched.
 * No session filters (no detail/replay capture) and privacy-safe masking.
 */
export function defaultSdkConfig(applicationId: string): SdkConfig {
  return {
    application_id: applicationId,
    filters: [],
    settings: {
      privacy: {
        mask_inputs: true,
        mask_text: false,
      },
    },
  };
}

export class ConfigManager {
  private config: SdkConfig | null = null;
  /** True once a config came from the server, not the fallback defaults. */
  private remote = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Fetch the server-side SDK config from the RUM ingest host
   * (`GET {ingestBase}/v1/config`, authenticated by the client token via the
   * ingest API's authorizer).
   *
   * Never throws: a failed or timed-out fetch falls back to safe defaults so
   * SDK init cannot break the host page. The periodic refresh keeps retrying;
   * on refresh failure the last known config is kept.
   */
  async init(
    applicationId: string,
    clientToken: string,
    ingestBase: string,
    onChange?: (config: SdkConfig) => void,
  ): Promise<SdkConfig> {
    this.config = await this.fetchConfigSafe(
      applicationId,
      clientToken,
      ingestBase,
    );
    // After the first config and each refreshed one.
    notify(onChange, this.config);
    this.refreshInterval = setInterval(() => {
      this.fetchConfig(applicationId, clientToken, ingestBase)
        .then((c) => {
          this.config = c;
          this.remote = true;
          notify(onChange, c);
        })
        .catch(() => {
          // keep the last known config
        });
    }, CONFIG_REFRESH_INTERVAL_MS);
    return this.config;
  }

  getConfig(): SdkConfig | null {
    return this.config;
  }

  isRemote(): boolean {
    return this.remote;
  }

  private async fetchConfigSafe(
    appId: string,
    token: string,
    ingestBase: string,
  ): Promise<SdkConfig> {
    try {
      const config = await this.fetchConfig(appId, token, ingestBase);
      this.remote = true;
      return config;
    } catch {
      return defaultSdkConfig(appId);
    }
  }

  private async fetchConfig(
    appId: string,
    token: string,
    ingestBase: string,
  ): Promise<SdkConfig> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Rejects on time even if a fetch polyfill ignores the abort signal.
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Config fetch timed out'));
      }, CONFIG_FETCH_TIMEOUT_MS);
    });
    const request = (async () => {
      const resp = await fetch(`${ingestBase}/v1/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Config fetch failed: ${resp.status}`);
      const json = await resp.json();
      return normalizeConfig((json && json.data) as SdkConfig | undefined, appId);
    })();
    // The loser of the race must not surface as an unhandled rejection.
    request.catch(() => {});
    try {
      return await Promise.race([request, timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }

  destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}

function normalizeConfig(config: SdkConfig | undefined, appId: string): SdkConfig {
  if (!config || !Array.isArray(config.filters) || !config.settings) {
    throw new Error('Config fetch returned an unexpected shape');
  }
  const privacy = config.settings.privacy;
  if (!privacy || typeof privacy !== 'object') {
    // Missing privacy settings mean the safe defaults.
    config.settings.privacy = defaultSdkConfig(appId).settings.privacy;
  }
  return config;
}

function notify(onChange: ((config: SdkConfig) => void) | undefined, config: SdkConfig): void {
  try {
    onChange?.(config);
  } catch {
    // A listener must not break the config cycle.
  }
}
