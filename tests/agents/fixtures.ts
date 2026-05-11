import { vi } from "vitest";
import type { AgentConfig } from "../../src/agents/types.js";
import type {
  InferenceClient,
  InferenceResponse,
  InferenceStreamDelta,
} from "../../src/inference/types.js";
import type { MessageDoc, ResolvedSession, SessionDoc } from "../../src/sessions/types.js";
import { randomUUID } from "node:crypto";

// ── Agent Config Factory ────────────────────────────────────────────

export function createTestAgentConfig(
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  return {
    id: "test-agent",
    displayName: "Test Agent",
    tier: "free",
    model: {
      provider: "openai",
      modelId: "gpt-4o-mini",
      maxContextTokens: 8192,
      maxOutputTokens: 1024,
      temperature: 0.7,
    },
    systemPromptTemplate: "You are a helpful test agent.",
    tools: {
      allow: [],
      deny: [],
      maxToolCallsPerRound: 8,
    },
    skills: [],
    session: {
      dailyResetHour: 4,
      idleTimeoutMinutes: 120,
      maxContextMessages: 50,
    },
    spawn: {
      enabled: false,
      allowedTargets: [],
      maxDepth: 2,
    },
    fileAccess: {
      restricted: true,
      allowedPaths: [],
    },
    ...overrides,
  } as AgentConfig;
}

// ── Inference Response Helpers ──────────────────────────────────────

export function makeTextResponse(content: string): InferenceResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: "stop",
  };
}

export function makeToolCallResponse(
  calls: Array<{ id: string; name: string; arguments: string }>,
): InferenceResponse {
  return {
    content: null,
    toolCalls: calls,
    usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 },
    finishReason: "tool_calls",
  };
}

// ── Mock Inference Client ───────────────────────────────────────────

export function createMockInferenceClient(
  responses: InferenceResponse[],
): InferenceClient {
  const queue = [...responses];

  return {
    chat: vi.fn().mockImplementation(async () => {
      const next = queue.shift();
      if (!next) throw new Error("No more mock responses in queue");
      return next;
    }),
    chatStream: vi.fn().mockImplementation(async function* () {
      const next = queue.shift();
      if (!next) throw new Error("No more mock responses in queue");

      // Yield content deltas if there's text content
      if (next.content) {
        const chunks = next.content.match(/.{1,20}/g) ?? [next.content];
        for (const chunk of chunks) {
          yield {
            type: "content" as const,
            content: chunk,
          } satisfies InferenceStreamDelta;
        }
      }

      // Yield tool call deltas if present
      for (let i = 0; i < next.toolCalls.length; i++) {
        const tc = next.toolCalls[i];
        yield {
          type: "tool_call" as const,
          toolCall: {
            index: i,
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          },
        } satisfies InferenceStreamDelta;
      }

      // Yield done with usage
      yield {
        type: "done" as const,
        usage: next.usage,
      } satisfies InferenceStreamDelta;
    }),
  };
}

// ── Mock Session ────────────────────────────────────────────────────

export function createMockSession(id?: string): ResolvedSession {
  const sessionId = id ?? randomUUID();
  const session: SessionDoc = {
    id: sessionId,
    key: { uid: "test-user", surface: "chat", surfaceId: "main" },
    agentId: "test-agent",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
    tokenCount: 0,
    status: "active",
  };
  return { session, messages: [], isNew: true };
}

// ── Mock Event Bus ──────────────────────────────────────────────────

export function createMockEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn().mockReturnValue(() => {}),
    off: vi.fn(),
    onAny: vi.fn().mockReturnValue(() => {}),
    clear: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
  };
}

// ── Mock persistMessage ─────────────────────────────────────────────
// Returns a MessageDoc with generated id, so allMessages accumulates correctly.

let msgCounter = 0;
export function resetMsgCounter(): void {
  msgCounter = 0;
}

export function mockPersistMessage(
  _uid: string,
  _sessionId: string,
  message: Omit<MessageDoc, "id">,
): MessageDoc {
  return {
    ...message,
    id: `msg-${++msgCounter}`,
  } as MessageDoc;
}
