import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  return { mockPool: pool };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { checkDataResidency } from "../../src/security/data-residency.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

describe("checkDataResidency", () => {
  it("returns true when no policy is configured for workspace (default allow)", async () => {
    // DB returns no rows → no policy
    mockPool.query.mockResolvedValue({ rows: [] });

    const result = await checkDataResidency("openai", "ws-1");

    expect(result).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("workspace_data_policies"),
      ["ws-1"],
    );
  });

  it("returns true when provider is in the allowed_providers list", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: [], allowed_providers: ["openai", "claude"] }],
    });

    const result = await checkDataResidency("openai", "ws-2");

    expect(result).toBe(true);
  });

  it("blocks provider not in allowed_providers list", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: [], allowed_providers: ["openai", "claude"] }],
    });

    const result = await checkDataResidency("groq", "ws-3");

    expect(result).toBe(false);
  });

  it("blocks provider whose region is not in allowed_regions", async () => {
    // mistral is eu/eu-west, but policy only allows "us"
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: ["us"], allowed_providers: [] }],
    });

    const result = await checkDataResidency("mistral", "ws-4");

    expect(result).toBe(false);
  });

  it("allows provider whose region matches allowed_regions", async () => {
    // openai is us/us-east, policy allows "us"
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: ["us"], allowed_providers: [] }],
    });

    const result = await checkDataResidency("openai", "ws-5");

    expect(result).toBe(true);
  });

  it("returns true when both allowed_regions and allowed_providers are empty arrays (open policy)", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: [], allowed_providers: [] }],
    });

    const result = await checkDataResidency("gemini", "ws-6");

    expect(result).toBe(true);
  });

  it("local providers (ollama, vllm) match 'local' region policy", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: ["local"], allowed_providers: [] }],
    });

    const result = await checkDataResidency("ollama", "ws-7");

    expect(result).toBe(true);
  });

  it("blocks local provider when only 'us' region is allowed", async () => {
    mockPool.query.mockResolvedValue({
      rows: [{ allowed_regions: ["us"], allowed_providers: [] }],
    });

    const result = await checkDataResidency("ollama", "ws-8");

    expect(result).toBe(false);
  });
});
