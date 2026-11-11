import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isBlockedUrl = vi.fn();
vi.mock("../../../src/utils/ssrf-guard.js", () => ({
  isBlockedUrl: (url: string) => isBlockedUrl(url),
}));

import { checkModelEndpoint } from "../../../src/gateway/middleware/model-endpoint.js";

// Regression tests for the critical audit finding: a caller-supplied
// model.endpoint received the platform's provider API key (grok/openai/…)
// or let the gateway be used as an SSRF proxy (ollama/vllm).

const saved = { ...process.env };
beforeEach(() => {
  isBlockedUrl.mockReset();
  isBlockedUrl.mockResolvedValue(false);
  delete process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("checkModelEndpoint", () => {
  it("accepts a model with no endpoint", async () => {
    expect(await checkModelEndpoint({ provider: "grok" }, { isAdmin: false })).toBeNull();
    expect(await checkModelEndpoint(undefined, { isAdmin: false })).toBeNull();
  });

  it.each(["grok", "groq", "openai", "gemini", "claude", "openrouter", "mistral", "bedrock"])(
    "never accepts a custom endpoint for keyed provider %s — even from an admin",
    async (provider) => {
      const endpoint = "https://attacker.example/v1";
      expect(await checkModelEndpoint({ provider, endpoint }, { isAdmin: false })).toMatch(/not accepted/);
      expect(await checkModelEndpoint({ provider, endpoint }, { isAdmin: true })).toMatch(/not accepted/);
      expect(isBlockedUrl).not.toHaveBeenCalled();
    },
  );

  it("requires the platform admin for self-hosted provider endpoints", async () => {
    const reason = await checkModelEndpoint(
      { provider: "vllm", endpoint: "https://models.example.com/v1" },
      { isAdmin: false },
    );
    expect(reason).toMatch(/platform admin/);
  });

  it("rejects admin-supplied endpoints that resolve to internal addresses", async () => {
    isBlockedUrl.mockResolvedValue(true);
    const reason = await checkModelEndpoint(
      { provider: "ollama", endpoint: "http://169.254.169.254/latest/meta-data" },
      { isAdmin: true },
    );
    expect(reason).toMatch(/private or blocked/);
  });

  it("fails closed when the SSRF guard throws", async () => {
    isBlockedUrl.mockRejectedValue(new Error("dns failure"));
    const reason = await checkModelEndpoint(
      { provider: "ollama", endpoint: "http://models.example.com" },
      { isAdmin: true },
    );
    expect(reason).toMatch(/private or blocked/);
  });

  it("rejects non-http schemes", async () => {
    const reason = await checkModelEndpoint(
      { provider: "vllm", endpoint: "file:///etc/passwd" },
      { isAdmin: true },
    );
    expect(reason).toMatch(/http/);
  });

  it("accepts an admin-supplied public endpoint", async () => {
    expect(
      await checkModelEndpoint({ provider: "vllm", endpoint: "https://models.example.com/v1" }, { isAdmin: true }),
    ).toBeNull();
  });

  it("lets the operator opt in to private endpoints for self-hosted providers only", async () => {
    process.env.ALLOW_PRIVATE_MODEL_ENDPOINTS = "true";
    isBlockedUrl.mockResolvedValue(true);
    expect(
      await checkModelEndpoint({ provider: "ollama", endpoint: "http://localhost:11434" }, { isAdmin: true }),
    ).toBeNull();
    // still admin-only, and still never for keyed providers
    expect(
      await checkModelEndpoint({ provider: "ollama", endpoint: "http://localhost:11434" }, { isAdmin: false }),
    ).toMatch(/platform admin/);
    expect(
      await checkModelEndpoint({ provider: "openai", endpoint: "http://localhost:11434" }, { isAdmin: true }),
    ).toMatch(/not accepted/);
  });
});
