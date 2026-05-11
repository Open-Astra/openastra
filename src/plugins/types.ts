import type { Express } from "express";
import type { AgentConfig } from "../agents/types.js";
import type { InferenceClient } from "../inference/types.js";
import type { EventBus } from "../events/bus.js";
import type { registerTool } from "../tools/registry.js";

// ── Plugin Interface ───────────────────────────────────────────────
// Every plugin must implement GatewayPlugin. The lifecycle is:
//   1. discoverPlugins() — finds and imports plugin modules
//   2. init(ctx) — plugin registers configs, tools, routes
//   3. start() — plugin begins background work (optional)
//   4. stop() — plugin tears down on shutdown (optional, reverse order)

export interface GatewayPlugin {
  name: string;
  version: string;
  init(ctx: PluginContext): Promise<void> | void;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}

// ── Plugin Context ─────────────────────────────────────────────────
// Injected into every plugin's init() method. Provides access to the
// gateway's core services without exposing internal implementation.

export interface PluginContext {
  app: Express;
  resolveClient: (config: AgentConfig) => InferenceClient;
  getEventBus: () => EventBus;
  registerTool: typeof registerTool;
  registerAgentConfig: (id: string, config: AgentConfig) => void;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}
