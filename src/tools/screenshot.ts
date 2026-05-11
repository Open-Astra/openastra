import { z } from "zod";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { registerTool } from "./registry.js";

// ── screenshot ────────────────────────────────────────────────────────
// Capture screenshots using platform-native commands.
// For URL screenshots, suggests using url_fetch instead (no browser dep).

const ScreenshotParams = z.object({
  url: z
    .string()
    .optional()
    .describe("URL to screenshot (note: requires browser — suggest url_fetch for web content)"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector for element screenshot (only works with browser-based capture)"),
  fullPage: z
    .boolean()
    .default(false)
    .describe("Capture the full scrollable page (default false)"),
  outputPath: z
    .string()
    .optional()
    .describe("Output file path (defaults to /tmp/astra-screenshot-{timestamp}.png)"),
});

function execPromise(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}

registerTool({
  name: "screenshot",
  description:
    "Capture a screenshot of the current screen. On macOS, uses the native screencapture command. On Linux, uses import (ImageMagick) or scrot. On Windows, uses PowerShell. Note: URL screenshotting requires a browser — consider using url_fetch for web content instead.",
  parameters: ScreenshotParams,
  async execute(params) {
    // If a URL is provided, we can't screenshot it without a browser
    if (params.url) {
      return {
        error:
          "Screenshotting URLs requires a headless browser which is not available. " +
          "Use the url_fetch tool to retrieve web content, or use a browser-based " +
          "tool/skill if one is available.",
        suggestion: "url_fetch",
        url: params.url,
      };
    }

    const platform = process.platform;
    const timestamp = Date.now();
    const outputPath =
      params.outputPath ||
      (platform === "win32"
        ? `${process.env.TEMP || "C:\\Temp"}\\astra-screenshot-${timestamp}.png`
        : `/tmp/astra-screenshot-${timestamp}.png`);

    try {
      if (platform === "darwin") {
        // macOS: use screencapture
        const args = ["-x"]; // -x = no sound
        if (!params.fullPage) {
          args.push("-R", "0,0,1920,1080"); // default viewport
        }
        args.push(outputPath);

        await execPromise("screencapture", args);
      } else if (platform === "linux") {
        // Linux: try import (ImageMagick) first, fall back to scrot
        try {
          const args = params.fullPage
            ? ["-window", "root", outputPath]
            : ["-window", "root", "-crop", "1920x1080+0+0", outputPath];

          await execPromise("import", args);
        } catch {
          // Fallback to scrot
          await execPromise("scrot", [outputPath]);
        }
      } else if (platform === "win32") {
        // Windows: use PowerShell with .NET to capture screen
        const psScript = `
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen
          $bounds = $screen.Bounds
          $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
          $bitmap.Save('${outputPath.replace(/'/g, "''")}')
          $graphics.Dispose()
          $bitmap.Dispose()
        `.trim();

        await execPromise("powershell.exe", ["-NoProfile", "-Command", psScript], 15_000);
      } else {
        return { error: `Unsupported platform for screenshots: ${platform}` };
      }

      // Verify the file was created and get its size
      const info = await stat(outputPath);

      return {
        path: outputPath,
        size: info.size,
        platform,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Screenshot failed: ${msg}` };
    }
  },
});
