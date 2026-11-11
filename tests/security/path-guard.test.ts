import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/security/intrusion-detection.js", () => ({ recordThreat: vi.fn() }));

const { mockGetAgentConfig } = vi.hoisted(() => ({ mockGetAgentConfig: vi.fn() }));
vi.mock("../../src/config/agents.js", () => ({
  getAgentConfig: (...a: unknown[]) => mockGetAgentConfig(...a),
}));

import { guardPath, isSecretPath, isWithin, PathGuardError } from "../../src/tools/path-guard.js";

let root: string;
let outside: string;
const savedStandalone = process.env.ASTRA_STANDALONE;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "astra-pg-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "astra-pg-out-")));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "src", "skills", "definitions"), { recursive: true });
  mkdirSync(join(root, "work"));
  mkdirSync(join(root, "work-evil"));
  writeFileSync(join(root, "data", "notes.txt"), "hello");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(outside, "secret.txt"), "outside");
  symlinkSync(outside, join(root, "data", "escape"));
  symlinkSync(join(root, ".env"), join(root, "data", "innocent.txt"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

afterEach(() => {
  if (savedStandalone === undefined) delete process.env.ASTRA_STANDALONE;
  else process.env.ASTRA_STANDALONE = savedStandalone;
  mockGetAgentConfig.mockReset();
});

const read = (p: string, agentId?: string) => guardPath(p, { access: "read", baseDir: root, agentId });
const write = (p: string) => guardPath(p, { access: "write", baseDir: root });

describe("isWithin — separator-safe prefix", () => {
  it("does not treat a sibling with the same prefix as inside", () => {
    expect(isWithin("/srv/app/x", "/srv/app")).toBe(true);
    expect(isWithin("/srv/app", "/srv/app")).toBe(true);
    expect(isWithin("/srv/app-evil/x", "/srv/app")).toBe(false);
  });
});

describe("isSecretPath", () => {
  it("flags env files, keys and credential stores", () => {
    for (const p of [
      "/a/.env", "/a/.env.local", "/a/.env.production", "/a/prod.env", "/a/.npmrc", "/a/.netrc",
      "/a/server.pem", "/a/tls.key", "/a/.ssh/config", "/a/.aws/credentials", "/a/id_rsa",
      "/a/service-account-prod.json", "/a/credentials.json", "/a/.git/config", "/a/.astra/config.json",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });

  it("does not flag ordinary files or env templates", () => {
    for (const p of ["/a/.env.example", "/a/README.md", "/a/src/environment.ts", "/a/keys.md", "/a/.gitignore"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});

describe("guardPath", () => {
  it("returns the real path for a normal file inside the root", () => {
    expect(read("data/notes.txt")).toBe(join(root, "data", "notes.txt"));
  });

  it("rejects traversal and absolute paths outside the root", () => {
    expect(() => read("../../etc/passwd")).toThrow(PathGuardError);
    expect(() => read("/etc/passwd")).toThrow(PathGuardError);
    expect(() => read(join(outside, "secret.txt"))).toThrow(PathGuardError);
  });

  it("rejects symlinks that escape the root", () => {
    expect(() => read("data/escape/secret.txt")).toThrow(/symlink|outside/);
  });

  it("rejects secrets, including through an innocently named symlink", () => {
    expect(() => read(".env")).toThrow(/restricted/);
    expect(() => read("data/innocent.txt")).toThrow(/restricted/);
    expect(() => write(".env.local")).toThrow(/restricted/);
  });

  it("enforces agent allowedPaths with a separator-safe check and fails closed for unknown agents", () => {
    mockGetAgentConfig.mockReturnValue({ fileAccess: { restricted: true, allowedPaths: [join(root, "work")] } });
    expect(read("work/new.txt", "a1")).toBe(join(root, "work", "new.txt"));
    expect(() => read("work-evil/x.txt", "a1")).toThrow(/restricted/);
    expect(() => read("data/notes.txt", "a1")).toThrow(/restricted/);

    mockGetAgentConfig.mockImplementation(() => { throw new Error("Unknown agent: nope"); });
    expect(() => read("data/notes.txt", "nope")).toThrow(/could not be resolved/);
  });
});

describe("guardPath — server-mode protected writes", () => {
  it("refuses to write application code or config when the root is the process cwd", () => {
    delete process.env.ASTRA_STANDALONE;
    const cwd = process.cwd();
    const w = (p: string) => guardPath(p, { access: "write", baseDir: cwd });
    expect(() => w("src/skills/definitions/evil/index.ts")).toThrow(/not allowed/);
    expect(() => w("src/plugins/core/evil/index.js")).toThrow(/not allowed/);
    expect(() => w("dist/tools/x.js")).toThrow(/not allowed/);
    expect(() => w("astra.yml")).toThrow(/not allowed/);
    expect(() => w("SOUL.md")).toThrow(/not allowed/);
    expect(() => w("package.json")).toThrow(/not allowed/);
    expect(() => w("node_modules/x/index.js")).toThrow(/not allowed/);
    // data directories remain writable
    expect(w("exports/report.html")).toBe(join(realpathSync(cwd), "exports", "report.html"));
  });

  it("leaves project files writable in the standalone CLI", () => {
    process.env.ASTRA_STANDALONE = "1";
    const cwd = process.cwd();
    expect(guardPath("src/new-file.ts", { access: "write", baseDir: cwd })).toBe(
      join(realpathSync(cwd), "src", "new-file.ts"),
    );
  });
});
