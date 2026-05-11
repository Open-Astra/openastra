import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Console Scrub Tests ─────────────────────────────────────────────
//
// The console-scrub module monkey-patches console.log, console.warn,
// and console.error to run all arguments through scrubLogOutput().
// We test by:
// 1. Mocking scrubLogOutput to simulate secret detection
// 2. Saving original console methods
// 3. Importing console-scrub (which patches console)
// 4. Calling the patched console methods and inspecting the output

// Create the mock function that simulates secret redaction
const mockScrub = vi.fn((msg: string) => {
  return msg
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:AKIA***]")
    .replace(/\bsk_(live|test)_[A-Za-z0-9]{24,}\b/g, "[REDACTED:sk_***]")
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{20,}/g, "[REDACTED:Bear***]")
    .replace(/\bghp_[A-Za-z0-9]{36,}\b/g, "[REDACTED:ghp_***]");
});

// Mock the logger module BEFORE console-scrub is imported
vi.mock("../../src/utils/logger.js", () => ({
  scrubLogOutput: mockScrub,
}));

// Save originals before the module patches them
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

// Spy on the originals to capture what actually gets printed
let logSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  mockScrub.mockClear();

  // Set up spies on the originals to capture output
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();

  // Restore originals first, then replace with spies
  console.log = logSpy;
  console.warn = warnSpy;
  console.error = errorSpy;

  // Reset module cache so console-scrub re-runs its patching code
  vi.resetModules();

  // Re-import console-scrub which will:
  // 1. Save current console.log/warn/error as _origLog/_origWarn/_origError
  // 2. Replace them with versions that call scrubArg on each argument
  await import("../../src/utils/console-scrub.js");
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
});

// ── Secret scrubbing ────────────────────────────────────────────────

describe("console-scrub — secret scrubbing", () => {
  it("scrubs AWS access key IDs from console.error arguments", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const message = `Connection failed with key ${awsKey}`;

    console.error(message);

    // The patched console.error calls scrubArg → scrubLogOutput on the string
    expect(mockScrub).toHaveBeenCalledWith(message);
    // The spy receives the scrubbed output
    expect(errorSpy).toHaveBeenCalled();
    const output = errorSpy.mock.calls[0][0];
    expect(output).toContain("[REDACTED:AKIA***]");
    expect(output).not.toContain(awsKey);
  });

  it("scrubs Bearer tokens from console.warn arguments", () => {
    const message = "Auth header: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature_data";

    console.warn(message);

    expect(mockScrub).toHaveBeenCalledWith(message);
    expect(warnSpy).toHaveBeenCalled();
    const output = warnSpy.mock.calls[0][0];
    expect(output).toContain("[REDACTED:Bear***]");
  });

  it("scrubs GitHub personal access tokens from console.log arguments", () => {
    const ghToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    const message = `Token: ${ghToken}`;

    console.log(message);

    expect(mockScrub).toHaveBeenCalledWith(message);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain("[REDACTED:ghp_***]");
  });
});

// ── Error object cloning ────────────────────────────────────────────

describe("console-scrub — Error cloning", () => {
  it("clones Error objects when message contains secrets (does not mutate original)", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const original = new Error(`Failed to connect with key ${awsKey}`);
    const originalMessage = original.message;

    console.error(original);

    // The original Error must NOT be mutated
    expect(original.message).toBe(originalMessage);
    // scrubLogOutput was called with the Error's message
    expect(mockScrub).toHaveBeenCalledWith(originalMessage);
    // The spy received a cloned Error with the scrubbed message
    expect(errorSpy).toHaveBeenCalled();
    const output = errorSpy.mock.calls[0][0];
    expect(output).toBeInstanceOf(Error);
    expect(output.message).toContain("[REDACTED:AKIA***]");
    expect(output).not.toBe(original);
  });

  it("preserves Error name on the cloned Error", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const original = new TypeError(`Bad key: ${awsKey}`);

    console.error(original);

    const output = errorSpy.mock.calls[0][0];
    expect(output).toBeInstanceOf(Error);
    expect(output.name).toBe("TypeError");
  });

  it("returns the same Error if message has no secrets", () => {
    const original = new Error("Nothing sensitive here");

    console.error(original);

    // scrubLogOutput returns the same string, so console-scrub returns
    // the original Error reference
    expect(mockScrub).toHaveBeenCalledWith("Nothing sensitive here");
    expect(errorSpy).toHaveBeenCalled();
    const output = errorSpy.mock.calls[0][0];
    // When scrubLogOutput returns the identical string, the original Error is passed through
    expect(output).toBe(original);
  });
});

// ── Normal string pass-through ──────────────────────────────────────

describe("console-scrub — normal string pass-through", () => {
  it("passes normal strings through unchanged", () => {
    const normalMessage = "Server started on port 3000";

    console.log(normalMessage);

    expect(mockScrub).toHaveBeenCalledWith(normalMessage);
    expect(logSpy).toHaveBeenCalled();
    // scrubLogOutput returns the same string for non-sensitive input
    expect(logSpy.mock.calls[0][0]).toBe(normalMessage);
  });

  it("handles empty strings without error", () => {
    console.log("");

    // Empty string is still a string, so scrubArg calls scrubLogOutput
    expect(mockScrub).toHaveBeenCalledWith("");
    expect(logSpy).toHaveBeenCalled();
    expect(logSpy.mock.calls[0][0]).toBe("");
  });
});

// ── Non-serializable objects ────────────────────────────────────────

describe("console-scrub — non-serializable objects", () => {
  it("handles objects with circular references gracefully", () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular.self = circular;

    // Should not throw — non-serializable objects are returned as-is
    expect(() => console.log(circular)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(circular);
  });

  it("handles objects with BigInt values gracefully", () => {
    const obj = { value: BigInt(9007199254740991) };

    // JSON.stringify throws on BigInt — console-scrub catches and returns as-is
    expect(() => console.log(obj)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(obj);
  });

  it("scrubs secrets found inside serializable objects", () => {
    const obj = { apiKey: "AKIAIOSFODNN7EXAMPLE", name: "test" };

    console.log(obj);

    // The object is JSON-serialized and the JSON string is passed to
    // scrubLogOutput for scrubbing
    expect(mockScrub).toHaveBeenCalled();
    // Find the call where the JSON string was passed
    const jsonCall = mockScrub.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("AKIA"),
    );
    expect(jsonCall).toBeDefined();
  });
});

// ── Primitive pass-through ──────────────────────────────────────────

describe("console-scrub — primitive pass-through", () => {
  it("passes null through unchanged", () => {
    expect(() => console.log(null)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(null);
  });

  it("passes undefined through unchanged", () => {
    expect(() => console.log(undefined)).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(undefined);
  });

  it("passes numbers through unchanged", () => {
    console.log(42);
    expect(logSpy).toHaveBeenCalledWith(42);
  });

  it("passes booleans through unchanged", () => {
    console.log(true);
    expect(logSpy).toHaveBeenCalledWith(true);
  });

  it("handles multiple mixed arguments in a single call", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";

    expect(() =>
      console.error("prefix", 42, null, new Error(`key: ${awsKey}`)),
    ).not.toThrow();

    expect(errorSpy).toHaveBeenCalled();
    // First arg should be the string, second the number
    expect(errorSpy.mock.calls[0][0]).toBe("prefix");
    expect(errorSpy.mock.calls[0][1]).toBe(42);
    expect(errorSpy.mock.calls[0][2]).toBeNull();
  });
});
