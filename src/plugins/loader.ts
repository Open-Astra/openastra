import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayPlugin, PluginContext } from "./types.js";

// ── Plugin Discovery ───────────────────────────────────────────────
// Scans a directory for subdirectories containing an index.ts or index.js.
// Each subdirectory is treated as a plugin and dynamically imported.
// The module must have a default export conforming to GatewayPlugin.

export async function discoverPlugins(dir: string): Promise<GatewayPlugin[]> {
  const plugins: GatewayPlugin[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // If the plugins directory doesn't exist, return empty
    return plugins;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);
    const entryStat = await stat(entryPath);
    if (!entryStat.isDirectory()) continue;

    // Look for index.js first (compiled), then index.ts (dev)
    let modulePath: string | undefined;
    for (const ext of ["index.js", "index.ts"]) {
      const candidate = join(entryPath, ext);
      try {
        await stat(candidate);
        modulePath = candidate;
        break;
      } catch {
        // File doesn't exist, try next
      }
    }

    if (!modulePath) continue;

    try {
      const moduleUrl = pathToFileURL(modulePath).href;
      const mod = await import(moduleUrl);
      const plugin = mod.default as GatewayPlugin;

      if (!plugin?.name || !plugin?.init) {
        console.error(`[plugins] Skipping ${entry}: missing name or init()`);
        continue;
      }

      plugins.push(plugin);
    } catch (err) {
      console.error(`[plugins] Failed to import ${entry}:`, err);
    }
  }

  return plugins;
}

// ── Plugin Initialization ──────────────────────────────────────────
// Calls init() on each discovered plugin, passing the shared context.
// Emits plugin.loaded or plugin.error events for observability.

export async function initPlugins(
  plugins: GatewayPlugin[],
  ctx: PluginContext,
): Promise<void> {
  const bus = ctx.getEventBus();

  for (const plugin of plugins) {
    try {
      await plugin.init(ctx);
      bus.emit("plugin.loaded", {
        name: plugin.name,
        version: plugin.version,
        timestamp: Date.now(),
      });
      ctx.logger.info(`[plugins] Initialized: ${plugin.name}@${plugin.version}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bus.emit("plugin.error", {
        name: plugin.name,
        error: message,
        timestamp: Date.now(),
      });
      ctx.logger.error(`[plugins] Failed to init ${plugin.name}:`, err);
    }
  }
}

// ── Plugin Start ───────────────────────────────────────────────────
// Calls start() on each plugin (if defined). Called after all plugins
// have been initialized and the HTTP server is about to listen.

export async function startPlugins(plugins: GatewayPlugin[]): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.start) {
      try {
        await plugin.start();
      } catch (err) {
        console.error(`[plugins] Failed to start ${plugin.name}:`, err);
      }
    }
  }
}

// ── Plugin Stop ────────────────────────────────────────────────────
// Calls stop() on each plugin in reverse order (last loaded = first stopped).
// Called during graceful shutdown.

export async function stopPlugins(plugins: GatewayPlugin[]): Promise<void> {
  const reversed = [...plugins].reverse();
  for (const plugin of reversed) {
    if (plugin.stop) {
      try {
        await plugin.stop();
      } catch (err) {
        console.error(`[plugins] Failed to stop ${plugin.name}:`, err);
      }
    }
  }
}
