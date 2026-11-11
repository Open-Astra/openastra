import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPool } = vi.hoisted(() => ({
  mockPool: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
}));

vi.mock("../../src/config/postgres.js", () => ({ getPool: () => mockPool }));
vi.mock("../../src/utils/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), dim: vi.fn(), active: vi.fn() }),
}));
vi.mock("../../src/secrets/vault.js", () => ({
  getSecret: vi.fn(async (key: string) => process.env[key]),
}));

import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  isEnvelope,
} from "../../src/secrets/envelope.js";
import {
  getWorkspaceSecret,
  openWorkspaceSecret,
  sealWorkspaceSecret,
  setWorkspaceSecret,
} from "../../src/workspaces/secrets.js";

const KEY_HEX = "a".repeat(64);
const saved = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  delete process.env.WORKSPACE_SECRETS_KEY;
  delete process.env.WORKSPACE_SECRETS_KEY_PREV;
  delete process.env.ASTRA_ENFORCE_SECURITY;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  process.env = { ...saved };
});

describe("secret envelope (AES-256-GCM)", () => {
  const key = deriveKey(KEY_HEX);

  it("round-trips and uses a versioned format with a fresh IV each time", () => {
    const a = encryptSecret("sk-live-value", key, "aad");
    const b = encryptSecret("sk-live-value", key, "aad");
    expect(a.startsWith("enc:v1:")).toBe(true);
    expect(a).not.toContain("sk-live-value");
    expect(a).not.toBe(b); // random IV
    expect(a.split(":")).toHaveLength(5);
    expect(Buffer.from(a.split(":")[2]!, "base64")).toHaveLength(12);
    expect(decryptSecret(a, key, "aad")).toBe("sk-live-value");
  });

  it("rejects tampered ciphertext, wrong key and wrong AAD", () => {
    const env = encryptSecret("value", key, "ws1:KEY");
    const parts = env.split(":");
    const ct = Buffer.from(parts[4]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [...parts.slice(0, 4), ct.toString("base64")].join(":");
    expect(() => decryptSecret(tampered, key, "ws1:KEY")).toThrow();
    expect(() => decryptSecret(env, deriveKey("b".repeat(64)), "ws1:KEY")).toThrow();
    // Ciphertext copied into another tenant's row must not decrypt
    expect(() => decryptSecret(env, key, "ws2:KEY")).toThrow();
  });

  it("derives keys from hex, base64 and passphrases; rejects short keys", () => {
    expect(deriveKey(KEY_HEX)).toHaveLength(32);
    expect(deriveKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    expect(deriveKey("a-long-passphrase-of-at-least-32-characters!")).toHaveLength(32);
    expect(() => deriveKey("short")).toThrow();
  });
});

describe("workspace secrets at rest", () => {
  it("stores ciphertext, never the plaintext value", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    await setWorkspaceSecret("ws1", "OPENAI_API_KEY", "sk-plain-123456", "user1");
    const params = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(isEnvelope(params[2] as string)).toBe(true);
    expect(JSON.stringify(params)).not.toContain("sk-plain-123456");
  });

  it("decrypts on read", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    const sealed = await sealWorkspaceSecret("ws1", "OPENAI_API_KEY", "sk-plain-123456");
    mockPool.query.mockResolvedValueOnce({ rows: [{ secret_value: sealed }] });
    expect(await getWorkspaceSecret("ws1", "OPENAI_API_KEY")).toBe("sk-plain-123456");
  });

  it("binds ciphertext to its workspace and key name", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    const sealed = await sealWorkspaceSecret("ws1", "OPENAI_API_KEY", "v");
    await expect(openWorkspaceSecret("ws2", "OPENAI_API_KEY", sealed)).rejects.toThrow();
    await expect(openWorkspaceSecret("ws1", "GROK_API_KEY", sealed)).rejects.toThrow();
  });

  it("reads legacy plaintext rows and re-encrypts them in place", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    mockPool.query.mockResolvedValueOnce({ rows: [{ secret_value: "legacy-plain" }] });
    expect(await getWorkspaceSecret("ws1", "OPENAI_API_KEY")).toBe("legacy-plain");
    await vi.waitFor(() => expect(mockPool.query).toHaveBeenCalledTimes(2));
    const [sql, params] = mockPool.query.mock.calls[1]! as [string, unknown[]];
    expect(sql).toMatch(/UPDATE workspace_secrets SET secret_value/);
    expect(isEnvelope(params[0] as string)).toBe(true);
    expect(params[3]).toBe("legacy-plain"); // compare-and-swap on the old value
  });

  it("decrypts with the previous key during rotation", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    const sealed = await sealWorkspaceSecret("ws1", "OPENAI_API_KEY", "rotating");
    process.env.WORKSPACE_SECRETS_KEY_PREV = KEY_HEX;
    process.env.WORKSPACE_SECRETS_KEY = "c".repeat(64);
    expect((await openWorkspaceSecret("ws1", "OPENAI_API_KEY", sealed)).value).toBe("rotating");
  });

  it("fails closed in production when no key is configured", async () => {
    process.env.NODE_ENV = "production";
    await expect(setWorkspaceSecret("ws1", "OPENAI_API_KEY", "v", "u")).rejects.toThrow(/WORKSPACE_SECRETS_KEY/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("cannot return an encrypted value when the key is missing", async () => {
    process.env.WORKSPACE_SECRETS_KEY = KEY_HEX;
    const sealed = await sealWorkspaceSecret("ws1", "OPENAI_API_KEY", "v");
    delete process.env.WORKSPACE_SECRETS_KEY;
    mockPool.query.mockResolvedValueOnce({ rows: [{ secret_value: sealed }] });
    expect(await getWorkspaceSecret("ws1", "OPENAI_API_KEY")).toBeUndefined();
  });
});
