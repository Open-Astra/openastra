import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Hoisted shared objects ────────────────────────────────────────────
const { mockOpenAIClient, mockClaudeClient, mockGeminiClient, mockGrokClient, mockGroqClient, mockOllamaClient, mockOpenRouterClient, mockMistralClient, mockBedrockClient, mockResilientClient, mockWarmPool } = vi.hoisted(() => {
  const makeClient = (name: string) => ({
    chat: vi.fn().mockResolvedValue({ content: `${name} response`, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: "stop" }),
    chatStream: vi.fn(),
    _name: name,
  });

  return {
    mockOpenAIClient: makeClient("openai"),
    mockClaudeClient: makeClient("claude"),
    mockGeminiClient: makeClient("gemini"),
    mockGrokClient: makeClient("grok"),
    mockGroqClient: makeClient("groq"),
    mockOllamaClient: makeClient("ollama"),
    mockOpenRouterClient: makeClient("openrouter"),
    mockMistralClient: makeClient("mistral"),
    mockBedrockClient: makeClient("bedrock"),
    mockResilientClient: { chat: vi.fn().mockResolvedValue({ content: "resilient", toolCalls: [], usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }, finishReason: "stop" }), chatStream: vi.fn() },
    mockWarmPool: {
      get: vi.fn().mockReturnValue(null),
      add: vi.fn(),
      poolSize: vi.fn().mockReturnValue(0),
    },
  };
});

vi.mock("../../src/inference/openai.js", () => ({
  createOpenAIClient: vi.fn().mockReturnValue(mockOpenAIClient),
}));
vi.mock("../../src/inference/claude.js", () => ({
  createClaudeClient: vi.fn().mockReturnValue(mockClaudeClient),
}));
vi.mock("../../src/inference/gemini.js", () => ({
  createGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
}));
vi.mock("../../src/inference/grok.js", () => ({
  createGrokClient: vi.fn().mockReturnValue(mockGrokClient),
}));
vi.mock("../../src/inference/groq.js", () => ({
  createGroqClient: vi.fn().mockReturnValue(mockGroqClient),
}));
vi.mock("../../src/inference/ollama.js", () => ({
  createOllamaClient: vi.fn().mockReturnValue(mockOllamaClient),
}));
vi.mock("../../src/inference/openrouter.js", () => ({
  createOpenRouterClient: vi.fn().mockReturnValue(mockOpenRouterClient),
}));
vi.mock("../../src/inference/mistral.js", () => ({
  createMistralClient: vi.fn().mockReturnValue(mockMistralClient),
}));
vi.mock("../../src/inference/bedrock.js", () => ({
  createBedrockClient: vi.fn().mockReturnValue(mockBedrockClient),
}));
vi.mock("../../src/inference/resilient.js", () => ({
  createResilientClient: vi.fn().mockReturnValue(mockResilientClient),
}));
vi.mock("../../src/inference/warm-pool.js", () => ({
  warmPool: mockWarmPool,
}));

import { createOpenAIClient } from "../../src/inference/openai.js";
import { createClaudeClient } from "../../src/inference/claude.js";
import { createGeminiClient } from "../../src/inference/gemini.js";
import { createResilientClient } from "../../src/inference/resilient.js";
import { getInferenceClientForAgent, createInferenceClient } from "../../src/inference/factory.js";
import type { AgentConfig } from "../../src/agents/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAgentConfig(provider: string, modelId: string, endpoint?: string): AgentConfig {
  return {
    id: "agent-1",
    name: "Test Agent",
    description: "Test",
    model: { provider: provider as AgentConfig["model"]["provider"], modelId, endpoint },
    systemPrompt: "",
    tools: { allow: [], deny: [] },
    memory: { enabled: false },
    spawn: { enabled: false, allowedTargets: [], maxDepth: 2 },
    skills: [],
    workspace: null,
  } as unknown as AgentConfig;
}

describe("factory: getInferenceClientForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GROK_API_KEY;
    mockWarmPool.get.mockReturnValue(null);
  });

  it("creates OpenAI client when provider=openai", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const config = makeAgentConfig("openai", "gpt-4o");
    const client = getInferenceClientForAgent(config);
    expect(createOpenAIClient).toHaveBeenCalledWith("test-openai-key", "gpt-4o");
    expect(createResilientClient).toHaveBeenCalled();
    expect(client).toBe(mockResilientClient);
  });

  it("creates Claude client when provider=claude", () => {
    process.env.ANTHROPIC_API_KEY = "test-claude-key";
    const config = makeAgentConfig("claude", "claude-sonnet-4-20250514");
    const client = getInferenceClientForAgent(config);
    expect(createClaudeClient).toHaveBeenCalledWith("test-claude-key", "claude-sonnet-4-20250514");
    expect(createResilientClient).toHaveBeenCalled();
    expect(client).toBe(mockResilientClient);
  });

  it("creates Gemini client when provider=gemini", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const config = makeAgentConfig("gemini", "gemini-2.0-flash");
    const client = getInferenceClientForAgent(config);
    expect(createGeminiClient).toHaveBeenCalledWith("test-gemini-key", "gemini-2.0-flash");
    expect(createResilientClient).toHaveBeenCalled();
    expect(client).toBe(mockResilientClient);
  });

  it("returns cached client on second call with same config (cache deduplication)", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const config = makeAgentConfig("openai", "gpt-4o-unique-model");
    const client1 = getInferenceClientForAgent(config);
    const client2 = getInferenceClientForAgent(config);
    // Both should return the same instance
    expect(client1).toBe(client2);
    // createOpenAIClient was called exactly once (second call hits cache)
    expect(createOpenAIClient).toHaveBeenCalledTimes(1);
  });

  it("different provider+model combinations return different clients", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const configA = makeAgentConfig("openai", "gpt-4o-model-a");
    const configB = makeAgentConfig("claude", "claude-haiku-model-b");
    // Each creates separately — both are mockResilientClient but calls are separate
    getInferenceClientForAgent(configA);
    getInferenceClientForAgent(configB);
    expect(createResilientClient).toHaveBeenCalledTimes(2);
  });

  it("returns warm pool client when available (bypasses createPrimaryClient)", () => {
    const warmedClient = { chat: vi.fn(), chatStream: vi.fn() };
    mockWarmPool.get.mockReturnValue(warmedClient);
    process.env.OPENAI_API_KEY = "test-key";
    const config = makeAgentConfig("openai", "gpt-4o-warm");
    const client = getInferenceClientForAgent(config);
    expect(mockWarmPool.get).toHaveBeenCalledWith("openai", "gpt-4o-warm");
    expect(client).toBe(warmedClient);
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it("throws when API key is missing for openai provider", () => {
    delete process.env.OPENAI_API_KEY;
    const config = makeAgentConfig("openai", "gpt-4o-no-key");
    expect(() => getInferenceClientForAgent(config)).toThrow("OPENAI_API_KEY required for openai provider");
  });

  it("throws when API key is missing for claude provider", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const config = makeAgentConfig("claude", "claude-sonnet-no-key");
    expect(() => getInferenceClientForAgent(config)).toThrow("ANTHROPIC_API_KEY required for claude provider");
  });

  it("createInferenceClient (deprecated) still wraps in resilient client", () => {
    process.env.OPENAI_API_KEY = "deprecated-key";
    const config = makeAgentConfig("openai", "gpt-4o-deprecated");
    const client = createInferenceClient(config.model);
    expect(createOpenAIClient).toHaveBeenCalled();
    expect(createResilientClient).toHaveBeenCalled();
    expect(client).toBe(mockResilientClient);
  });
});
