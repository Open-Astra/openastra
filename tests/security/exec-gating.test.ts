import { describe, it, expect, afterEach } from "vitest";
import { decideExecution, minimalChildEnv } from "../../src/tools/exec-sandbox.js";
import { _testOnly as shell } from "../../src/tools/shell-execute.js";
import { isHotReloadAllowed } from "../../src/plugins/hot-reload.js";

const ENV_KEYS = [
  "ASTRA_STANDALONE", "ASTRA_ENABLE_CODE_EXEC", "ASTRA_ENABLE_SHELL_EXEC",
  "ASTRA_HOT_RELOAD", "NODE_ENV", "SHELL_ALLOWED_PREFIXES",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("decideExecution — server mode", () => {
  it("refuses code and shell execution by default", () => {
    delete process.env.ASTRA_STANDALONE;
    delete process.env.ASTRA_ENABLE_CODE_EXEC;
    delete process.env.ASTRA_ENABLE_SHELL_EXEC;
    for (const mode of ["process", "none", "docker", undefined]) {
      expect(decideExecution("code_execute", mode).allowed).toBe(false);
      expect(decideExecution("shell_execute", mode).allowed).toBe(false);
    }
  });

  it("refuses when opted in but no container sandbox is configured", () => {
    delete process.env.ASTRA_STANDALONE;
    process.env.ASTRA_ENABLE_CODE_EXEC = "true";
    process.env.ASTRA_ENABLE_SHELL_EXEC = "true";
    expect(decideExecution("code_execute", "process").allowed).toBe(false);
    expect(decideExecution("shell_execute", "none").allowed).toBe(false);
  });

  it("allows only with opt-in AND the docker sandbox, and then only in the container", () => {
    delete process.env.ASTRA_STANDALONE;
    process.env.ASTRA_ENABLE_CODE_EXEC = "true";
    const d = decideExecution("code_execute", "docker");
    expect(d).toMatchObject({ allowed: true, container: true });
    // the flags are per tool
    delete process.env.ASTRA_ENABLE_SHELL_EXEC;
    expect(decideExecution("shell_execute", "docker").allowed).toBe(false);
  });

  it("allows host execution in the standalone CLI", () => {
    process.env.ASTRA_STANDALONE = "1";
    expect(decideExecution("shell_execute", "process")).toMatchObject({ allowed: true, container: false });
  });
});

describe("minimalChildEnv", () => {
  it("never forwards secrets from the parent environment", () => {
    process.env.OPENAI_API_KEY_TEST_ONLY = "sk-should-not-leak";
    try {
      const env = minimalChildEnv();
      expect(Object.keys(env)).not.toContain("OPENAI_API_KEY_TEST_ONLY");
      expect(Object.values(env)).not.toContain("sk-should-not-leak");
      for (const key of Object.keys(env)) {
        expect(/KEY|SECRET|TOKEN|PASSWORD/i.test(key)).toBe(false);
      }
      expect(env.PATH).toBeTruthy();
    } finally {
      delete process.env.OPENAI_API_KEY_TEST_ONLY;
    }
  });
});

describe("shell_execute — default allowlist", () => {
  it("has no interpreters, build drivers, docker or psql in server mode", () => {
    delete process.env.ASTRA_STANDALONE;
    delete process.env.SHELL_ALLOWED_PREFIXES;
    const allowed = shell.getAllowedPrefixes();
    for (const cmd of ["node", "npx", "tsx", "npm", "python", "python3", "pip", "docker", "docker-compose", "psql", "make", "cargo", "go", "sh", "bash"]) {
      expect(allowed, cmd).not.toContain(cmd);
    }
    expect(allowed).toContain("git");
    expect(allowed).toContain("grep");
  });
});

describe("shell_execute — validateCommand", () => {
  const rejected = (cmd: string) => expect(shell.validateCommand(cmd, true), cmd).not.toBeNull();
  const accepted = (cmd: string) => expect(shell.validateCommand(cmd, true), cmd).toBeNull();

  it("rejects the bypasses that passed the old regex filter", () => {
    delete process.env.SHELL_ALLOWED_PREFIXES;
    rejected("find . -exec sh -c 'id' {} +");
    rejected("find . -name x -delete");
    rejected("awk 'BEGIN{system(\"id\")}'");
    rejected("git -c core.pager=id log");
    rejected("git log --output=/tmp/x");
    rejected("cat .en?");
    rejected("cat .e*");
    rejected("cat .[e]nv");
    rejected("echo x > src/plugins/core/e/index.js");
    rejected("echo x >> notes.txt");
    rejected("sed -i s/a/b/ astra.yml");
    rejected("sed '1e id' file.txt");
    rejected("sort -o /tmp/out file.txt");
    rejected("fd -x rm");
    rejected("LD_PRELOAD=/tmp/x.so ls");
    rejected("cat ${HOME}/x");
    rejected("node -e \"console.log(process['en'+'v'])\"");
    rejected("python3 -c 'import os'");
    rejected("cat /proc/self/environ");
    rejected("git config alias.x '!id'");
    rejected("git fetch --upload-pack=id origin");
  });

  it("still allows ordinary read-only inspection", () => {
    delete process.env.SHELL_ALLOWED_PREFIXES;
    accepted("git status");
    accepted("git log --oneline -5");
    accepted("ls -la src");
    accepted("grep -rin TODO src");
    accepted("grep -o foo file.txt");
    accepted("wc -l README.md");
    accepted("find src -name index.ts");
    accepted("awk '{print $1}' data.txt");
    accepted("cat .env.example");
    accepted("head -n 20 package.json 2>&1");
  });
});

describe("hot reload gate", () => {
  it("is off by default and always off in production", () => {
    delete process.env.ASTRA_HOT_RELOAD;
    process.env.NODE_ENV = "development";
    expect(isHotReloadAllowed()).toBe(false);

    process.env.ASTRA_HOT_RELOAD = "true";
    process.env.NODE_ENV = "production";
    expect(isHotReloadAllowed()).toBe(false);

    process.env.NODE_ENV = "development";
    expect(isHotReloadAllowed()).toBe(true);
  });
});
