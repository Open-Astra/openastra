import { z } from "zod";
import { execFile } from "node:child_process";
import { registerTool } from "./registry.js";

// ── clipboard ─────────────────────────────────────────────────────────
// Read/write system clipboard using platform-native commands.

const ClipboardParams = z.object({
  operation: z
    .enum(["read", "write"])
    .describe("Operation: 'read' to get clipboard content, 'write' to set it"),
  content: z
    .string()
    .optional()
    .describe("Content to write to clipboard (required for write operation)"),
});

const MAX_CLIPBOARD = 1_000_000; // 1MB cap

function execPromise(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 5000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_CLIPBOARD * 2 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

registerTool({
  name: "clipboard",
  description:
    "Read from or write to the system clipboard. Automatically detects the OS (macOS, Linux, Windows) and uses the appropriate native clipboard command. Use for copying data between the agent and the user's clipboard.",
  parameters: ClipboardParams,
  async execute(params) {
    const platform = process.platform;

    try {
      if (params.operation === "read") {
        let result: { stdout: string };

        if (platform === "darwin") {
          result = await execPromise("pbpaste", []);
        } else if (platform === "linux") {
          result = await execPromise("xclip", ["-selection", "clipboard", "-o"]);
        } else if (platform === "win32") {
          result = await execPromise("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Get-Clipboard",
          ]);
        } else {
          return { error: `Unsupported platform: ${platform}` };
        }

        return { content: result.stdout };
      }

      if (params.operation === "write") {
        if (params.content === undefined) {
          return { error: "content is required for write operation" };
        }

        if (params.content.length > MAX_CLIPBOARD) {
          return { error: `Content exceeds maximum clipboard size (${MAX_CLIPBOARD} bytes)` };
        }

        if (platform === "darwin") {
          await execPromise("pbcopy", [], params.content);
        } else if (platform === "linux") {
          await execPromise("xclip", ["-selection", "clipboard"], params.content);
        } else if (platform === "win32") {
          // Use Set-Clipboard with pipeline input via stdin
          await execPromise(
            "powershell.exe",
            ["-NoProfile", "-Command", "$input | Set-Clipboard"],
            params.content,
          );
        } else {
          return { error: `Unsupported platform: ${platform}` };
        }

        return { success: true, bytesWritten: params.content.length };
      }

      return { error: `Unknown operation: ${params.operation}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
