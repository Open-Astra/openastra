import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
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

// Mock readFile used by ensureGraphSchema
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("-- mock sql"),
}));

import {
  createEntity,
  getEntity,
  createEdge,
  getEdgesFrom,
  findEntitiesByName,
  findOrCreateEntity,
  graphSearch,
  extractEntityMentions,
} from "../../src/memory/graph.js";
import { generateEmbedding } from "../../src/memory/embeddings.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeEntityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ent-1",
    uid: "user-1",
    type: "person",
    name: "Test Entity",
    description: "A test entity",
    properties: {},
    confidence: 1.0,
    reinforcement_score: 1.0,
    access_count: 0,
    created_at: new Date("2024-01-01").toISOString(),
    last_accessed_at: new Date("2024-01-01").toISOString(),
    ...overrides,
  };
}

function makeEdgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "edge-1",
    uid: "user-1",
    source_id: "ent-1",
    target_id: "ent-2",
    type: "related_to",
    weight: 0.5,
    metadata: {},
    created_at: new Date("2024-01-01").toISOString(),
    last_reinforced_at: new Date("2024-01-01").toISOString(),
    reinforcement_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── Test Suites ──────────────────────────────────────────────────────

describe("createEntity", () => {
  it("inserts a new entity and returns a GraphEntity", async () => {
    const row = makeEntityRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const entity = await createEntity("user-1", "person", "Test Entity", "A test entity");

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO graph_entities"),
      expect.arrayContaining(["user-1", "person", "Test Entity", "A test entity"]),
    );
    expect(entity.id).toBe("ent-1");
    expect(entity.name).toBe("Test Entity");
    expect(entity.type).toBe("person");
    expect(entity.uid).toBe("user-1");
  });

  it("stores entity without embedding when generateEmbedding fails", async () => {
    vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error("Embedding unavailable"));
    const row = makeEntityRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    // Should NOT throw — embedding failure is best-effort
    const entity = await createEntity("user-1", "concept", "Risk", "A risk concept");
    expect(entity).toBeDefined();
    // The null embedding path: 6th param should be null
    const callArgs = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(callArgs[5]).toBeNull();
  });
});

describe("getEntity", () => {
  it("returns an entity when found", async () => {
    const row = makeEntityRow();
    mockPool.query
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })  // SELECT
      .mockResolvedValue({ rows: [], rowCount: 0 });          // fire-and-forget UPDATE

    const entity = await getEntity("user-1", "ent-1");
    expect(entity).not.toBeNull();
    expect(entity!.id).toBe("ent-1");
  });

  it("returns null when entity not found", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const entity = await getEntity("user-1", "nonexistent");
    expect(entity).toBeNull();
  });
});

describe("createEdge", () => {
  it("creates a relationship edge between two entities", async () => {
    const row = makeEdgeRow();
    mockPool.query.mockResolvedValue({ rows: [row], rowCount: 1 });

    const edge = await createEdge("user-1", "ent-1", "ent-2", "related_to", 0.8);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO graph_edges"),
      expect.arrayContaining(["user-1"]),
    );
    expect(edge.sourceId).toBe("ent-1");
    expect(edge.targetId).toBe("ent-2");
    expect(edge.type).toBe("related_to");
    expect(edge.weight).toBe(0.5); // from mock row
  });

  it("upserts on conflict (reinforcement)", async () => {
    const reinforcedRow = makeEdgeRow({ weight: 0.6, reinforcement_count: 1 });
    mockPool.query.mockResolvedValue({ rows: [reinforcedRow], rowCount: 1 });

    const edge = await createEdge("user-1", "ent-1", "ent-2", "related_to");
    // ON CONFLICT DO UPDATE — reinforcement_count incremented in row
    expect(edge.reinforcementCount).toBe(1);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT"),
      expect.any(Array),
    );
  });
});

describe("findEntitiesByName", () => {
  it("returns matching entities by name", async () => {
    const rows = [makeEntityRow(), makeEntityRow({ id: "ent-2", name: "Test Entity" })];
    mockPool.query.mockResolvedValue({ rows, rowCount: rows.length });

    const results = await findEntitiesByName("user-1", "Test Entity");
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe("Test Entity");
  });

  it("returns empty array when no match", async () => {
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const results = await findEntitiesByName("user-1", "Unknown");
    expect(results).toEqual([]);
  });
});

describe("findOrCreateEntity", () => {
  it("creates a new entity when none exists", async () => {
    const newRow = makeEntityRow({ name: "New Entity" });
    // findEntitiesByName returns empty → createEntity is called
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // findEntitiesByName SELECT
      .mockResolvedValueOnce({ rows: [newRow], rowCount: 1 }); // createEntity INSERT

    const entity = await findOrCreateEntity("user-1", "person", "New Entity", "Desc");
    expect(entity.name).toBe("New Entity");
  });

  it("returns existing entity and reinforces it", async () => {
    const existingRow = makeEntityRow({ reinforcement_score: 1.0 });
    mockPool.query
      .mockResolvedValueOnce({ rows: [existingRow], rowCount: 1 })  // findEntitiesByName
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });              // UPDATE reinforce

    const entity = await findOrCreateEntity("user-1", "person", "Test Entity", "Desc");
    expect(entity.name).toBe("Test Entity");
    // UPDATE should have been called
    const updateCall = mockPool.query.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("UPDATE graph_entities"),
    );
    expect(updateCall).toBeDefined();
  });
});

describe("graphSearch", () => {
  it("returns empty when embedding generation fails", async () => {
    vi.mocked(generateEmbedding).mockRejectedValueOnce(new Error("No embeddings"));
    const results = await graphSearch("user-1", "test query");
    expect(results).toEqual([]);
  });

  it("returns empty when no seed entities found", async () => {
    vi.mocked(generateEmbedding).mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const results = await graphSearch("user-1", "test query");
    expect(results).toEqual([]);
  });

  it("returns graph results with connected entities for seed matches", async () => {
    vi.mocked(generateEmbedding).mockResolvedValueOnce([0.1, 0.2, 0.3]);

    const seedRow = { ...makeEntityRow(), similarity: "0.95" };
    const connectedRow = {
      ...makeEntityRow({ id: "ent-2", name: "Connected" }),
      edge_id: "edge-1",
      edge_uid: "user-1",
      source_id: "ent-1",
      target_id: "ent-2",
      edge_type: "related_to",
      edge_weight: 0.8,
      edge_metadata: {},
      edge_created_at: new Date("2024-01-01").toISOString(),
      last_reinforced_at: new Date("2024-01-01").toISOString(),
      reinforcement_count: 0,
    };

    mockPool.query
      .mockResolvedValueOnce({ rows: [seedRow], rowCount: 1 })        // phase 1 seed query
      .mockResolvedValueOnce({ rows: [connectedRow], rowCount: 1 });   // phase 2 expansion

    const results = await graphSearch("user-1", "test query", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeCloseTo(0.95);
    expect(results[0]!.connectedEntities).toHaveLength(1);
    expect(results[0]!.connectedEntities![0]!.entity.id).toBe("ent-2");
  });

  it("returns results without connected entities when expansion is empty", async () => {
    vi.mocked(generateEmbedding).mockResolvedValueOnce([0.1, 0.2, 0.3]);

    const seedRow = { ...makeEntityRow(), similarity: "0.80" };
    mockPool.query
      .mockResolvedValueOnce({ rows: [seedRow], rowCount: 1 }) // seed
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });        // expansion empty

    const results = await graphSearch("user-1", "test query", 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.connectedEntities).toBeUndefined();
  });
});

describe("extractEntityMentions", () => {
  it("extracts known team names from text", () => {
    const mentions = extractEntityMentions("The Lakers beat the Warriors last night.");
    const teamNames = mentions.map((m) => m.name);
    expect(teamNames).toContain("Lakers");
    expect(teamNames).toContain("Warriors");
    const teams = mentions.filter((m) => m.type === "team");
    expect(teams.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty array for text with no entities", () => {
    const mentions = extractEntityMentions("hello world");
    // No known teams, no proper names
    const teams = mentions.filter((m) => m.type === "team");
    expect(teams).toHaveLength(0);
  });
});
