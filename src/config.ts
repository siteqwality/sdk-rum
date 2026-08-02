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
  ): Promise<SdkConfig> {
    this.config = await this.fetchConfigSafe(
      applicationId,
      clientToken,
      ingestBase,
    );
    this.refreshInterval = setInterval(() => {
      this.fetchConfig(applicationId, clientToken, ingestBase)
        .then((c) => {
          this.config = c;
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

  private async fetchConfigSafe(
    appId: string,
    token: string,
    ingestBase: string,
  ): Promise<SdkConfig> {
    try {
      return await this.fetchConfig(appId, token, ingestBase);
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
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG_FETCH_TIMEOUT_MS,
    );
    try {
      const resp = await fetch(`${ingestBase}/v1/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Config fetch failed: ${resp.status}`);
      const json = await resp.json();
      const config = (json && json.data) as SdkConfig | undefined;
      if (!config || !Array.isArray(config.filters) || !config.settings) {
        throw new Error('Config fetch returned an unexpected shape');
      }
      return config;
    } finally {
      clearTimeout(timeout);
    }
  }

  destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}
