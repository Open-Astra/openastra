import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../utils/logger.js";
import { getEventBus } from "../events/bus.js";

// ── Skill Hot-Reload Watcher ───────────────────────────────────────
// Watches src/skills/definitions/ for new or changed skill folders.
// When a skill's index.ts/js is modified:
//   1. Unregisters the old version from the skill registry
//   2. Dynamically imports the new version (cache-busted)
//   3. Validates it has required exports (name, execute)
//   4. Re-registers with the skill registry
//
// This allows adding/updating skills without restarting the gateway.

const log = createLogger("skill-watcher");

export interface SkillModule {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (...args: unknown[]) => Promise<unknown>;
}

export interface SkillWatcherConfig {
  skillsDir: string;
  debounceMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: SkillWatcherConfig = {
  skillsDir: "",
  debounceMs: 1500,
  enabled: true,
};

type SkillRegistryFn = (name: string, skill: SkillModule) => void;
type SkillUnregisterFn = (name: string) => void;

export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loadedSkills = new Map<string, SkillModule>();
  private config: SkillWatcherConfig;
  private registerFn: SkillRegistryFn | null = null;
  private unregisterFn: SkillUnregisterFn | null = null;

  constructor(config: Partial<SkillWatcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(register: SkillRegistryFn, unregister: SkillUnregisterFn): void {
    if (!this.config.enabled || !this.config.skillsDir) return;

    this.registerFn = register;
    this.unregisterFn = unregister;

    try {
      this.watcher = watch(this.config.skillsDir, { recursive: true }, (_event: string, filename: string | null) => {
        if (!filename) return;
        this.handleChange(filename);
      });
      log.info(`Watching skills directory: ${this.config.skillsDir}`);
    } catch (err) {
      log.dim(`Cannot watch skills dir: ${err}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    log.info("Skill watcher stopped");
  }

  getLoadedSkills(): Map<string, SkillModule> {
    return new Map(this.loadedSkills);
  }

  private handleChange(filename: string): void {
    if (!filename.endsWith("index.ts") && !filename.endsWith("index.js")) return;

    const parts = filename.split("/");
    const skillDir = parts[0] ?? filename;
    const key = skillDir;

    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.reloadSkill(skillDir).catch((err) => {
          log.error(`Failed to reload skill ${skillDir}:`, err);
        });
      }, this.config.debounceMs),
    );
  }

  private async reloadSkill(skillDirName: string): Promise<void> {
    const fullDir = join(this.config.skillsDir, skillDirName);
    log.info(`Reloading skill: ${skillDirName}`);

    let modulePath: string | undefined;
    for (const ext of ["index.ts", "index.js"]) {
      const candidate = join(fullDir, ext);
      try {
        await stat(candidate);
        modulePath = candidate;
        break;
      } catch { continue; }
    }

    if (!modulePath) {
      log.dim(`No index file found in ${skillDirName}`);
      return;
    }

    // Unregister old version
    const oldSkill = this.loadedSkills.get(skillDirName);
    if (oldSkill && this.unregisterFn) {
      this.unregisterFn(oldSkill.name);
      this.loadedSkills.delete(skillDirName);
      log.dim(`Unregistered old skill: ${oldSkill.name}`);
    }

    // Load new version with cache busting
    try {
      const moduleUrl = `${pathToFileURL(modulePath).href}?v=${Date.now()}`;
      const mod = await import(moduleUrl);
      const skill = (mod.default ?? mod) as SkillModule;

      if (!skill?.name || typeof skill.execute !== "function") {
        log.error(`Invalid skill in ${skillDirName}: missing name or execute()`);
        return;
      }

      if (this.registerFn) {
        this.registerFn(skill.name, skill);
      }

      this.loadedSkills.set(skillDirName, skill);

      const bus = getEventBus();
      bus.emit("skill.executed", {
        uid: "system",
        skillId: skill.name,
        toolName: "hot-reload",
        durationMs: 0,
        timestamp: Date.now(),
      });

      log.info(`Reloaded skill: ${skill.name}`);
    } catch (err) {
      log.error(`Failed to load skill from ${skillDirName}:`, err);
    }
  }

  async scanAndLoadAll(): Promise<number> {
    if (!this.config.skillsDir) return 0;

    let dirs: string[];
    try {
      dirs = await readdir(this.config.skillsDir);
    } catch {
      return 0;
    }

    let loaded = 0;
    for (const dir of dirs) {
      const fullPath = join(this.config.skillsDir, dir);
      try {
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;
        await this.reloadSkill(dir);
        loaded++;
      } catch { continue; }
    }

    return loaded;
  }
}

let _instance: SkillWatcher | null = null;

export function getSkillWatcher(config?: Partial<SkillWatcherConfig>): SkillWatcher {
  if (!_instance) {
    _instance = new SkillWatcher(config);
  }
  return _instance;
}
