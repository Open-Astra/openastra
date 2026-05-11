import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Tests for src/agents/post-turn-save.ts ───────────────────────────

const { mockPool, mockAppendDailyMemory, mockGetDailyEntryCount, mockIndexDailyEntry,
        mockExtractEntityMentions, mockFindOrCreateEntity, mockScanContent,
        mockDetectPII, mockRedactPII, mockExtractFacts, mockLoadEnv } = vi.hoisted(() => {
  return {
    mockPool: {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    },
    mockAppendDailyMemory: vi.fn().mockResolvedValue(undefined),
    mockGetDailyEntryCount: vi.fn().mockResolvedValue(0),
    mockIndexDailyEntry: vi.fn().mockResolvedValue(undefined),
    mockExtractEntityMentions: vi.fn().mockReturnValue([]),
    mockFindOrCreateEntity: vi.fn().mockResolvedValue(undefined),
    mockScanContent: vi.fn().mockReturnValue({ hasPotentialSecrets: false, sanitized: "", matches: 0 }),
    mockDetectPII: vi.fn().mockReturnValue([]),
    mockRedactPII: vi.fn().mockReturnValue({ redacted: "", found: [] }),
    mockExtractFacts: vi.fn().mockReturnValue([]),
    mockLoadEnv: vi.fn().mockReturnValue({ piiDetectionPolicy: "allow" }),
  };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/memory/store.js", () => ({
  appendDailyMemory: mockAppendDailyMemory,
  getDailyEntryCount: mockGetDailyEntryCount,
}));

vi.mock("../../src/memory/indexer.js", () => ({
  indexDailyEntry: mockIndexDailyEntry,
}));

vi.mock("../../src/memory/graph.js", () => ({
  extractEntityMentions: mockExtractEntityMentions,
  findOrCreateEntity: mockFindOrCreateEntity,
}));

vi.mock("../../src/secrets/scanner.js", () => ({
  scanContent: mockScanContent,
  detectPII: mockDetectPII,
  redactPII: mockRedactPII,
}));

vi.mock("../../src/memory/fact-extractor.js", () => ({
  extractFacts: mockExtractFacts,
}));

vi.mock("../../src/config/env.js", () => ({
  loadEnv: mockLoadEnv,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { postTurnAutoSave } from "../../src/agents/post-turn-save.js";

describe("postTurnAutoSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadEnv.mockReturnValue({ piiDetectionPolicy: "allow" });
    mockScanContent.mockReturnValue({ hasPotentialSecrets: false, sanitized: "", matches: 0 });
    mockDetectPII.mockReturnValue([]);
    mockRedactPII.mockReturnValue({ redacted: "", found: [] });
    mockExtractEntityMentions.mockReturnValue([]);
    mockExtractFacts.mockReturnValue([]);
    mockGetDailyEntryCount.mockResolvedValue(0);
    mockAppendDailyMemory.mockResolvedValue(undefined);
    mockFindOrCreateEntity.mockResolvedValue(undefined);
  });

  it("extracts and saves a decision signal from user message", async () => {
    const userMessage = "I decided to use TypeScript for this project because it is better.";
    const assistantResponse = "Great choice, TypeScript is excellent.";

    await postTurnAutoSave("uid-1", userMessage, assistantResponse);

    expect(mockAppendDailyMemory).toHaveBeenCalledOnce();
    const [uid, entry] = mockAppendDailyMemory.mock.calls[0];
    expect(uid).toBe("uid-1");
    expect(entry.category).toBe("decision");
    expect(entry.content).toContain("decided");
  });

  it("extracts and saves an outcome signal from user message", async () => {
    const userMessage = "The result was a 5-0 win and we covered the spread easily.";
    const assistantResponse = "Congrats on the result!";

    await postTurnAutoSave("uid-2", userMessage, assistantResponse);

    expect(mockAppendDailyMemory).toHaveBeenCalled();
    const [uid, entry] = mockAppendDailyMemory.mock.calls[0];
    expect(uid).toBe("uid-2");
    expect(entry.category).toBe("outcome");
  });

  it("skips trivially short sentences (< 20 chars)", async () => {
    // All sentences split from this message are shorter than 20 chars
    const userMessage = "I decided it.";
    const assistantResponse = "OK.";

    await postTurnAutoSave("uid-3", userMessage, assistantResponse);

    expect(mockAppendDailyMemory).not.toHaveBeenCalled();
  });

  it("redacts PII before saving when policy is 'redact'", async () => {
    mockLoadEnv.mockReturnValue({ piiDetectionPolicy: "redact" });
    mockRedactPII.mockReturnValue({
      redacted: "I decided to call [REDACTED] about it and will follow through later.",
      found: [{ type: "phone" }],
    });

    const userMessage = "I decided to call 555-123-4567 about it and will follow through later.";
    const assistantResponse = "OK.";

    await postTurnAutoSave("uid-4", userMessage, assistantResponse);

    expect(mockRedactPII).toHaveBeenCalled();
    expect(mockAppendDailyMemory).toHaveBeenCalledOnce();
    const [, entry] = mockAppendDailyMemory.mock.calls[0];
    expect(entry.content).toContain("[REDACTED]");
  });

  it("blocks saving when policy is 'block' and PII is detected", async () => {
    mockLoadEnv.mockReturnValue({ piiDetectionPolicy: "block" });
    mockDetectPII.mockReturnValue([{ type: "ssn" }]);

    const userMessage = "I decided to use SSN 123-45-6789 for the verification process here.";
    const assistantResponse = "OK.";

    await postTurnAutoSave("uid-5", userMessage, assistantResponse);

    expect(mockAppendDailyMemory).not.toHaveBeenCalled();
  });

  it("entity extraction is fire-and-forget — entity errors do not propagate", async () => {
    // findOrCreateEntity errors are caught internally (fire-and-forget)
    mockFindOrCreateEntity.mockRejectedValue(new Error("graph DB down"));
    mockExtractEntityMentions.mockReturnValue([
      { type: "person", name: "Alice" },
    ]);

    const userMessage = "I decided to use TypeScript for this project because it rocks.";
    const assistantResponse = "Sounds good.";

    // Should resolve — entity errors are swallowed
    await expect(postTurnAutoSave("uid-6", userMessage, assistantResponse)).resolves.toBeUndefined();
  });

  it("produces no saves for empty user message", async () => {
    await postTurnAutoSave("uid-7", "", "Some response.");

    expect(mockAppendDailyMemory).not.toHaveBeenCalled();
  });
});
