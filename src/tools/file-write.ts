import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { registerTool } from "./registry.js";
import { tryGuardPath } from "./path-guard.js";

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

registerTool({
  name: "file_write",
  description:
    "Write content to a file on the local filesystem. Creates parent directories if they don't exist. Can overwrite or append. Use for saving results, generating configs, writing data exports, etc.",
  parameters: FileWriteParams,
  async execute(params, ctx) {
    // Containment, symlink resolution, secrets blocklist, per-agent
    // fileAccess restrictions and (server mode) the protected code/config
    // write list — see path-guard.ts.
    const guarded = tryGuardPath(params.path, { access: "write", agentId: ctx?.agentId });
    if (!guarded.ok) {
      return { error: guarded.error };
    }
    const filePath = guarded.path;

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
