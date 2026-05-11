import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { resolve, basename, sep } from "node:path";
import { homedir } from "node:os";
import { registerTool } from "./registry.js";
import { getAgentConfig } from "../config/agents.js";
import { validateFilePath, PathTraversalError } from "../utils/path-validator.js";

// ── file_read Tool ──────────────────────────────────────────────────
// Reads a file from the local filesystem. Agents can use this to
// inspect config files, logs, data files, etc.
// Respects per-agent fileAccess restrictions from agent config.

const FileReadParams = z.object({
  path: z.string().describe("Absolute or relative file path to read"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100_000)
    .describe("Maximum bytes to read (default 100KB, max 1MB)"),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("File encoding"),
});

function expandPath(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

registerTool({
  name: "file_read",
  description:
    "Read a file from the local filesystem. Returns the file content as text (UTF-8) or base64. Use for inspecting configs, logs, data files, or any local file the agent needs to reference.",
  parameters: FileReadParams,
  async execute(params, ctx) {
    // CWD containment + null byte + path traversal protection
    let filePath: string;
    try {
      filePath = validateFilePath(params.path);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return { error: err.message };
      }
      return { error: "Invalid file path." };
    }

    // Safety: block common sensitive file names (cross-platform)
    const BLOCKED_NAMES = [".env", ".npmrc", ".netrc"];
    const fileName = basename(filePath);
    const pathSegments = filePath.split(sep);
    const isBlocked =
      BLOCKED_NAMES.some((n) => fileName === n || fileName.startsWith(n + ".") || fileName.endsWith("." + n.replace(/^\./, "")) || pathSegments.includes(n));
    if (isBlocked) {
      return { error: "Access to this file is restricted for security." };
    }

    // Per-agent file access restrictions
    const agentConfig = ctx?.agentId ? getAgentConfig(ctx.agentId) : null;
    if (agentConfig?.fileAccess?.restricted) {
      if (agentConfig.fileAccess.allowedPaths.length === 0) {
        return { error: `File access denied. Agent "${ctx.agentId}" has no allowed paths configured.` };
      }
      const allowed = agentConfig.fileAccess.allowedPaths.map(expandPath);
      const isAllowed = allowed.some((p) => filePath.startsWith(p));
      if (!isAllowed) {
        return { error: `File access restricted. Agent "${ctx.agentId}" can only access: ${allowed.join(", ")}` };
      }
    }

    const info = await stat(filePath);
    if (!info.isFile()) {
      return { error: `Not a file: ${filePath}` };
    }

    if (info.size > params.maxBytes) {
      const content = await readFile(filePath, params.encoding as BufferEncoding);
      return {
        path: filePath,
        size: info.size,
        truncated: true,
        content: content.slice(0, params.maxBytes),
        message: `File truncated to ${params.maxBytes} bytes (full size: ${info.size})`,
      };
    }

    const content = await readFile(filePath, params.encoding as BufferEncoding);
    return {
      path: filePath,
      size: info.size,
      truncated: false,
      content,
    };
  },
});
