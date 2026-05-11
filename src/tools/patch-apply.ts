import { z } from "zod";
import { resolve, sep } from "node:path";
import { registerTool } from "./registry.js";
import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../utils/logger.js";

const log = createLogger("patch-apply");

// ── patch-apply Tool ─────────────────────────────────────────────────
// Apply a unified diff patch to a file.
// Uses the `diff` npm package if available; falls back to a built-in
// simple unified diff applier so the tool works without extra deps.

const Params = z.object({
  filePath: z.string().describe("Absolute or relative path to the file to patch"),
  patch: z.string().describe("Unified diff string (output of diff -u or git diff)"),
  dryRun: z.boolean().optional().default(false).describe("Validate without writing (dry run)"),
});

// ── Fallback unified diff applier ────────────────────────────────────
// Handles the standard @@ -l,s +l,s @@ hunk format.

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = patch.split("\n");
  let current: Hunk | null = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(header[1]!, 10),
        oldCount: parseInt(header[2] ?? "1", 10),
        newStart: parseInt(header[3]!, 10),
        newCount: parseInt(header[4] ?? "1", 10),
        lines: [],
      };
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function applyUnifiedPatch(original: string, patch: string): string | null {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return null;

  const originalLines = original.split("\n");
  const result: string[] = [...originalLines];
  let offset = 0;

  for (const hunk of hunks) {
    const startIdx = hunk.oldStart - 1 + offset;

    // Verify context lines match
    let origIdx = startIdx;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        if (result[origIdx] !== line.slice(1)) return null;
        origIdx++;
      } else if (line.startsWith("-")) {
        if (result[origIdx] !== line.slice(1)) return null;
        origIdx++;
      }
    }

    // Apply the hunk
    const removedLines: string[] = [];
    const addedLines: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("-")) removedLines.push(line.slice(1));
      else if (line.startsWith("+")) addedLines.push(line.slice(1));
    }

    const contextBefore: string[] = [];
    const contextAfter: string[] = [];
    let seenMutation = false;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        if (!seenMutation) contextBefore.push(line.slice(1));
        else contextAfter.push(line.slice(1));
      } else {
        seenMutation = true;
      }
    }

    // Splice: replace removed lines with added lines at the hunk position
    const spliceStart = startIdx + contextBefore.length;
    result.splice(spliceStart, removedLines.length, ...addedLines);
    offset += addedLines.length - removedLines.length;
  }

  return result.join("\n");
}

registerTool({
  name: "patch-apply",
  description:
    "Apply a unified diff patch to a file. Validates that the patch applies cleanly before writing. Supports dry-run mode to preview changes without modifying the file. Use for applying code changes expressed as diff -u or git diff output.",
  parameters: Params,
  async execute(params, _ctx) {
    const { filePath, patch, dryRun } = params;

    // Block null bytes — path truncation attack vector
    if (filePath.includes("\0") || filePath.includes("%00")) {
      return { error: "Null bytes are not allowed in file paths." };
    }

    // Guard against path traversal — resolved path must stay within CWD
    const resolvedPath = resolve(filePath);
    const cwd = process.cwd();
    if (!resolvedPath.startsWith(cwd + sep) && resolvedPath !== cwd) {
      return { error: "Path must be within the current working directory" };
    }

    // Step 1: Read the original file (use resolvedPath, not raw filePath)
    let original: string;
    try {
      original = await readFile(resolvedPath, "utf-8");
    } catch (err) {
      return { error: `Could not read file "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
    }

    // Step 2: Try the `diff` package first, fall back to built-in
    let result: string | false | null = null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const diffPkg = await import("diff" as any) as unknown as { applyPatch?: (src: string, patch: string) => string | false };
      if (typeof diffPkg.applyPatch === "function") {
        result = diffPkg.applyPatch(original, patch);
        log.dim("Used 'diff' package for patch application");
      }
    } catch {
      // diff package not available — use built-in applier
      log.dim("'diff' package unavailable — using built-in applier");
    }

    if (result === null) {
      result = applyUnifiedPatch(original, patch);
    }

    if (result === false || result === null) {
      return { error: "Patch does not apply cleanly to file" };
    }

    // Step 3: Dry run — return preview only
    if (dryRun) {
      const preview = result.length > 500 ? result.slice(0, 500) + "..." : result;
      return { success: true, preview };
    }

    // Step 4: Write patched content back
    try {
      await writeFile(resolvedPath, result, "utf-8");
    } catch (err) {
      return { error: `Could not write file "${filePath}": ${err instanceof Error ? err.message : String(err)}` };
    }

    return { success: true, linesChanged: result.split("\n").length };
  },
});
