import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, basename, sep } from "node:path";
import { homedir } from "node:os";
import { registerTool } from "./registry.js";
import { getAgentConfig } from "../config/agents.js";
import { validateFilePath, PathTraversalError } from "../utils/path-validator.js";

// ── file_write Tool ─────────────────────────────────────────────────
// Writes content to a file on the local filesystem. Creates parent
// directories if needed. Respects per-agent fileAccess restrictions.

const FileWriteParams = z.object({
  path: z.string().describe("Absolute or relative file path to write"),
  content: z.string().describe("Content to write to the file"),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("Content encoding"),
  append: z
    .boolean()
    .default(false)
    .describe("Append to file instead of overwriting"),
});

function expandPath(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

registerTool({
  name: "file_write",
  description:
    "Write content to a file on the local filesystem. Creates parent directories if they don't exist. Can overwrite or append. Use for saving results, generating configs, writing data exports, etc.",
  parameters: FileWriteParams,
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

    // Safety: block writing to sensitive file names (cross-platform)
    const BLOCKED_NAMES = [".env", ".npmrc", ".netrc", "node_modules"];
    const fileName = basename(filePath);
    const pathSegments = filePath.split(sep);
    const isBlocked =
      BLOCKED_NAMES.some((n) => fileName === n || fileName.startsWith(n + ".") || fileName.endsWith("." + n.replace(/^\./, "")) || pathSegments.includes(n));
    if (isBlocked) {
      return { error: "Writing to this location is restricted for security." };
    }

    // Per-agent file access restrictions
    const agentConfig = ctx?.agentId ? getAgentConfig(ctx.agentId) : null;
    if (agentConfig?.fileAccess?.restricted) {
      if (agentConfig.fileAccess.allowedPaths.length === 0) {
        return { error: `File write denied. Agent "${ctx.agentId}" has no allowed paths configured.` };
      }
      const allowed = agentConfig.fileAccess.allowedPaths.map(expandPath);
      const isAllowed = allowed.some((p) => filePath.startsWith(p));
      if (!isAllowed) {
        return { error: `File write restricted. Agent "${ctx.agentId}" can only write to: ${allowed.join(", ")}` };
      }
    }

    // Ensure parent directory exists
    await mkdir(dirname(filePath), { recursive: true });

    const flag = params.append ? "a" : "w";
    await writeFile(filePath, params.content, {
      encoding: params.encoding as BufferEncoding,
      flag,
    });

    return {
      path: filePath,
      bytes: Buffer.byteLength(params.content, params.encoding as BufferEncoding),
      appended: params.append,
      message: params.append
        ? `Appended ${Buffer.byteLength(params.content)} bytes to ${filePath}`
        : `Wrote ${Buffer.byteLength(params.content)} bytes to ${filePath}`,
    };
  },
});
