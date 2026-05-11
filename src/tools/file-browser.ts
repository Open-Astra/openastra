import { z } from "zod";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { registerTool } from "./registry.js";

// ── File Browser Tools ──────────────────────────────────────────────
// Three tools for listing, reading, and writing files within the CWD.
// All paths are resolved against process.cwd() and validated to prevent
// directory traversal attacks.

const MAX_FILE_BYTES = 1_048_576; // 1 MB

function safePath(inputPath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, inputPath);
  // Allow exactly cwd itself or anything underneath it
  if (resolved !== cwd && !resolved.startsWith(cwd + "/") && !resolved.startsWith(cwd + "\\")) {
    throw new Error(`Path traversal denied: "${inputPath}" resolves outside the working directory`);
  }
  return resolved;
}

// ── Simple glob → regex converter ───────────────────────────────────
// Supports * (any chars except separator) and ** (any chars including separator).

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (except * ?)
    .replace(/\*\*/g, "§§") // placeholder for **
    .replace(/\*/g, "[^/\\\\]*") // * → any non-sep chars
    .replace(/§§/g, ".*") // ** → any chars
    .replace(/\?/g, "[^/\\\\]"); // ? → any single non-sep char
  return new RegExp(`^${escaped}$`);
}

// ── file-list ────────────────────────────────────────────────────────

const FileListParams = z.object({
  path: z.string().describe("Directory path to list (relative to cwd or absolute within cwd)"),
  pattern: z.string().optional().describe("Optional glob pattern to filter file names (e.g. '*.ts', '**/*.json')"),
});

registerTool({
  name: "file-list",
  description: "List files and directories in a given path. Optionally filter by glob pattern. Restricted to the process working directory.",
  parameters: FileListParams,
  async execute(params, _ctx) {
    let safe: string;
    try {
      safe = safePath(params.path);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(safe, { withFileTypes: true });
    } catch (err) {
      return { error: `Cannot read directory: ${err instanceof Error ? err.message : String(err)}` };
    }

    const patternRe = params.pattern ? globToRegex(params.pattern) : null;

    const files: string[] = [];
    const dirs: string[] = [];

    for (const entry of entries) {
      if (patternRe && !patternRe.test(entry.name)) continue;
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }

    return { files, dirs, count: files.length + dirs.length };
  },
});

// ── file-fetch ───────────────────────────────────────────────────────

const FileFetchParams = z.object({
  path: z.string().describe("File path to read (relative to cwd or absolute within cwd)"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Return encoding: 'utf8' (default) or 'base64'"),
});

registerTool({
  name: "file-fetch",
  description: "Read the contents of a file. Limited to 1 MB. Restricted to the process working directory.",
  parameters: FileFetchParams,
  async execute(params, _ctx) {
    let safe: string;
    try {
      safe = safePath(params.path);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    let buf: Buffer;
    try {
      buf = await readFile(safe);
    } catch (err) {
      return { error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (buf.byteLength > MAX_FILE_BYTES) {
      return { error: `File exceeds the 1 MB limit (${buf.byteLength} bytes)` };
    }

    const content =
      params.encoding === "base64"
        ? buf.toString("base64")
        : buf.toString("utf8");

    return { content, size: buf.byteLength, encoding: params.encoding };
  },
});

// ── file-write ───────────────────────────────────────────────────────

const FileWriteParams = z.object({
  path: z.string().describe("File path to write (relative to cwd or absolute within cwd)"),
  content: z.string().describe("Content to write"),
  encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of `content`: 'utf8' (default) or 'base64'"),
});

registerTool({
  name: "file-write",
  description: "Write content to a file, creating parent directories as needed. Restricted to the process working directory.",
  parameters: FileWriteParams,
  async execute(params, _ctx) {
    let safe: string;
    try {
      safe = safePath(params.path);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    // Create parent directories if needed
    try {
      await mkdir(dirname(safe), { recursive: true });
    } catch (err) {
      return { error: `Cannot create parent directories: ${err instanceof Error ? err.message : String(err)}` };
    }

    const buf =
      params.encoding === "base64"
        ? Buffer.from(params.content, "base64")
        : Buffer.from(params.content, "utf8");

    try {
      await writeFile(safe, buf);
    } catch (err) {
      return { error: `Cannot write file: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { path: safe, bytesWritten: buf.byteLength };
  },
});
