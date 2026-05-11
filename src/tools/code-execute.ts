import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { registerTool } from "./registry.js";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("code-execute");

// ── code_execute ──────────────────────────────────────────────────────
// Sandboxed code execution for JavaScript (Node.js) and Python.
// Timeout-protected with dangerous pattern blocking.
// Sandbox mode controlled by CODE_EXEC_SANDBOX env var:
//   none    — legacy execFile with limited env (no isolation)
//   process — spawn with completely empty env (default)
//   docker  — full Docker isolation (network-off, read-only fs, cgroup limits)

const CodeExecuteParams = z.object({
  code: z.string().min(1).describe("Source code to execute"),
  language: z
    .enum(["javascript", "python"])
    .describe("Programming language to execute"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .default(5000)
    .describe("Execution timeout in milliseconds (default 5s, max 30s)"),
});

// Dangerous patterns that could escape the sandbox
const JS_BLOCKED = [
  // Block ALL require calls — literal, variable, concatenated, template
  /\brequire\s*\(/,                             // block any require() call
  /import\s*\(/,                                // block ALL dynamic imports
  // Block process access — dot and bracket notation
  /\bprocess\s*\.\s*exit/,
  /\bprocess\s*\.\s*kill/,
  /\bprocess\s*\.\s*env/,
  /\bprocess\s*\.\s*binding\s*\(/,
  /\bprocess\s*\.\s*dlopen\s*\(/,
  /\bprocess\s*\.\s*_linkedBinding\s*\(/,
  /\bprocess\s*\.\s*mainModule/,
  /\bprocess\s*\[/,                             // block process['env'], process['exit'], etc.
  /\bglobalThis\s*\[\s*['"]process['"]\s*\]/,   // block globalThis['process']
  /\bglobalThis\s*\.\s*process/,
  /\bglobal\s*\[\s*['"]process['"]\s*\]/,       // block global['process']
  /\bglobal\s*\.\s*process/,
  // Block module system escape hatches
  /\bmodule\s*\.\s*constructor/,
  /\bmodule\s*\[/,                              // block module['constructor']
  /\bReflect\s*\.\s*apply/,
  /\bReflect\s*\[/,                             // block Reflect['apply']
  /\bReflect\s*\.\s*construct/,
  // Block Function/constructor chaining (eval via constructor.constructor)
  /\bFunction\s*\(/,
  /new\s+Function\b/,
  /\.constructor\s*\.\s*constructor/,           // block (fn).constructor.constructor()
  /\.constructor\s*\(/,                         // block any .constructor() call
  // Block prototype pollution vectors
  /\b__proto__\b/,
  /\bprototype\b/,
  // Block Proxy/Reflect metaprogramming escape
  /\bnew\s+Proxy\b/,
  // Block alternative runtime globals
  /\bDeno\b/,
  /\bBun\b/,
  // Block SharedArrayBuffer/Atomics (shared memory escape)
  /\bSharedArrayBuffer\b/,
  /\bAtomics\b/,
  // Block WebAssembly execution
  /\bWebAssembly\b/,
  // Block child_process/fs/net as string literals anywhere (catches variable assignments)
  /['"`]child_process['"`]/,
  /['"`]node:child_process['"`]/,
  /['"`]node:fs['"`]/,
  /['"`]node:net['"`]/,
  /['"`]node:dgram['"`]/,
  /['"`]node:cluster['"`]/,
  /['"`]node:worker_threads['"`]/,
  /['"`]node:vm['"`]/,
  /['"`]node:v8['"`]/,
  /['"`]node:inspector['"`]/,
];

const PY_BLOCKED = [
  /import\s+os\b/,
  /from\s+os\s+import/,
  /import\s+subprocess\b/,
  /from\s+subprocess\s+import/,
  /import\s+shutil\b/,
  /from\s+shutil\s+import/,
  /import\s+sys\b/,
  /from\s+sys\s+import/,
  /__import__\s*\(/,
  /\bexec\s*\(/,
  /\beval\s*\(/,
  /\bopen\s*\(/,
  /import\s+socket\b/,
  /from\s+socket\s+import/,
  /\bimportlib\b/,                              // block importlib module
  /\bgetattr\s*\(/,                             // block getattr() bypass
  /\bsetattr\s*\(/,                             // block setattr() manipulation
  /\bdelattr\s*\(/,                             // block delattr() manipulation
  /\b__builtins__\b/,                           // block builtins access
  /\bbreakpoint\s*\(/,                          // block debugger access
  /\bcompile\s*\(/,                             // block compile() code gen
  /\bpathlib\b/,                                // block pathlib file access
  /\bio\.open\s*\(/,                            // block io.open() bypass
  /\bbuiltins\b/,                               // block builtins module
  /\bglobals\s*\(/,                             // block globals() access
  /\blocals\s*\(/,                              // block locals() access
  /\bvars\s*\(/,                                // block vars() access
  /\bdir\s*\(/,                                 // block dir() introspection
  /\b__subclasses__\s*\(/,                      // block class hierarchy traversal
  /\b__bases__\b/,                              // block base class access
  /\b__mro__\b/,                                // block method resolution order
  /\b__class__\b/,                              // block class introspection
  /\btype\s*\.\s*__getattribute__/,             // block type.__getattribute__ escape
  /\bctypes\b/,                                 // block ctypes FFI
  /\bpickle\b/,                                 // block pickle deserialization attacks
  /\bmarshal\b/,                                // block marshal code object loading
  /\bcodecs\b/,                                 // block codecs module abuse
  /\bsignal\b/,                                 // block signal handling
  /\bmultiprocessing\b/,                        // block multiprocessing
  /\bthreading\b/,                              // block threading
];

// ── Docker Image Trust Check ──────────────────────────────────────────
// Only allow images from trusted registries. Images without a slash
// (e.g. "node:18", "python:3.12-alpine", "ubuntu") are considered
// official Docker Hub images and are trusted implicitly.

const TRUSTED_REGISTRIES = ["docker.io/", "ghcr.io/"];
const TRUSTED_OFFICIAL_PREFIXES = ["node:", "python:", "alpine:", "ubuntu:"];

function isImageTrusted(image: string): boolean {
  // Official images without a slash are always trusted (e.g. "ubuntu", "node:18")
  if (!image.includes("/")) return true;
  // Images from explicitly trusted registries
  if (TRUSTED_REGISTRIES.some((r) => image.startsWith(r))) return true;
  // Images matching official Docker Hub prefixes with tags
  if (TRUSTED_OFFICIAL_PREFIXES.some((r) => image.startsWith(r))) return true;
  return false;
}

const MAX_OUTPUT = 50_000; // 50KB cap

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  sandboxMode: string;
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n... [truncated]" : s;
}

// ── Executor: None (legacy, limited env) ────────────────────────────

function executeUnsandboxed(
  code: string,
  language: "javascript" | "python",
  timeoutMs: number,
): Promise<ExecResult> {
  const command = language === "javascript" ? "node" : "python3";
  const args = language === "javascript" ? ["-e", code] : ["-c", code];

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const child = execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT * 2,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "en_US.UTF-8" },
          signal: controller.signal,
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            const timedOut =
              error.killed ||
              error.code === "ABORT_ERR" ||
              (error as unknown as { signal?: string }).signal === "SIGTERM";
            resolve({
              stdout: truncate(stdout || ""),
              stderr: truncate(stderr || error.message),
              exitCode: typeof error.code === "number" ? error.code : 1,
              timedOut,
              sandboxMode: "none",
            });
          } else {
            resolve({ stdout: truncate(stdout || ""), stderr: truncate(stderr || ""), exitCode: 0, timedOut: false, sandboxMode: "none" });
          }
        },
      );
      setTimeout(() => { if (!child.killed) child.kill("SIGTERM"); }, timeoutMs + 1000);
    } catch (err) {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1, timedOut: false, sandboxMode: "none" });
    }
  });
}

// ── Executor: Process (spawn with empty env) ─────────────────────────

function executeInProcess(
  code: string,
  language: "javascript" | "python",
  timeoutMs: number,
): Promise<ExecResult> {
  const command = language === "javascript" ? "node" : "python3";
  const args = language === "javascript" ? ["-e", code] : ["-c", code];

  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code ?? 1, timedOut, sandboxMode: "process" });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: err.message, exitCode: 1, timedOut: false, sandboxMode: "process" });
    });
  });
}

// ── Executor: Docker (full isolation) ────────────────────────────────

function executeInDocker(
  code: string,
  language: "javascript" | "python",
  timeoutMs: number,
  memoryLimitMb: number,
  dockerImage: string,
): Promise<ExecResult> {
  const useStdin = language === "javascript";
  const image = language === "python" ? "python:3.12-alpine" : dockerImage;
  const interpreterArgs: string[] =
    language === "javascript"
      ? ["node", "--input-type=module"]
      : ["python3", "-c", code];

  if (!isImageTrusted(image)) {
    return new Promise((resolve) => resolve({
      stdout: "", stderr: `Untrusted Docker image registry: ${image}`, exitCode: 1, timedOut: false, sandboxMode: "docker",
    }));
  }

  const dockerArgs = [
    "run", "--rm", "--network=none",
    `--memory=${memoryLimitMb}m`, "--memory-swap=0",
    "--cpus=0.5", "--read-only",
    "--tmpfs=/tmp:size=64m,noexec",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--no-new-privileges",
    "--pids-limit=50",
    "--ulimit", "nproc=50:50",
    "--ulimit", "fsize=1048576:1048576",
    ...(useStdin ? ["-i"] : []),
    image,
    ...interpreterArgs,
  ];

  log.info(`docker sandbox: language=${language} image=${image}`);

  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const child = spawn("docker", dockerArgs, {
      stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    if (useStdin && child.stdin) {
      (child.stdin as import("stream").Writable).write(code, "utf8");
      (child.stdin as import("stream").Writable).end();
    }

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code ?? 1, timedOut, sandboxMode: "docker" });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: `docker error: ${err.message}`, exitCode: 1, timedOut: false, sandboxMode: "docker" });
    });
  });
}

// ── Tool Registration ─────────────────────────────────────────────────

registerTool({
  name: "code_execute",
  description:
    "Execute JavaScript (Node.js) or Python code in a sandboxed environment. Returns stdout, stderr, and exit code. Blocks dangerous operations like filesystem access, child process spawning, and network calls. Use for calculations, data processing, algorithm testing, etc.",
  parameters: CodeExecuteParams,
  async execute(params) {
    const blockedPatterns = params.language === "javascript" ? JS_BLOCKED : PY_BLOCKED;
    for (const pattern of blockedPatterns) {
      if (pattern.test(params.code)) {
        return { error: `Blocked: code contains a restricted pattern (${pattern.source}). Filesystem, network, and process operations are not allowed.` };
      }
    }

    const env = loadEnv();
    const timeoutMs = Math.min(params.timeoutMs, env.codeExecTimeoutMs);
    const sandbox = env.codeExecSandbox;

    log.info(`sandbox=${sandbox} language=${params.language} timeout=${timeoutMs}ms`);

    let result: ExecResult;
    if (sandbox === "docker") {
      result = await executeInDocker(params.code, params.language, timeoutMs, env.codeExecMemoryLimitMb, env.codeExecDockerImage);
    } else if (sandbox === "process") {
      result = await executeInProcess(params.code, params.language, timeoutMs);
    } else {
      result = await executeUnsandboxed(params.code, params.language, timeoutMs);
    }

    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut, sandboxMode: result.sandboxMode };
  },
});

export const _testOnly = { isImageTrusted, TRUSTED_REGISTRIES, TRUSTED_OFFICIAL_PREFIXES, JS_BLOCKED, PY_BLOCKED };
