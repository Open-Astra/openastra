// ── Workspace File Watcher ───────────────────────────────────────────
// Watches ./workspace/*.md for changes and syncs content to the DB.
// On each file-change event:
//   1. Read the new file content
//   2. Compute sha256 checksum
//   3. Skip if checksum matches what's already in DB (no-op for editor noise)
//   4. Upsert into workspace_files table
//   5. Invalidate the in-memory bootstrap cache so agents get fresh content
//
// Also exports syncWorkspaceFilesToDb() for startup seeding.

import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getPool } from "../config/postgres.js";
import { invalidateWorkspaceCache } from "./loader.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace");

// ── Internals ─────────────────────────────────────────────────────────

let _watcher: FSWatcher | null = null;
const _debounce = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function getWorkspaceDir(): string {
  return join(process.cwd(), "workspace");
}

// ── Sync a single file to DB ──────────────────────────────────────────

async function syncFile(filename: string): Promise<boolean> {
  if (!filename.endsWith(".md")) return false;

  const filePath = join(getWorkspaceDir(), filename);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return false; // File deleted or unreadable — skip
  }

  const checksum = sha256(content);
  const pool = getPool();

  // Check if content actually changed before writing
  const { rows } = await pool.query<{ checksum: string }>(
    "SELECT checksum FROM workspace_files WHERE filename = $1 LIMIT 1",
    [filename],
  );

  if (rows[0]?.checksum === checksum) return false; // No change

  await pool.query(
    `INSERT INTO workspace_files (filename, content, file_path, checksum, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (filename) DO UPDATE SET
       content    = EXCLUDED.content,
       file_path  = EXCLUDED.file_path,
       checksum   = EXCLUDED.checksum,
       updated_at = NOW()`,
    [filename, content, filePath, checksum],
  );

  // Invalidate in-memory cache so agents pick up new content next request
  invalidateWorkspaceCache();
  log.active(`Workspace synced: ${filename}`);
  return true;
}

// ── Sync all files on startup ─────────────────────────────────────────

export async function syncWorkspaceFilesToDb(): Promise<number> {
  const dir = getWorkspaceDir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // workspace/ folder doesn't exist — fine
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  let synced = 0;

  for (const filename of mdFiles) {
    const changed = await syncFile(filename).catch(() => false);
    if (changed) synced++;
  }

  if (mdFiles.length > 0) {
    log.dim(`Workspace startup sync: ${mdFiles.length} file(s), ${synced} updated`);
  }

  return synced;
}

// ── fs.watch watcher ──────────────────────────────────────────────────

export function startWorkspaceWatcher(): void {
  const dir = getWorkspaceDir();

  try {
    _watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".md")) return;

      // Debounce — editors fire many events per save
      const existing = _debounce.get(filename);
      if (existing) clearTimeout(existing);

      _debounce.set(
        filename,
        setTimeout(() => {
          _debounce.delete(filename);
          syncFile(filename).catch((err: unknown) => {
            log.error(`Workspace sync error for ${filename}:`, err);
          });
        }, DEBOUNCE_MS),
      );
    });

    log.active(`Watching workspace/`, `${dir}`);
  } catch {
    // Workspace folder doesn't exist yet — watcher will be skipped
    log.dim("workspace/ folder not found — create it to enable file watching");
  }
}

export function stopWorkspaceWatcher(): void {
  for (const timer of _debounce.values()) clearTimeout(timer);
  _debounce.clear();

  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}
