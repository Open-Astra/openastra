import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";

vi.mock("../../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), dim: vi.fn(), active: vi.fn(), warn: vi.fn() }),
}));

const executeTool = vi.fn();
vi.mock("../../../src/tools/registry.js", () => ({
  getTool: (name: string) =>
    ["shell_execute", "get-current-datetime"].includes(name)
      ? { name, parameters: z.object({}).passthrough() }
      : undefined,
  getRegisteredToolNames: () => ["shell_execute", "get-current-datetime"],
  executeTool: (...args: unknown[]) => executeTool(...args),
}));

vi.mock("../../../src/workspaces/store.js", () => ({
  getMemberRole: vi.fn().mockResolvedValue("owner"),
}));

import { createToolPlaygroundRouter } from "../../../src/gateway/routes/tool-playground.js";

// Regression tests for the critical audit finding: POST /playground/tool/:name
// let any JWT holder run any registered tool (including shell_execute).

const ADMIN_KEY = "test-internal-api-key-0123456789";
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for jwtAuth(): every request is an ordinary authenticated user
  app.use((req, _res, next) => {
    (req as unknown as { uid: string }).uid = "user-1";
    next();
  });
  app.use("/", createToolPlaygroundRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const saved = { ...process.env };
beforeEach(() => {
  executeTool.mockReset();
  executeTool.mockResolvedValue({ toolCallId: "1", name: "x", content: "{}", durationMs: 1 });
  process.env.INTERNAL_API_KEY = ADMIN_KEY;
  delete process.env.TOOL_PLAYGROUND_ENABLED;
  delete process.env.TOOL_PLAYGROUND_TOOLS;
});
afterEach(() => {
  process.env = { ...saved };
});

function call(tool: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/playground/tool/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ command: "id" }),
  });
}

describe("tool playground gating", () => {
  it("is disabled by default (404), even with the admin key", async () => {
    const res = await call("shell_execute", { "x-api-key": ADMIN_KEY });
    expect(res.status).toBe(404);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects an ordinary authenticated user when enabled", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    const res = await call("get-current-datetime");
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects a wrong admin key", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    const res = await call("get-current-datetime", { "x-api-key": "x".repeat(ADMIN_KEY.length) });
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("fails closed when INTERNAL_API_KEY is not configured", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    delete process.env.INTERNAL_API_KEY;
    const res = await call("get-current-datetime", { "x-api-key": "" });
    expect(res.status).toBe(503);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("refuses host-access tools even for an admin unless explicitly allowlisted", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    const res = await call("shell_execute", { "x-api-key": ADMIN_KEY });
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("runs an allowed tool for an admin through executeTool (policy path)", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    const res = await call("get-current-datetime", { "x-api-key": ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(executeTool).toHaveBeenCalledTimes(1);
    const [toolCall, ctx, allowed] = executeTool.mock.calls[0]!;
    expect(toolCall.name).toBe("get-current-datetime");
    expect(ctx.uid).toBe("user-1");
    expect([...allowed]).toEqual(["get-current-datetime"]);
  });

  it("allows a host-access tool only when the operator lists it", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    process.env.TOOL_PLAYGROUND_TOOLS = "shell-execute";
    const ok = await call("shell_execute", { "x-api-key": ADMIN_KEY });
    expect(ok.status).toBe(200);
    // …and the allowlist is exclusive
    const other = await call("get-current-datetime", { "x-api-key": ADMIN_KEY });
    expect(other.status).toBe(403);
  });

  it("surfaces a policy denial from executeTool instead of a result", async () => {
    process.env.TOOL_PLAYGROUND_ENABLED = "true";
    executeTool.mockResolvedValue({ toolCallId: "1", name: "x", content: "{}", durationMs: 1, error: "Tool denied by policy" });
    const res = await call("get-current-datetime", { "x-api-key": ADMIN_KEY });
    expect(res.status).toBe(422);
  });
});
