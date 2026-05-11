import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { watch, type FSWatcher } from "node:fs";
import type { SkillDefinition, SkillContext } from "./types.js";
import { registerSkill } from "./registry.js";
import { topoSortSkills } from "./dependency-graph.js";

// ── Skill Discovery ─────────────────────────────────────────────────
// Scans src/skills/definitions/ for subdirectories with index.ts/js.
// Same pattern as plugin discovery but registers as skills.

export async function discoverSkills(dir: string): Promise<SkillDefinition[]> {
  const discovered: SkillDefinition[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return discovered;
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);
    const entryStat = await stat(entryPath);
    if (!entryStat.isDirectory()) continue;

    let modulePath: string | undefined;
    for (const ext of ["index.js", "index.ts"]) {
      const candidate = join(entryPath, ext);
      try {
        await stat(candidate);
        modulePath = candidate;
        break;
      } catch {
        // next
      }
    }

    if (!modulePath) continue;

    try {
      const moduleUrl = pathToFileURL(modulePath).href;
      const mod = await import(moduleUrl);
      const skill = mod.default as SkillDefinition;

      if (!skill?.manifest?.id || !skill?.init) {
        console.error(`[skills] Skipping ${entry}: missing manifest or init()`);
        continue;
      }

      discovered.push(skill);
    } catch (err) {
      console.error(`[skills] Failed to import ${entry}:`, err);
    }
  }

  return discovered;
}

// ── Skill Initialization ────────────────────────────────────────────

export async function initSkills(
  discovered: SkillDefinition[],
  ctx: SkillContext,
): Promise<void> {
  // Topologically sort skills so dependencies init first (Feature 29)
  try {
    discovered = topoSortSkills(discovered);
  } catch (err) {
    console.warn(`[skills] Dependency sort failed, using discovery order: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const skill of discovered) {
    try {
      await skill.init(ctx);
      registerSkill(skill);
    } catch (err) {
      console.error(`[skills] Failed to init ${skill.manifest.id}:`, err);
    }
  }

  // Dependency validation pass
  const { getAllSkills } = await import("./registry.js");
  const { getTool } = await import("../tools/registry.js");
  const registeredSkills = getAllSkills();

  for (const [id, skill] of registeredSkills) {
    const requires = skill.manifest.requires ?? [];
    for (const dep of requires) {
      // Check if dep is a registered tool or skill ID
      const isSkill = registeredSkills.has(dep);
      const isTool = getTool(dep) !== undefined;
      if (!isSkill && !isTool) {
        console.warn(`[skill:${id}] WARNING: missing dependency "${dep}"`);
      }
    }
  }
}

// ── Skill Lifecycle ─────────────────────────────────────────────────

export async function startSkills(skills: SkillDefinition[]): Promise<void> {
  for (const skill of skills) {
    if (skill.start) {
      try {
        await skill.start();
      } catch (err) {
        console.error(`[skills] Failed to start ${skill.manifest.id}:`, err);
      }
    }
  }
}

export async function stopSkills(skills: SkillDefinition[]): Promise<void> {
  const reversed = [...skills].reverse();
  for (const skill of reversed) {
    if (skill.stop) {
      try {
        await skill.stop();
      } catch (err) {
        console.error(`[skills] Failed to stop ${skill.manifest.id}:`, err);
      }
    }
  }
}

// ── Skill Hot-Swap ───────────────────────────────────────────────────
// Watches the skills directory for changes and reloads individual skills
// without a full server restart.
//
// NOTE: fs.watch with { recursive: true } works natively on macOS and Linux
// (inotify). On Windows it requires the underlying ReadDirectoryChangesW API
// which Node.js does expose, but deep recursive watching on Windows can be
// unreliable for nested structures. This implementation will still run on
// Windows; in practice, prefer Docker/Linux containers for local dev.
//
// For distributed (AWS/GCP) deployments: fs.watch only covers the local
// filesystem. Multi-instance deployments should use a rolling deploy strategy
// — update skill files and redeploy containers. This hot-swap feature targets
// local development and single-instance Docker deployments.
//
// WIRING: call startSkillHotSwap(skillsDir, ctx) after initSkills() in
// gateway/index.ts, and call stopSkillHotSwap() in the graceful-shutdown
// sequence alongside stopSkills().

let _hotSwapWatcher: FSWatcher | null = null;

export function startSkillHotSwap(skillsDir: string, ctx: SkillContext): void {
  if (process.env.NODE_ENV === "production") {
    console.warn("[skills] Hot-swap disabled in production (set NODE_ENV=development to enable)");
    return;
  }

  if (_hotSwapWatcher) return; // already watching

  // Debounce: wait 500 ms after the last change before reloading
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  _hotSwapWatcher = watch(skillsDir, { recursive: true }, (_eventType, filename) => {
    if (!filename || (!filename.endsWith(".ts") && !filename.endsWith(".js"))) return;

    // Extract skill dir name (first path component)
    const skillDir = filename.split(/[/\\]/)[0];
    if (!skillDir) return;

    const existing = pending.get(skillDir);
    if (existing) clearTimeout(existing);

    pending.set(
      skillDir,
      setTimeout(async () => {
        pending.delete(skillDir);
        await reloadSkill(join(skillsDir, skillDir), ctx);
      }, 500),
    );
  });

  console.log(`[skills] Hot-swap watcher active on ${skillsDir}`);
}

async function reloadSkill(skillPath: string, ctx: SkillContext): Promise<void> {
  const { registerSkill: register, getAllSkills } = await import("./registry.js");

  let modulePath: string | undefined;
  for (const ext of ["index.js", "index.ts"]) {
    try {
      const candidate = join(skillPath, ext);
      await import("node:fs/promises").then((fs) => fs.stat(candidate));
      modulePath = candidate;
      break;
    } catch {
      // next
    }
  }
  if (!modulePath) return;

  try {
    // ESM module cache invalidation via cache-busting query param
    const moduleUrl = `${pathToFileURL(modulePath).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl);
    const skill = mod.default as SkillDefinition;

    if (!skill?.manifest?.id || !skill?.init) {
      console.warn(`[skills:hot-swap] Invalid skill at ${skillPath}`);
      return;
    }

    // Stop old instance if registered
    const existingSkill = getAllSkills().get(skill.manifest.id);
    if (existingSkill?.stop) {
      await (existingSkill.stop() ?? Promise.resolve()).catch(() => {});
    }

    // Re-init and re-register
    await skill.init(ctx);
    register(skill);
    console.log(`[skills:hot-swap] Reloaded: ${skill.manifest.id}`);
  } catch (err) {
    console.error(`[skills:hot-swap] Failed to reload ${skillPath}:`, err);
  }
}

export function stopSkillHotSwap(): void {
  if (_hotSwapWatcher) {
    _hotSwapWatcher.close();
    _hotSwapWatcher = null;
  }
}
