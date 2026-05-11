import type { GatewayPlugin } from "../types.js";

// ── Core Plugin ────────────────────────────────────────────────────
// No-op plugin. Built-in agent registrations have been removed.
// Agents are now created dynamically per-workspace via the REST API.
// This plugin remains as a mount point for future core tools/routes.

const corePlugin: GatewayPlugin = {
  name: "core",
  version: "2.0.0",

  init(ctx) {
    ctx.logger.info("[plugin:core] Initialized (no built-in agents)");
  },
};

export default corePlugin;
