import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const { mockPool, mockBus } = vi.hoisted(() => {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const bus = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn().mockReturnValue(() => {}),
    off: vi.fn(),
    onAny: vi.fn().mockReturnValue(() => {}),
    clear: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  };
  return { mockPool: pool, mockBus: bus };
});

vi.mock("../../src/config/postgres.js", () => ({
  getPool: () => mockPool,
}));

vi.mock("../../src/events/index.js", () => ({
  getEventBus: vi.fn().mockReturnValue(mockBus),
}));

// Mock approval gate so it doesn't wait for DB
vi.mock("../../src/agents/approval-gate.js", () => ({
  requestApproval: vi.fn().mockResolvedValue(true),
}));

// Mock skills/registry for getSkillForTool (called in executeTool telemetry path)
vi.mock("../../src/skills/registry.js", () => ({
  getSkillForTool: vi.fn().mockReturnValue(null),
  registerSkill: vi.fn(),
  getAllSkills: vi.fn().mockReturnValue(new Map()),
  getSkill: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { z } from "zod";
import {
  registerTool,
  unregisterTool,
  getRegisteredToolNames,
  getToolSchemas,
  executeTool,
  getTool,
} from "../../src/tools/registry.js";
import type { ToolContext, ToolCall } from "../../src/tools/types.js";

const testCtx: ToolContext = {
  uid: "user-test",
  agentId: "agent-test",
  sessionId: "session-test",
};

// Use unique prefixes per test block to avoid cross-test contamination
// since the registry is module-level state
const TOOL_PREFIX = `test-${Date.now()}`;

function uniqueName(suffix: string): string {
  return `${TOOL_PREFIX}-${suffix}`;
}

afterEach(() => {
  // Clean up any tools registered in tests
  for (const name of getRegisteredToolNames()) {
    if (name.startsWith(TOOL_PREFIX)) {
      unregisterTool(name);
    }
  }
  vi.clearAllMocks();
});

describe("registerTool", () => {
  it("adds a tool to the registry so it can be retrieved by getTool", () => {
    const name = uniqueName("add");
    registerTool({
      name,
      description: "Test tool",
      parameters: z.object({ input: z.string() }),
      execute: async () => ({ result: "ok" }),
    });

    expect(getTool(name)).toBeDefined();
    expect(getTool(name)!.name).toBe(name);
  });

  it("skips duplicate registration without throwing an error", () => {
    const name = uniqueName("dup");
    const firstExecute = vi.fn().mockResolvedValue({ v: 1 });
    const secondExecute = vi.fn().mockResolvedValue({ v: 2 });

    registerTool({ name, description: "First", parameters: z.object({}), execute: firstExecute });
    registerTool({ name, description: "Second", parameters: z.object({}), execute: secondExecute });

    // Second registration should have been skipped — original still in registry
    const tool = getTool(name)!;
    expect(tool.description).toBe("First");
  });
});

describe("unregisterTool", () => {
  it("removes a tool from the registry", () => {
    const name = uniqueName("remove");
    registerTool({
      name,
      description: "To remove",
      parameters: z.object({}),
      execute: async () => ({}),
    });

    expect(getTool(name)).toBeDefined();
    unregisterTool(name);
    expect(getTool(name)).toBeUndefined();
  });
});

describe("getRegisteredToolNames", () => {
  it("returns all registered tool names", () => {
    const nameA = uniqueName("names-a");
    const nameB = uniqueName("names-b");
    registerTool({ name: nameA, description: "A", parameters: z.object({}), execute: async () => ({}) });
    registerTool({ name: nameB, description: "B", parameters: z.object({}), execute: async () => ({}) });

    const names = getRegisteredToolNames();
    expect(names).toContain(nameA);
    expect(names).toContain(nameB);
  });
});

describe("getToolSchemas", () => {
  it("returns schemas only for tools in the allow set", () => {
    const nameAllowed = uniqueName("schema-allowed");
    const nameDenied = uniqueName("schema-denied");

    registerTool({ name: nameAllowed, description: "Allowed", parameters: z.object({ q: z.string() }), execute: async () => ({}) });
    registerTool({ name: nameDenied, description: "Denied", parameters: z.object({ q: z.string() }), execute: async () => ({}) });

    const schemas = getToolSchemas(new Set([nameAllowed]));
    const schemaNames = schemas.map((s) => s.function.name);

    expect(schemaNames).toContain(nameAllowed);
    expect(schemaNames).not.toContain(nameDenied);
  });

  it("returns correct JSON Schema structure from Zod schema", () => {
    const name = uniqueName("schema-json");
    registerTool({
      name,
      description: "Schema tool",
      parameters: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional(),
      }),
      execute: async () => ({}),
    });

    const schemas = getToolSchemas(new Set([name]));
    expect(schemas).toHaveLength(1);

    const schema = schemas[0]!;
    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe(name);
    expect(schema.function.description).toBe("Schema tool");
    expect(schema.function.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        query: expect.objectContaining({ type: "string" }),
      }),
    });
  });
});

describe("executeTool", () => {
  it("returns error when tool is not in the allowed set", async () => {
    const name = uniqueName("exec-blocked");
    registerTool({ name, description: "Blocked", parameters: z.object({}), execute: async () => ({}) });

    const call: ToolCall = { id: "call-1", name, arguments: "{}" };
    const result = await executeTool(call, testCtx, new Set()); // empty allow set

    expect(result.error).toContain("not allowed");
    expect(result.toolCallId).toBe("call-1");
  });

  it("returns error when tool is not registered but in allow set", async () => {
    const name = uniqueName("exec-missing");
    // Do NOT register this tool
    const call: ToolCall = { id: "call-2", name, arguments: "{}" };
    const result = await executeTool(call, testCtx, new Set([name]));

    expect(result.error).toContain("not found");
  });

  it("returns error when arguments JSON is invalid", async () => {
    const name = uniqueName("exec-badjson");
    registerTool({ name, description: "Bad JSON", parameters: z.object({ x: z.string() }), execute: async () => ({}) });

    const call: ToolCall = { id: "call-3", name, arguments: "not-json{{{" };
    const result = await executeTool(call, testCtx, new Set([name]));

    expect(result.error).toBeDefined();
    expect(result.error).toContain("invalid JSON");
  });

  it("returns validation error when params fail Zod schema", async () => {
    const name = uniqueName("exec-zodval");
    registerTool({
      name,
      description: "Zod val",
      parameters: z.object({ count: z.number() }),
      execute: async () => ({}),
    });

    const call: ToolCall = { id: "call-4", name, arguments: JSON.stringify({ count: "not-a-number" }) };
    const result = await executeTool(call, testCtx, new Set([name]));

    expect(result.error).toBeDefined();
    expect(result.error).toContain("validation failed");
  });

  it("calls execute function with parsed params and returns result", async () => {
    const name = uniqueName("exec-success");
    const executeFn = vi.fn().mockResolvedValue({ answer: 42 });

    registerTool({
      name,
      description: "Success tool",
      parameters: z.object({ num: z.number() }),
      execute: executeFn,
    });

    const call: ToolCall = { id: "call-5", name, arguments: JSON.stringify({ num: 7 }) };
    const result = await executeTool(call, testCtx, new Set([name]));

    expect(result.error).toBeUndefined();
    expect(result.content).toBe(JSON.stringify({ answer: 42 }));
    expect(executeFn).toHaveBeenCalledWith({ num: 7 }, testCtx);
  });

  it("returns error content when execute function throws", async () => {
    const name = uniqueName("exec-throw");
    registerTool({
      name,
      description: "Throws",
      parameters: z.object({}),
      execute: async () => { throw new Error("tool failed"); },
    });

    const call: ToolCall = { id: "call-6", name, arguments: "{}" };
    const result = await executeTool(call, testCtx, new Set([name]));

    expect(result.error).toContain("tool failed");
    expect(JSON.parse(result.content)).toMatchObject({ error: "tool failed" });
  });
});
