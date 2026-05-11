// ── Plugin SDK ──────────────────────────────────────────────────────
// Formal base classes and interfaces for building Astra plugins.
// Plugins extend PluginBase (or ChannelPluginBase) and export a
// default instance conforming to GatewayPlugin.

// ── Manifest ────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  requiredEnvVars?: string[];
  exports: {
    tools?: string[];
    skills?: string[];
    channels?: string[];
  };
}

// ── Base Plugin ──────────────────────────────────────────────────────

export abstract class PluginBase {
  abstract manifest: PluginManifest;

  /** Called once at startup after all services are initialized. */
  async init(): Promise<void> {}

  /** Called on graceful shutdown. */
  async shutdown(): Promise<void> {}

  /** Validate that required env vars are present. */
  validateEnv(): { valid: boolean; missing: string[] } {
    const missing = (this.manifest.requiredEnvVars ?? []).filter(
      (k) => !process.env[k],
    );
    return { valid: missing.length === 0, missing };
  }
}

// ── Channel Plugin ───────────────────────────────────────────────────

export interface ChannelPluginBase extends PluginBase {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(channelId: string, message: string): Promise<void>;
}
