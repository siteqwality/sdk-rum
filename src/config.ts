import type { SdkConfig } from './types';

export class ConfigManager {
  private config: SdkConfig | null = null;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  async init(
    applicationId: string,
    clientToken: string,
    apiBase: string,
  ): Promise<SdkConfig> {
    this.config = await this.fetchConfig(applicationId, clientToken, apiBase);
    // Refresh config every 5 minutes
    this.refreshInterval = setInterval(
      () =>
        this.fetchConfig(applicationId, clientToken, apiBase).then((c) => {
          this.config = c;
        }),
      5 * 60 * 1000,
    );
    return this.config;
  }

  getConfig(): SdkConfig | null {
    return this.config;
  }

  private async fetchConfig(
    appId: string,
    token: string,
    apiBase: string,
  ): Promise<SdkConfig> {
    const resp = await fetch(`${apiBase}/v1/rum/config/${appId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`Config fetch failed: ${resp.status}`);
    const json = await resp.json();
    return json.data;
  }

  destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}
