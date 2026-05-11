// ── Console Scrubbing Patch ──────────────────────────────────────────
// Monkey-patches console.log, console.warn, and console.error to run
// all arguments through the log scrubber before printing. This catches
// the 50+ call sites that use raw console.error(tag, err) instead of
// the structured logger — preventing secret/PII leakage in error stacks,
// DB connection strings, and HTTP error messages.
//
// Import this module ONCE at process startup, before any other imports.
// Scrubbing is idempotent so double-scrubbing via createLogger() is safe.

import { scrubLogOutput } from "./logger.js";

function scrubArg(arg: unknown): unknown {
  if (typeof arg === "string") return scrubLogOutput(arg);
  if (arg instanceof Error) {
    // Scrub the message — stack traces reference it, so this covers both.
    // We clone to avoid mutating the original Error object.
    const scrubbed = scrubLogOutput(arg.message);
    if (scrubbed !== arg.message) {
      const clone = new Error(scrubbed);
      clone.name = arg.name;
      clone.stack = arg.stack
        ? arg.stack.replace(arg.message, scrubbed)
        : undefined;
      return clone;
    }
    return arg;
  }
  if (arg !== null && typeof arg === "object") {
    try {
      const json = JSON.stringify(arg);
      if (json.length > 12) {
        const scrubbed = scrubLogOutput(json);
        if (scrubbed !== json) return JSON.parse(scrubbed);
      }
    } catch {
      // Non-serializable — return as-is
    }
  }
  return arg;
}

// Save originals
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log = (...args: unknown[]) => _origLog(...args.map(scrubArg));
console.warn = (...args: unknown[]) => _origWarn(...args.map(scrubArg));
console.error = (...args: unknown[]) => _origError(...args.map(scrubArg));
