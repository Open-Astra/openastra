import { z } from "zod";
import { createContext, Script } from "node:vm";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Code Execute Skill ────────────────────────────────────────────
// Executes JavaScript code in a node:vm sandbox with timeout
// protection and no access to process/require/import/globalThis.

const TIMEOUT_MS = 5000;

const CodeExecuteParams = z.object({
  code: z.string().describe("JavaScript code to execute"),
  language: z
    .enum(["javascript"])
    .default("javascript")
    .describe("Programming language (only 'javascript' supported)"),
});

function executeJavaScript(code: string): { result: unknown; logs: string[] } {
  const logs: string[] = [];

  const sandbox = createContext({
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => logs.push("[error] " + args.map(String).join(" ")),
      warn: (...args: unknown[]) => logs.push("[warn] " + args.map(String).join(" ")),
    },
    Math,
    JSON,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    String,
    Number,
    Boolean,
    Array,
    Object,
    // Explicitly omit: process, require, fs, Buffer, globalThis, global
  });

  const script = new Script(code, { filename: "sandbox" });
  const result = script.runInContext(sandbox, { timeout: TIMEOUT_MS });
  return { result, logs };
}

const codeExecuteSkill: SkillDefinition = {
  name: "code_execute",
  version: "1.0.0",

  manifest: {
    id: "code_execute",
    name: "Code Execute",
    description: "Executes JavaScript code in a sandboxed environment with no access to process, require, or file system.",
    category: "execute",
    tools: ["code_execute"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "code_execute",
      description: "Execute JavaScript code in a sandboxed environment. The code runs with no access to Node.js APIs (process, require, fs, etc.). Use console.log() for output.",
      parameters: CodeExecuteParams,

      async execute(params) {
        if (params.language !== "javascript") {
          return { error: `Unsupported language: ${params.language}. Only 'javascript' is supported.` };
        }

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              error: `Execution timed out after ${TIMEOUT_MS}ms`,
              logs: [],
            });
          }, TIMEOUT_MS);

          try {
            const { result, logs } = executeJavaScript(params.code);
            clearTimeout(timer);
            resolve({
              result: result !== undefined ? String(result) : undefined,
              logs,
              success: true,
            });
          } catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : String(err);
            resolve({
              error: `Execution failed: ${message}`,
              logs: [],
              success: false,
            });
          }
        });
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "code_execute",
      instructions: "You can execute JavaScript code using the `code_execute` tool. The code runs in a sandbox with no access to Node.js APIs. Use console.log() for output.",
    };
  },
};

export default codeExecuteSkill;
