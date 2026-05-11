import { resolve, sep } from "node:path";
import { recordThreat } from "../security/intrusion-detection.js";

// ── Path Validator ──────────────────────────────────────────────────
// Shared utility for preventing path traversal attacks across all
// file-handling tools. Validates that resolved paths stay within
// an allowed base directory and blocks null bytes + encoded bypass vectors.

/**
 * Validate and resolve a file path, ensuring it stays within an allowed base directory.
 * Throws on invalid or dangerous paths.
 *
 * @param filePath - The raw path input from the user/agent
 * @param baseDir - The allowed base directory (defaults to process.cwd())
 * @returns The validated absolute path
 */
export function validateFilePath(filePath: string, baseDir?: string): string {
  const base = baseDir ?? process.cwd();

  // Block null bytes — can truncate paths in C-level APIs
  if (filePath.includes("\0") || filePath.includes("%00")) {
    recordThreat({ category: "path_traversal", sourceIp: "unknown", detail: `null byte in path: ${filePath.slice(0, 100)}`, timestamp: Date.now() });
    throw new PathTraversalError("Null bytes are not allowed in file paths");
  }

  // Decode common URL-encoded traversal sequences before resolution
  let decoded = filePath;
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    // If decoding fails, use the original — it may not be URL-encoded
  }

  // Block null bytes again after decoding
  if (decoded.includes("\0")) {
    throw new PathTraversalError("Null bytes are not allowed in file paths");
  }

  // Resolve to absolute path
  const resolved = resolve(decoded);

  // Verify resolved path starts with the base directory
  const normalizedBase = resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + sep)) {
    recordThreat({ category: "path_traversal", sourceIp: "unknown", detail: `traversal attempt: ${filePath.slice(0, 100)}`, timestamp: Date.now() });
    throw new PathTraversalError(
      `Path "${filePath}" resolves outside the allowed directory`,
    );
  }

  return resolved;
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}
