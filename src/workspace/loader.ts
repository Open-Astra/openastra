// ── Workspace Folder Loader ──────────────────────────────────────────
// Reads .md files from the project's ./workspace/ directory and caches
// them as a bootstrap prefix injected into agent context.
//
// Load order (priority):
//   1. AGENTS.md   — operating instructions and behavioral rules
//   2. USER.md     — user profile and preferences
//   3. IDENTITY.md — agent persona, name, tone
//   4. Any other .md files (alphabetical)
//
// Drop any .md file into ./workspace/ and it will be auto-loaded.
// Reload happens every 5 minutes (or on explicit invalidation).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace");

// ── Defaults ─────────────────────────────────────────────────────────

const PRIORITY_FILES = ["AGENTS.md", "USER.md", "IDENTITY.md"];
const DEFAULT_FILE_MAX_CHARS  = 20_000;
const DEFAULT_TOTAL_MAX_CHARS = 150_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Cache ─────────────────────────────────────────────────────────────

interface WorkspaceCache {
  bootstrap: string;
  files: string[];
  expiry: number;
}

let _cache: WorkspaceCache | null = null;
let _workspaceDir: string | null = null;

/** Override the workspace directory (defaults to ./workspace relative to cwd). */
export function setWorkspaceDir(dir: string): void {
  _workspaceDir = dir;
  _cache = null;
}

function getWorkspaceDir(): string {
  return _workspaceDir ?? join(process.cwd(), "workspace");
}

// ── Internal reader ───────────────────────────────────────────────────

async function readWorkspaceFiles(
  dir: string,
  fileMaxChars: number,
  totalMaxChars: number,
): Promise<{ bootstrap: string; files: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { bootstrap: "", files: [] }; // folder absent — silent
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const priority = PRIORITY_FILES.filter((p) => mdFiles.includes(p));
  const others   = mdFiles.filter((f) => !PRIORITY_FILES.includes(f)).sort();
  const ordered  = [...priority, ...others];

  const sections: string[] = [];
  let totalChars = 0;
  const loaded: string[] = [];

  for (const filename of ordered) {
    if (totalChars >= totalMaxChars) break;

    try {
      let content = await readFile(join(dir, filename), "utf-8");

      if (content.length > fileMaxChars) {
        content = content.slice(0, fileMaxChars) + "\n\n[... truncated]";
      }

      const remaining = totalMaxChars - totalChars;
      if (content.length > remaining) {
        content = content.slice(0, remaining) + "\n\n[... truncated]";
      }

      const section = `## ${filename}\n\n${content.trim()}`;
      sections.push(section);
      totalChars += section.length;
      loaded.push(filename);
    } catch {
      // unreadable — skip
    }
  }

  const bootstrap = sections.length > 0
    ? `# Workspace\n\n${sections.join("\n\n---\n\n")}`
    : "";

  return { bootstrap, files: loaded };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Returns the cached workspace bootstrap string.
 * Re-reads disk every CACHE_TTL_MS (5 min).
 */
export async function loadWorkspaceBootstrap(
  fileMaxChars  = DEFAULT_FILE_MAX_CHARS,
  totalMaxChars = DEFAULT_TOTAL_MAX_CHARS,
): Promise<string> {
  const now = Date.now();
  if (_cache && now < _cache.expiry) return _cache.bootstrap;

  const dir = getWorkspaceDir();
  const { bootstrap, files } = await readWorkspaceFiles(dir, fileMaxChars, totalMaxChars);

  _cache = { bootstrap, files, expiry: now + CACHE_TTL_MS };

  if (files.length > 0) {
    log.active(`Loaded workspace files: ${files.join(", ")} (${bootstrap.length} chars)`);
  }

  return bootstrap;
}

/** Force the cache to reload on the next call. */
export function invalidateWorkspaceCache(): void {
  _cache = null;
}

/** Returns the list of files loaded in the last cache fill (empty if none). */
export function getLoadedWorkspaceFiles(): string[] {
  return _cache?.files ?? [];
}
