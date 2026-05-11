import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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

vi.mock("../../src/memory/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

vi.mock("../../src/config/typesense.js", () => ({
  getTypesense: vi.fn().mockReturnValue({
    collections: vi.fn().mockReturnValue({
      retrieve: vi.fn().mockResolvedValue({}),
      documents: vi.fn().mockReturnValue({
        search: vi.fn().mockResolvedValue({ hits: [] }),
        upsert: vi.fn().mockResolvedValue({}),
      }),
    }),
  }),
}));

import {
  createProcedure,
  getProcedure,
  listProcedures,
  updateProcedure,
  recordExecution,
  searchProcedures,
  renderProcedure,
  type ProceduralMemory,
} from "../../src/memory/procedural.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeProcedureRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "proc-1",
    user_id: "user-1",
    type: "workflow",
    title: "Deploy Service",
    content: "Steps to deploy a service",
    trigger_pattern: "deploy",
    steps: [{ order: 1, action: "Build image" }, { order: 2, action: "Push to registry" }],
    tags: ["devops", "deploy"],
    execution_count: 5,
    success_count: 4,
    last_executed_at: null,
    created_at: new Date("2025-01-01").toISOString(),
    updated_at: new Date("2025-01-02").toISOString(),
    source: "user",
    ...overrides,
  };
}

function makeProcedureObj(overrides: Partial<ProceduralMemory> = {}): Omit<ProceduralMemory, "id" | "uid" | "executionCount" | "successCount" | "lastExecutedAt" | "createdAt" | "updatedAt"> {
  return {
    type: "workflow",
    name: "Deploy Service",
    description: "Steps to deploy a service",
    trigger: "deploy",
    steps: [{ order: 1, action: "Build image" }],
    tags: ["devops"],
    source: "user",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Tests ────────────────────────────────────────────────────────────

describe("createProcedure", () => {
  it("inserts a new procedure row and returns a ProceduralMemory object", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await createProcedure("user-1", makeProcedureObj());

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO procedural_memory"),
      expect.arrayContaining(["user-1", "Deploy Service", "workflow", "deploy"]),
    );
    expect(result.uid).toBe("user-1");
    expect(result.name).toBe("Deploy Service");
    expect(result.executionCount).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.lastExecutedAt).toBeNull();
    expect(typeof result.id).toBe("string");
  });

  it("assigns a UUID to the new procedure", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const result = await createProcedure("user-1", makeProcedureObj());

    // UUID format: 8-4-4-4-12 hex chars
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("getProcedure", () => {
  it("returns a mapped ProceduralMemory when found", async () => {
    const row = makeProcedureRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const proc = await getProcedure("user-1", "proc-1");

    expect(proc).not.toBeNull();
    expect(proc!.id).toBe("proc-1");
    expect(proc!.name).toBe("Deploy Service");
    expect(proc!.trigger).toBe("deploy");
    expect(proc!.executionCount).toBe(5);
    expect(proc!.successCount).toBe(4);
    expect(proc!.source).toBe("user");
    expect(proc!.steps).toHaveLength(2);
  });

  it("returns null when procedure not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const proc = await getProcedure("user-1", "nonexistent");
    expect(proc).toBeNull();
  });

  it("queries by id AND user_id for ownership isolation", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await getProcedure("user-99", "proc-abc");

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toContain("user-99");
    expect(params).toContain("proc-abc");
    expect(sql).toContain("user_id");
  });
});

describe("listProcedures", () => {
  it("returns all procedures for a user when no type filter", async () => {
    const rows = [makeProcedureRow(), makeProcedureRow({ id: "proc-2", title: "Backup DB" })];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const procs = await listProcedures("user-1");
    expect(procs).toHaveLength(2);
  });

  it("filters by type when provided", async () => {
    const rows = [makeProcedureRow({ type: "rule" })];
    mockPool.query.mockResolvedValue({ rows, rowCount: 1 });

    await listProcedures("user-1", "rule");

    const [sql, params] = mockPool.query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("type");
    expect(params).toContain("rule");
  });
});

describe("searchProcedures — trigger matching", () => {
  it("matches procedures whose trigger pattern is contained in the query", async () => {
    const rows = [makeProcedureRow({ trigger_pattern: "deploy" })];
    // listProcedures call returns rows
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const results = await searchProcedures("user-1", "I want to deploy the service", 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchType).toBe("trigger");
    expect(results[0]!.score).toBe(0.95);
  });

  it("matches by tag when query contains a tag word", async () => {
    const rows = [makeProcedureRow({ trigger_pattern: "zxqy_no_match", tags: ["kubernetes"] })];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const results = await searchProcedures("user-1", "kubernetes cluster setup", 3);

    const tagMatch = results.find((r) => r.matchType === "tag");
    expect(tagMatch).toBeDefined();
    expect(tagMatch!.score).toBe(0.7);
  });

  it("returns empty results when nothing matches and Typesense finds nothing", async () => {
    const rows = [makeProcedureRow({ trigger_pattern: "zxqy_no_match", tags: ["zzz"] })];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const results = await searchProcedures("user-1", "completely unrelated query here", 3);
    // Typesense mock returns [] hits, trigger/tag don't match
    expect(results).toHaveLength(0);
  });

  it("caps results at topK", async () => {
    // 4 procedures all matching via trigger
    const rows = Array.from({ length: 4 }, (_, i) =>
      makeProcedureRow({ id: `proc-${i}`, trigger_pattern: "deploy" }),
    );
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const results = await searchProcedures("user-1", "deploy now", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("recordExecution", () => {
  it("increments execution_count and success_count on success", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await recordExecution("user-1", "proc-1", true);

    const [sql] = mockPool.query.mock.calls[0]! as [string];
    expect(sql).toContain("success_count = success_count + 1");
    expect(sql).toContain("execution_count = execution_count + 1");
  });

  it("increments only execution_count on failure", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await recordExecution("user-1", "proc-1", false);

    const [sql] = mockPool.query.mock.calls[0]! as [string];
    expect(sql).toContain("execution_count = execution_count + 1");
    expect(sql).not.toContain("success_count = success_count + 1");
  });
});

describe("renderProcedure", () => {
  it("renders procedure as formatted text with steps", () => {
    const proc: ProceduralMemory = {
      id: "proc-1",
      uid: "user-1",
      type: "workflow",
      name: "Deploy Service",
      description: "Deploy to production",
      trigger: "deploy",
      steps: [
        { order: 1, action: "Build image" },
        { order: 2, action: "Push", toolCall: "docker-push" },
      ],
      tags: ["devops"],
      executionCount: 10,
      successCount: 9,
      lastExecutedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "user",
    };

    const rendered = renderProcedure(proc);

    expect(rendered).toContain("## Procedure: Deploy Service");
    expect(rendered).toContain("Trigger: \"deploy\"");
    expect(rendered).toContain("1. Build image");
    expect(rendered).toContain("2. Push");
    expect(rendered).toContain("docker-push");
    // 9/10 = 90%
    expect(rendered).toContain("90%");
  });

  it("shows N/A for success rate when executionCount=0", () => {
    const proc: ProceduralMemory = {
      id: "p", uid: "u", type: "rule", name: "Test", description: "desc",
      trigger: "t", steps: [], tags: [], executionCount: 0, successCount: 0,
      lastExecutedAt: null, createdAt: Date.now(), updatedAt: Date.now(), source: "agent",
    };
    expect(renderProcedure(proc)).toContain("N/A%");
  });
});
