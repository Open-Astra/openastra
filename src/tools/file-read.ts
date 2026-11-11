import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { registerTool } from "./registry.js";
import { tryGuardPath } from "./path-guard.js";

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

registerTool({
  name: "file_read",
  description:
    "Read a file from the local filesystem. Returns the file content as text (UTF-8) or base64. Use for inspecting configs, logs, data files, or any local file the agent needs to reference.",
  parameters: FileReadParams,
  async execute(params, ctx) {
    // Containment, symlink resolution, secrets blocklist and per-agent
    // fileAccess restrictions (separator-safe) — see path-guard.ts.
    const guarded = tryGuardPath(params.path, { access: "read", agentId: ctx?.agentId });
    if (!guarded.ok) {
      return { error: guarded.error };
    }
    const filePath = guarded.path;

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
