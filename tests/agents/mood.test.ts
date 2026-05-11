import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
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

import {
  getMood,
  updateMood,
  getMoodSystemSuffix,
  type AgentMood,
} from "../../src/agents/mood.js";
import {
  classifyTone,
  detectToneDrift,
  type AgentTone,
} from "../../src/agents/tone-drift.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ── getMood ───────────────────────────────────────────────────────────

describe("getMood", () => {
  it("returns 'neutral' when no mood row exists in DB", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const mood = await getMood("session-1", mockPool as never);
    expect(mood).toBe("neutral");
  });

  it("returns the stored mood from DB", async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ mood: "enthusiastic", energy: 0.8 }],
    });
    const mood = await getMood("session-2", mockPool as never);
    expect(mood).toBe("enthusiastic");
  });

  it("queries by sessionId", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await getMood("my-session-id", mockPool as never);

    const call = mockPool.query.mock.calls[0] as unknown[];
    const params = call[1] as unknown[];
    expect(params[0]).toBe("my-session-id");
  });
});

// ── updateMood ────────────────────────────────────────────────────────

describe("updateMood", () => {
  it("transitions to 'enthusiastic' on success when energy is high enough", async () => {
    // Start with energy=0.7 → success adds 0.1 → 0.8 ≥ 0.7 → enthusiastic
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mood: "neutral", energy: 0.7 }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPSERT

    const mood = await updateMood("session-1", "success", mockPool as never);
    expect(mood).toBe("enthusiastic");
  });

  it("transitions to 'cautious' on error when energy drops below 0.3", async () => {
    // Start with energy=0.4 → error subtracts 0.2 → 0.2 < 0.3 → cautious
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mood: "neutral", energy: 0.4 }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPSERT

    const mood = await updateMood("session-2", "error", mockPool as never);
    expect(mood).toBe("cautious");
  });

  it("transitions to 'tired' on long_session when energy drops below 0.2", async () => {
    // Start with energy=0.3 → long_session subtracts 0.15 → 0.15 < 0.2 → tired
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mood: "neutral", energy: 0.3 }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPSERT

    const mood = await updateMood("session-3", "long_session", mockPool as never);
    expect(mood).toBe("tired");
  });

  it("stays 'neutral' on success when energy stays between 0.3 and 0.7", async () => {
    // Start with energy=0.5 → success adds 0.1 → 0.6 → neutral (< 0.7)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mood: "neutral", energy: 0.5 }] })
      .mockResolvedValueOnce({ rows: [] });

    const mood = await updateMood("session-4", "success", mockPool as never);
    expect(mood).toBe("neutral");
  });

  it("upserts the new mood and energy into the DB", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ mood: "neutral", energy: 0.5 }] })
      .mockResolvedValueOnce({ rows: [] });

    await updateMood("session-5", "success", mockPool as never);

    const upsertCall = mockPool.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("INSERT INTO agent_mood_states"),
    );
    expect(upsertCall).toBeDefined();
    const sql = upsertCall![0] as string;
    expect(sql).toContain("ON CONFLICT");
  });

  it("uses default energy of 0.5 when no existing row found", async () => {
    // No row → energy starts at 0.5; error subtracts 0.2 → 0.3 → neutral (borderline)
    mockPool.query
      .mockResolvedValueOnce({ rows: [] }) // SELECT returns nothing
      .mockResolvedValueOnce({ rows: [] }); // UPSERT

    const mood = await updateMood("session-new", "error", mockPool as never);
    // 0.5 - 0.2 = 0.3 → 0.3 is not < 0.3, so neutral
    expect(mood).toBe("neutral");
  });
});

// ── getMoodSystemSuffix ───────────────────────────────────────────────

describe("getMoodSystemSuffix", () => {
  it("returns empty string for 'neutral' mood", () => {
    expect(getMoodSystemSuffix("neutral")).toBe("");
  });

  it("returns energized tone text for 'enthusiastic' mood", () => {
    const suffix = getMoodSystemSuffix("enthusiastic");
    expect(suffix).toContain("energized");
    expect(suffix).toContain("[Tone:");
  });

  it("returns careful reasoning text for 'cautious' mood", () => {
    const suffix = getMoodSystemSuffix("cautious");
    expect(suffix).toContain("carefully");
    expect(suffix).toContain("[Tone:");
  });

  it("returns concise/focused text for 'tired' mood", () => {
    const suffix = getMoodSystemSuffix("tired");
    expect(suffix).toContain("focused");
    expect(suffix).toContain("[Tone:");
  });
});

// ── classifyTone ──────────────────────────────────────────────────────

describe("classifyTone", () => {
  it("classifies formal text correctly", () => {
    const text =
      "Therefore, pursuant to our discussion, the aforementioned strategy consequently " +
      "requires a subsequent review. Furthermore, the policy shall hereby be amended accordingly.";
    expect(classifyTone(text)).toBe("formal");
  });

  it("classifies casual text correctly", () => {
    const text =
      "Hey that's awesome! Yeah totally cool. Basically you just wanna do it kinda like this, you know. Super easy!";
    expect(classifyTone(text)).toBe("casual");
  });

  it("classifies technical text correctly", () => {
    const text =
      "The function parameter accepts an async middleware that queries the api endpoint " +
      "using the authentication protocol. The schema validation runs at runtime during deploy.";
    expect(classifyTone(text)).toBe("technical");
  });

  it("returns 'neutral' for generic text with no strong signal", () => {
    const text = "The cat sat on the mat.";
    expect(classifyTone(text)).toBe("neutral");
  });
});

// ── detectToneDrift ───────────────────────────────────────────────────

describe("detectToneDrift", () => {
  it("returns drifted=false when expected and actual tone match", () => {
    const result = detectToneDrift("formal", "formal");
    expect(result.drifted).toBe(false);
    expect(result.expectedTone).toBe("formal");
    expect(result.actualTone).toBe("formal");
  });

  it("returns high severity for opposite tones (formal vs casual)", () => {
    const result = detectToneDrift("formal", "casual");
    expect(result.drifted).toBe(true);
    expect(result.severity).toBe("high");
  });

  it("returns low severity whenever expected or actual tone is 'neutral' (neutral check takes priority)", () => {
    // Even though neutral/technical are opposite pairs, the neutral guard runs first
    const result = detectToneDrift("neutral", "technical");
    expect(result.drifted).toBe(true);
    expect(result.severity).toBe("low");
  });

  it("returns low severity when actual or expected is neutral (not the opposite pair)", () => {
    // formal vs neutral → actual=neutral → low severity
    const result = detectToneDrift("formal", "neutral");
    expect(result.drifted).toBe(true);
    expect(result.severity).toBe("low");
  });

  it("returns medium severity for other mismatches (formal vs technical)", () => {
    const result = detectToneDrift("formal", "technical");
    expect(result.drifted).toBe(true);
    expect(result.severity).toBe("medium");
  });

  it("includes the correct expected and actual tones in the result", () => {
    const result = detectToneDrift("casual", "technical");
    expect(result.expectedTone).toBe("casual");
    expect(result.actualTone).toBe("technical");
  });
});
