import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayPlugin, PluginContext } from "./types.js";
import { createLogger } from "../utils/logger.js";

// ── Plugin Hot-Reload ───────────────────────────────────────────────
// Watches plugin and skill directories for changes. When a file is
// modified, the old plugin/skill is stopped and the new version is
// loaded, initialized, and started — zero-downtime.
//
// This enables adding new channels, tools, or skills without
// restarting the entire gateway.
//
// Limitations:
//   - Only watches top-level plugin directories
//   - State is lost on reload (plugins should persist to DB)
//   - Module cache is busted via query string versioning

const log = createLogger("hot-reload");

// ── Types ───────────────────────────────────────────────────────────

export interface HotReloadConfig {
  pluginDirs: string[];         // directories to watch
  debounceMs: number;           // debounce file changes (default: 1000ms)
  enabled: boolean;
}

interface LoadedPlugin {
  name: string;
  plugin: GatewayPlugin;
  dir: string;
  loadedAt: number;
}

const DEFAULT_CONFIG: HotReloadConfig = {
  pluginDirs: [],
  debounceMs: 1000,
  enabled: true,
};

// ── Hot Reloader ────────────────────────────────────────────────────

export class PluginHotReloader {
  private watchers: FSWatcher[] = [];
  private loadedPlugins = new Map<string, LoadedPlugin>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private config: HotReloadConfig;
  private ctx: PluginContext | null = null;

  constructor(config: Partial<HotReloadConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start watching directories for changes.
   */
  start(ctx: PluginContext, existingPlugins: GatewayPlugin[] = []): void {
    if (!this.config.enabled) return;
    this.ctx = ctx;

    // Register existing plugins
    for (const plugin of existingPlugins) {
      this.loadedPlugins.set(plugin.name, {
        name: plugin.name,
        plugin,
        dir: "",
        loadedAt: Date.now(),
      });
    }

    // Watch each directory
    for (const dir of this.config.pluginDirs) {
      try {
        const watcher = watch(dir, { recursive: true }, (event, filename) => {
          if (!filename) return;
          this.handleChange(dir, filename, event);
        });
        this.watchers.push(watcher);
        log.info(`Watching ${dir} for changes`);
      } catch (err) {
        log.dim(`Cannot watch ${dir}: ${err}`);
      }
    }
  }

  /**
   * Stop all watchers and clean up.
   */
  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    log.info("Hot-reload stopped");
  }

  /**
   * Get all currently loaded plugins.
   */
  getLoadedPlugins(): GatewayPlugin[] {
    return [...this.loadedPlugins.values()].map((lp) => lp.plugin);
  }

  // ── Internal ────────────────────────────────────────────────────

  private handleChange(dir: string, filename: string, _event: string): void {
    // Only care about index.ts/index.js changes
    if (!filename.endsWith("index.ts") && !filename.endsWith("index.js")) return;

    // Extract plugin directory name
    const parts = filename.split("/");
    const pluginDir = parts[0] ?? filename;
    const fullPluginDir = join(dir, pluginDir);

    // Debounce rapid changes
    const key = fullPluginDir;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.reloadPlugin(fullPluginDir).catch((err) => {
          log.error(`Failed to reload plugin from ${pluginDir}:`, err);
        });
      }, this.config.debounceMs),
    );
  }

  private async reloadPlugin(pluginDir: string): Promise<void> {
    if (!this.ctx) return;

    const dirName = basename(pluginDir);
    log.info(`Reloading plugin: ${dirName}`);

    // Find the entry point
    let modulePath: string | undefined;
    for (const ext of ["index.js", "index.ts"]) {
      const candidate = join(pluginDir, ext);
      try {
        await stat(candidate);
        modulePath = candidate;
        break;
      } catch {
        continue;
      }
    }

    if (!modulePath) {
      log.dim(`No index file found in ${dirName}`);
      return;
    }

    // Stop old plugin if loaded
    const oldKey = [...this.loadedPlugins.entries()].find(([_, lp]) => lp.dir === pluginDir)?.[0];
    if (oldKey) {
      const old = this.loadedPlugins.get(oldKey)!;
      try {
        await old.plugin.stop?.();
        log.dim(`Stopped old plugin: ${old.name}`);
      } catch (err) {
        log.dim(`Error stopping ${old.name}: ${err}`);
      }
      this.loadedPlugins.delete(oldKey);
    }

    // Load new version (bust module cache with timestamp)
    try {
      const moduleUrl = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
      const mod = await import(moduleUrl);
      const plugin = mod.default as GatewayPlugin;

      if (!plugin?.name || !plugin?.init) {
        log.error(`Invalid plugin in ${dirName}: missing name or init()`);
        return;
      }

      // Initialize and start
      await plugin.init(this.ctx);
      await plugin.start?.();

      this.loadedPlugins.set(plugin.name, {
        name: plugin.name,
        plugin,
        dir: pluginDir,
        loadedAt: Date.now(),
      });

      const bus = this.ctx.getEventBus();
      bus.emit("plugin.loaded", {
        name: plugin.name,
        version: plugin.version,
        timestamp: Date.now(),
      });

      log.info(`Reloaded plugin: ${plugin.name}@${plugin.version}`);
    } catch (err) {
      log.error(`Failed to load plugin from ${dirName}:`, err);

      const bus = this.ctx.getEventBus();
      bus.emit("plugin.error", {
        name: dirName,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    }
  }
}

// ── Module Singleton ────────────────────────────────────────────────

let _reloader: PluginHotReloader | null = null;

export function getHotReloader(config?: Partial<HotReloadConfig>): PluginHotReloader {
  if (!_reloader) {
    _reloader = new PluginHotReloader(config);
  }
  return _reloader;
}
