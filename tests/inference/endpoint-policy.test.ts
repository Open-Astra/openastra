import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isBlockedUrl } = vi.hoisted(() => ({ isBlockedUrl: vi.fn() }));
vi.mock("../../src/utils/ssrf-guard.js", () => ({ isBlockedUrl }));

import {
  UntrustedEndpointError,
  _resetTrustedEndpoints,
  assertKeyedEndpointAllowed,
  breakerLabel,
  guardUntrustedEndpoint,
  isTrustedInferenceEndpoint,
  trustInferenceEndpoint,
} from "../../src/inference/endpoint-policy.js";
import type { InferenceClient } from "../../src/inference/types.js";

const saved = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  _resetTrustedEndpoints();
  for (const k of ["INFERENCE_ENDPOINT_ALLOWLIST", "OLLAMA_BASE_URL", "EDGE_INFERENCE_URL", "VLLM_BASE_URL", "LMSTUDIO_BASE_URL"]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...saved };
});

const GROK = "https://api.x.ai/v1";

describe("keyed providers never send the platform key to an untrusted endpoint", () => {
  it("allows the default endpoint and no endpoint", () => {
    expect(() => assertKeyedEndpointAllowed("grok", undefined, GROK)).not.toThrow();
    expect(() => assertKeyedEndpointAllowed("grok", "https://api.x.ai/v1", GROK)).not.toThrow();
  });

  it("rejects an attacker-supplied endpoint", () => {
    expect(() => assertKeyedEndpointAllowed("grok", "https://attacker.tld/v1", GROK)).toThrow(UntrustedEndpointError);
    expect(() => assertKeyedEndpointAllowed("grok", "https://api.x.ai.attacker.tld/v1", GROK)).toThrow(UntrustedEndpointError);
    expect(() => assertKeyedEndpointAllowed("grok", "http://api.x.ai/v1", GROK)).toThrow(UntrustedEndpointError);
    expect(() => assertKeyedEndpointAllowed("grok", "file:///etc/passwd", GROK)).toThrow(UntrustedEndpointError);
  });

  it("allows endpoints the operator put in the allowlist env or astra.yml", () => {
    process.env.INFERENCE_ENDPOINT_ALLOWLIST = "https://proxy.corp.example, https://eu.x.ai";
    expect(() => assertKeyedEndpointAllowed("grok", "https://proxy.corp.example/v1", GROK)).not.toThrow();
    trustInferenceEndpoint("http://localhost:1234/v1");
    expect(isTrustedInferenceEndpoint("http://localhost:1234/other")).toBe(true);
    expect(isTrustedInferenceEndpoint("http://localhost:9999/v1")).toBe(false);
  });
});

describe("untrusted keyless endpoints are SSRF-checked on use", () => {
  const inner: InferenceClient = {
    chat: vi.fn().mockResolvedValue({ content: "ok", toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" }),
    async *chatStream() { yield { type: "done" as const }; },
  };
  const req = { messages: [{ role: "user" as const, content: "hi" }] };

  it("blocks internal targets before any request is made", async () => {
    isBlockedUrl.mockResolvedValue(true);
    const client = guardUntrustedEndpoint(inner, "ollama", "http://169.254.169.254");
    await expect(client.chat(req)).rejects.toThrow(UntrustedEndpointError);
    expect(inner.chat).not.toHaveBeenCalled();
  });

  it("fails closed when the guard itself errors", async () => {
    isBlockedUrl.mockRejectedValue(new Error("dns down"));
    const client = guardUntrustedEndpoint(inner, "vllm", "http://example.com");
    await expect(client.chat(req)).rejects.toThrow(UntrustedEndpointError);
  });

  it("passes public targets through", async () => {
    isBlockedUrl.mockResolvedValue(false);
    const client = guardUntrustedEndpoint(inner, "ollama", "https://models.example.com");
    await expect(client.chat(req)).resolves.toMatchObject({ content: "ok" });
  });
});

describe("circuit breaker labels are per provider", () => {
  it("separates providers and trusted hosts; buckets untrusted endpoints", () => {
    expect(breakerLabel("openai", undefined)).toBe("openai");
    expect(breakerLabel("claude", undefined)).toBe("claude");
    trustInferenceEndpoint("http://localhost:1234/v1");
    expect(breakerLabel("vllm", "http://localhost:1234/v1")).toBe("vllm@localhost:1234");
    expect(breakerLabel("ollama", "https://random.example")).toBe("ollama@untrusted");
  });
});
