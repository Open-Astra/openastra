import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config/postgres.js", () => ({ getPool: () => ({}) }));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dim: vi.fn(), active: vi.fn() }),
}));

import { canonicalJson, computeEntryHash } from "../../src/observability/audit-ledger.js";

const base = {
  workspaceId: "ws1",
  chainSeq: 7,
  prevHash: "0".repeat(64),
  entryType: "tool.call",
  agentId: "a1",
  sessionId: "s1",
  uid: "u1",
  payload: { tool: "x", args: { b: 2, a: 1 } },
};

describe("audit ledger hashing", () => {
  it("canonical JSON is independent of key order (jsonb reorders keys)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }))
      .toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });

  it("the hash survives a jsonb round-trip that reorders keys", () => {
    const reordered = { ...base, payload: { args: { a: 1, b: 2 }, tool: "x" } };
    expect(computeEntryHash(reordered)).toBe(computeEntryHash(base));
  });

  it("covers type, actor, session, position and workspace — not only the payload", () => {
    const h = computeEntryHash(base);
    expect(computeEntryHash({ ...base, entryType: "tool.result" })).not.toBe(h);
    expect(computeEntryHash({ ...base, uid: "someone-else" })).not.toBe(h);
    expect(computeEntryHash({ ...base, agentId: "a2" })).not.toBe(h);
    expect(computeEntryHash({ ...base, sessionId: null })).not.toBe(h);
    expect(computeEntryHash({ ...base, chainSeq: 8 })).not.toBe(h);
    expect(computeEntryHash({ ...base, workspaceId: "ws2" })).not.toBe(h);
    expect(computeEntryHash({ ...base, payload: { tool: "y", args: { a: 1, b: 2 } } })).not.toBe(h);
  });
});
