import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoist shared mocks ───────────────────────────────────────────────
const { mockReadFile } = vi.hoisted(() => {
  const mockReadFile = vi.fn().mockResolvedValue("# Ethics\nDo no harm.\n");
  return { mockReadFile };
});

// ── Mock all external dependencies ──────────────────────────────────

vi.mock("../../src/agents/prompt-hot-swap.js", () => ({
  getPromptOverride: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/memory/store.js", () => ({
  loadRecentDailyMemory: vi.fn().mockResolvedValue([]),
  loadProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/sessions/pruning.js", () => ({
  pruneToolResults: vi.fn().mockImplementation((msgs: unknown[]) => msgs),
  deduplicateToolResults: vi.fn().mockImplementation((msgs: unknown[]) => msgs),
}));

vi.mock("../../src/context/prefetch.js", () => ({
  prefetchContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/skills/registry.js", () => ({
  getSkillPromptContext: vi.fn().mockReturnValue(""),
  getSkillContextData: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../src/memory/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
}));

vi.mock("../../src/memory/workspace-memory.js", () => ({
  searchWorkspaceMemory: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/memory/workspace-knowledge.js", () => ({
  searchKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/workspace/loader.js", () => ({
  loadWorkspaceBootstrap: vi.fn().mockResolvedValue(""),
}));

vi.mock("../../src/memory/workspace-graph.js", () => ({
  searchWorkspaceGraph: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/memory/graph.js", () => ({
  graphSearch: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/memory/cross-workspace.js", () => ({
  listAccessibleShares: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/memory/procedural.js", () => ({
  searchProcedures: vi.fn().mockResolvedValue([]),
}));

// Mock node:fs/promises to control SOUL.md loading
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  readdir: vi.fn().mockResolvedValue([]),
}));

import { assembleContext, trimToolSchemas } from "../../src/context/assembler.js";
import { getSkillPromptContext } from "../../src/skills/registry.js";
import { loadProfile, loadRecentDailyMemory } from "../../src/memory/store.js";
import type { AgentConfig } from "../../src/agents/types.js";
import type { MessageDoc } from "../../src/sessions/types.js";
import type { ToolSchema } from "../../src/inference/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    displayName: "Test Agent",
    tier: "free",
    model: {
      provider: "openai" as const,
      modelId: "gpt-4o",
      maxContextTokens: 4000,
      maxOutputTokens: 2048,
      temperature: 0.7,
    },
    systemPromptTemplate: "You are a helpful assistant.",
    tools: { allow: [], deny: [], maxToolCallsPerRound: 5 },
    session: { idleTimeoutMinutes: 60, dailyResetHour: 0, maxContextMessages: 50 },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    fileAccess: { restricted: true, allowedPaths: [] },
    skills: [],
    memory: { enabled: false, autoSave: false },
    tags: [],
    ...overrides,
  } as unknown as AgentConfig;
}

function makeMsg(role: MessageDoc["role"], content: string): MessageDoc {
  return {
    id: "msg-" + Math.random().toString(36).slice(2),
    role,
    content,
    tokenEstimate: Math.ceil(content.length / 4),
    timestamp: Date.now(),
  };
}

function makeToolSchema(name: string, description: string): ToolSchema {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {}, required: [] },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mocks to defaults
  vi.mocked(loadProfile).mockResolvedValue(null);
  vi.mocked(loadRecentDailyMemory).mockResolvedValue([]);
  vi.mocked(getSkillPromptContext).mockReturnValue("");
  mockReadFile.mockResolvedValue("# Ethics\nDo no harm.\n");
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("assembleContext — SOUL.md prefix", () => {
  it("includes SOUL.md content in the system prompt", async () => {
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockResolvedValue("# SOUL\nBe helpful and honest.\n");

    const { messages } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content as string).toContain("Be helpful and honest.");
  });
});

describe("assembleContext — template interpolation", () => {
  it("replaces {{variable}} placeholders in the system prompt template", async () => {
    const agentConfig = makeAgentConfig({
      systemPromptTemplate:
        "Hello {{userProfile}}. Today is a great day.",
    });

    vi.mocked(loadProfile).mockResolvedValue({
      uid: "uid-1",
      displayName: "Alice",
      communicationStyle: null,
      interests: [],
      expertiseAreas: [],
      domains: {},
      strategicNotes: [],
    });

    const { messages } = await assembleContext(
      "uid-1",
      agentConfig,
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const content = systemMsg!.content as string;
    // The userProfile should be interpolated (Alice's name from profile)
    expect(content).toContain("Alice");
    // The raw placeholder should be replaced
    expect(content).not.toContain("{{userProfile}}");
  });

  it("renders conditional {{#if var}}...{{/if}} blocks only when variable is present", async () => {
    const agentConfig = makeAgentConfig({
      systemPromptTemplate:
        "Base prompt.{{#if skillContext}}\n\n{{skillContext}}{{/if}}",
    });

    // No skill context — block should be removed
    vi.mocked(getSkillPromptContext).mockReturnValue("");

    const { messages } = await assembleContext(
      "uid-1",
      agentConfig,
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    const content = systemMsg!.content as string;
    expect(content).not.toContain("{{#if");
    expect(content).not.toContain("{{/if}}");
  });

  it("includes conditional block content when the variable has a value", async () => {
    const agentConfig = makeAgentConfig({
      systemPromptTemplate:
        "Base.{{#if skillContext}}\n\nSKILL_SECTION: {{skillContext}}{{/if}}",
    });

    vi.mocked(getSkillPromptContext).mockReturnValue("## Research Skill\nDo research.");

    const { messages } = await assembleContext(
      "uid-1",
      agentConfig,
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    const content = systemMsg!.content as string;
    expect(content).toContain("SKILL_SECTION:");
    expect(content).toContain("## Research Skill");
  });
});

describe("assembleContext — memory context", () => {
  it("injects daily memory into the system prompt via template interpolation", async () => {
    const agentConfig = makeAgentConfig({
      systemPromptTemplate: "Agent. Memory: {{dailyMemory}}",
    });

    vi.mocked(loadRecentDailyMemory).mockResolvedValue([
      {
        uid: "uid-1",
        date: "2024-01-01",
        entries: [
          {
            timestamp: Date.now(),
            category: "decision",
            content: "User decided to use TypeScript.",
          },
        ],
      },
    ]);

    const { messages } = await assembleContext(
      "uid-1",
      agentConfig,
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg!.content as string).toContain("TypeScript");
    expect(systemMsg!.content as string).toContain("decision");
  });
});

describe("assembleContext — message trimming", () => {
  it("trims messages to fit within token budget", async () => {
    const agentConfig = makeAgentConfig({ model: { provider: "openai" as const, modelId: "gpt-4o", maxContextTokens: 200, maxOutputTokens: 50, temperature: 0.7 } });

    // Create many messages with content that would exceed the budget
    const messages: MessageDoc[] = Array.from({ length: 20 }, (_, i) =>
      makeMsg("user", `This is message number ${i} with some decent length content here.`),
    );

    const { messages: result } = await assembleContext(
      "uid-1",
      agentConfig,
      messages,
      [],
    );

    // The result should have a system message + some chat messages
    // It should NOT include all 20 messages
    const chatMessages = result.filter((m) => m.role !== "system");
    expect(chatMessages.length).toBeLessThan(20);
  });
});

describe("assembleContext — tool schemas", () => {
  it("includes tool schemas in the context and estimatedTokens", async () => {
    const tools: ToolSchema[] = [
      makeToolSchema("web_search", "Search the web for information."),
      makeToolSchema("memory_write", "Write a memory entry."),
    ];

    const { estimatedTokens } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      [makeMsg("user", "hello")],
      tools,
    );

    // estimatedTokens should include tool schema tokens (non-zero)
    expect(estimatedTokens).toBeGreaterThan(0);
  });
});

describe("assembleContext — workspace bootstrap prefix", () => {
  it("includes workspace bootstrap content in system prompt when workspaceId provided", async () => {
    const { loadWorkspaceBootstrap } = await import("../../src/workspace/loader.js");
    vi.mocked(loadWorkspaceBootstrap).mockResolvedValue("# Workspace Rules\nAlways be concise.");

    const { messages } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      [makeMsg("user", "hello")],
      [],
      "workspace-abc",
    );

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg!.content as string).toContain("Workspace Rules");
    expect(systemMsg!.content as string).toContain("Always be concise.");
  });
});

describe("assembleContext — skill prompt context", () => {
  it("merges skill prompt context into the system prompt", async () => {
    const agentConfig = makeAgentConfig({
      skills: ["research"],
      systemPromptTemplate: "Assistant.{{#if skillContext}}\n\n{{skillContext}}{{/if}}",
    });

    vi.mocked(getSkillPromptContext).mockReturnValue(
      "## Available Skills\n\n### research\nHelps with research tasks.\n",
    );

    const { messages } = await assembleContext(
      "uid-1",
      agentConfig,
      [makeMsg("user", "hello")],
      [],
    );

    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg!.content as string).toContain("## Available Skills");
    expect(systemMsg!.content as string).toContain("research");
  });
});

describe("assembleContext — estimatedTokens", () => {
  it("returns a positive estimatedTokens value", async () => {
    const { estimatedTokens } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      [makeMsg("user", "What is the capital of France?")],
      [],
    );
    expect(estimatedTokens).toBeGreaterThan(0);
  });

  it("estimatedTokens increases with more messages", async () => {
    const fewMessages = [makeMsg("user", "hello")];
    const manyMessages = Array.from({ length: 10 }, (_, i) =>
      makeMsg("user", `Message ${i} with some content`),
    );

    const { estimatedTokens: few } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      fewMessages,
      [],
    );
    const { estimatedTokens: many } = await assembleContext(
      "uid-1",
      makeAgentConfig(),
      manyMessages,
      [],
    );

    expect(many).toBeGreaterThan(few);
  });
});

// ── trimToolSchemas ───────────────────────────────────────────────────

describe("trimToolSchemas", () => {
  it("returns schemas unchanged when overBudgetTokens is 0", () => {
    const schemas: ToolSchema[] = [
      makeToolSchema("tool_1", "A short description."),
      makeToolSchema("tool_2", "Another description."),
    ];
    const result = trimToolSchemas(schemas, 0);
    expect(result[0]!.function.description).toBe("A short description.");
    expect(result[1]!.function.description).toBe("Another description.");
  });

  it("truncates descriptions longer than 80 chars to 77 chars + '...'", () => {
    const longDesc = "A".repeat(120);
    const schemas: ToolSchema[] = [makeToolSchema("tool_x", longDesc)];
    const result = trimToolSchemas(schemas, 100);
    expect(result[0]!.function.description).toHaveLength(80);
    expect(result[0]!.function.description.endsWith("...")).toBe(true);
  });

  it("leaves descriptions under 80 chars unchanged", () => {
    const shortDesc = "Short description."; // 18 chars
    const schemas: ToolSchema[] = [makeToolSchema("tool_y", shortDesc)];
    const result = trimToolSchemas(schemas, 100);
    expect(result[0]!.function.description).toBe(shortDesc);
  });

  it("does not mutate the original schema objects", () => {
    const original = makeToolSchema("tool_z", "A".repeat(100));
    const originalDesc = original.function.description;
    trimToolSchemas([original], 100);
    expect(original.function.description).toBe(originalDesc);
  });
});
