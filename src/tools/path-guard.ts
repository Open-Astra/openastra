import { realpathSync, existsSync } from "node:fs";
import { resolve, sep, dirname, basename, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { getAgentConfig } from "../config/agents.js";
import { validateFilePath, PathTraversalError } from "../utils/path-validator.js";

// ── Path Guard ──────────────────────────────────────────────────────
// One place every file-touching tool resolves a caller-supplied path:
//
//   1. null-byte / encoded-traversal rejection + cwd containment
//      (utils/path-validator.ts)
//   2. symlink resolution — the REAL path must still be inside the allowed
//      root, so a link inside the workspace cannot point at /etc or ~/.ssh
//   3. separator-safe prefix checks ("/srv/app" does not allow "/srv/app-evil")
//   4. per-agent fileAccess.allowedPaths, when restricted
//   5. a secrets blocklist (.env*, keys, credentials) for reads AND writes
//   6. in server mode, a write blocklist for anything the process loads as
//      code or config (src/, dist/, plugins, skills, astra.yml, SOUL.md,
//      package.json, ...) — writing those is code execution on next
//      import/restart.

export class PathGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathGuardError";
  }
}

export type PathAccess = "read" | "write" | "list" | "exec";

export interface PathGuardOptions {
  access: PathAccess;
  agentId?: string;
  /** Base directory relative paths resolve against (default: process.cwd()). */
  baseDir?: string;
}

// ── Secret material ────────────────────────────────────────────────

const SECRET_BASENAMES = new Set([
  ".npmrc", ".netrc", ".pgpass", ".htpasswd", "credentials.json", "credentials",
  "service-account.json", "service-account-key.json", "token.json", "tokens.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys", "known_hosts",
  ".age-recipients", "secrets.yml", "secrets.yaml", "secrets.json",
]);

const SECRET_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".astra", ".azure", ".gcloud",
]);

const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|crt|csr|kdbx|age)$/i;

export function isSecretPath(absPath: string): boolean {
  const segments = absPath.split(/[\\/]+/).filter(Boolean);
  const name = (segments[segments.length - 1] ?? "").toLowerCase();

  // .env, .env.local, .env.production, foo.env — but not .env.example/.sample/.template
  if (/^\.env(\..+)?$/.test(name) || /\.env$/.test(name)) {
    if (!/\.(example|sample|template|dist)$/.test(name)) return true;
  }
  if (SECRET_BASENAMES.has(name)) return true;
  if (SECRET_EXTENSIONS.test(name)) return true;
  if (/^service[-_]?account.*\.json$/.test(name)) return true;
  for (const seg of segments.slice(0, -1)) {
    const s = seg.toLowerCase();
    if (SECRET_SEGMENTS.has(s)) return true;
    if (/^\.env(\..+)?$/.test(s)) return true;
  }
  // .git internals hold remotes with embedded credentials and executable hooks
  const gitIdx = segments.map((s) => s.toLowerCase()).indexOf(".git");
  if (gitIdx !== -1 && gitIdx < segments.length - 1) return true;
  return false;
}

// ── Code / config the gateway loads ────────────────────────────────

const PROTECTED_WRITE_DIRS = [
  "src", "dist", "node_modules", "scripts", "deploy", "helm", "k8s", "prompts", "dashboard",
  ".git", ".github", ".codex", ".claude", "plugins", "skills", "tests",
];

const PROTECTED_WRITE_FILES = new Set([
  "astra.yml", "astra.yaml", "soul.md", "agents.md", "claude.md", "package.json",
  "package-lock.json", "tsconfig.json", "astra.mjs", "dockerfile", "docker-compose.yml",
  "docker-compose.yaml", "vitest.config.ts", ".dockerignore", ".gitignore", ".npmrc",
]);

function isProtectedWriteTarget(absPath: string, root: string): boolean {
  const rel = relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const first = (parts[0] ?? "").toLowerCase();
  if (parts.length === 1 && PROTECTED_WRITE_FILES.has(first)) return true;
  if (PROTECTED_WRITE_DIRS.includes(first)) return true;
  // any nested node_modules / .git
  return parts.some((p) => p === "node_modules" || p === ".git");
}

// ── Helpers ────────────────────────────────────────────────────────

/** Separator-safe containment check. */
export function isWithin(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return child === p || child.startsWith(p + sep);
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve symlinks for a path that may not exist yet: realpath the nearest
 * existing ancestor and re-append the remaining segments.
 */
export function realpathAllowMissing(absPath: string): string {
  let current = absPath;
  const tail: string[] = [];
  // Walk up until something exists (bounded by path depth).
  for (let i = 0; i < 256; i++) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) break;
    tail.push(basename(current));
    current = parent;
  }
  return absPath;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Validate a caller-supplied path for the given access and return the real
 * (symlink-resolved) absolute path. Throws PathGuardError when refused.
 */
export function guardPath(inputPath: string, opts: PathGuardOptions): string {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new PathGuardError("A file path is required.");
  }

  const base = resolve(opts.baseDir ?? process.cwd());
  const realBase = safeRealpath(base);

  // 1. Lexical validation (null bytes, encoded traversal, containment).
  let lexical: string;
  try {
    lexical = validateFilePath(isAbsolute(inputPath) ? inputPath : resolve(base, inputPath), base);
  } catch (err) {
    if (err instanceof PathTraversalError) throw new PathGuardError(err.message);
    throw new PathGuardError("Invalid file path.");
  }

  // 2. Symlink resolution — the real target must still be inside the root.
  const real = realpathAllowMissing(lexical);
  if (!isWithin(real, realBase)) {
    throw new PathGuardError(`Path "${inputPath}" resolves (via a symlink) outside the allowed directory`);
  }

  // 3. Secrets — checked on both the requested and the real path.
  if (isSecretPath(lexical) || isSecretPath(real)) {
    throw new PathGuardError("Access to this file is restricted for security.");
  }

  // 4. Per-agent restrictions. An unknown agent is refused (fail closed).
  if (opts.agentId) {
    let agentConfig: { fileAccess?: { restricted?: boolean; allowedPaths: string[] } } | null = null;
    try {
      agentConfig = getAgentConfig(opts.agentId);
    } catch {
      throw new PathGuardError(`File access denied: agent "${opts.agentId}" could not be resolved.`);
    }
    if (agentConfig?.fileAccess?.restricted) {
      const allowed = (agentConfig.fileAccess.allowedPaths ?? []).map((p) => safeRealpath(expandHome(p)));
      if (allowed.length === 0) {
        throw new PathGuardError(`File access denied. Agent "${opts.agentId}" has no allowed paths configured.`);
      }
      if (!allowed.some((p) => isWithin(real, p))) {
        throw new PathGuardError(
          `File access restricted. Agent "${opts.agentId}" can only access: ${agentConfig.fileAccess.allowedPaths.join(", ")}`,
        );
      }
    }
  }

  // 5. Server mode: never write (or execute from) anything the gateway
  //    itself loads as code or configuration.
  if ((opts.access === "write" || opts.access === "exec") && !process.env.ASTRA_STANDALONE) {
    if (isProtectedWriteTarget(real, safeRealpath(process.cwd()))) {
      throw new PathGuardError(
        opts.access === "write"
          ? "Writing to application code or configuration is not allowed."
          : "Running commands inside application code directories is not allowed.",
      );
    }
  }

  return real;
}

/** Convenience wrapper returning `{ path }` or `{ error }` for tool handlers. */
export function tryGuardPath(
  inputPath: string,
  opts: PathGuardOptions,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    return { ok: true, path: guardPath(inputPath, opts) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid file path." };
  }
}
