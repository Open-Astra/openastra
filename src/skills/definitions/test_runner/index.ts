import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";

// ── Test Runner Skill ──────────────────────────────────────────────
// Auto-detect test frameworks, run tests, and generate test templates.

const MAX_OUTPUT = 5000;

const RunTestsParams = z.object({
  repoPath: z
    .string()
    .optional()
    .describe("Repository path (default: cwd)"),
  framework: z
    .string()
    .optional()
    .describe("Test framework override (npm, pytest, go, cargo)"),
  filter: z
    .string()
    .optional()
    .describe("Test filter pattern (grep, -k, -run, etc.)"),
});

const GenerateTestParams = z.object({
  filePath: z.string().describe("Path to the source file to generate tests for"),
  repoPath: z
    .string()
    .optional()
    .describe("Repository path (default: cwd)"),
});

type DetectedFramework = "npm" | "pytest" | "go" | "cargo" | "unknown";

function detectFramework(repoPath: string): DetectedFramework {
  if (existsSync(join(repoPath, "Cargo.toml"))) return "cargo";
  if (existsSync(join(repoPath, "go.mod"))) return "go";
  if (
    existsSync(join(repoPath, "pytest.ini")) ||
    existsSync(join(repoPath, "setup.cfg")) ||
    existsSync(join(repoPath, "pyproject.toml"))
  ) {
    return "pytest";
  }
  if (existsSync(join(repoPath, "package.json"))) return "npm";
  return "unknown";
}

interface TestCommand {
  bin: string;
  args: string[];
}

function buildTestCommand(
  framework: DetectedFramework,
  filter?: string,
): TestCommand {
  switch (framework) {
    case "npm":
      return filter
        ? { bin: "npm", args: ["test", "--", "--grep", filter] }
        : { bin: "npm", args: ["test"] };
    case "pytest":
      return filter
        ? { bin: "python", args: ["-m", "pytest", "-k", filter, "-v"] }
        : { bin: "python", args: ["-m", "pytest", "-v"] };
    case "go":
      return filter
        ? { bin: "go", args: ["test", "./...", "-run", filter, "-v"] }
        : { bin: "go", args: ["test", "./...", "-v"] };
    case "cargo":
      return filter
        ? { bin: "cargo", args: ["test", filter, "--", "--nocapture"] }
        : { bin: "cargo", args: ["test"] };
    default:
      return { bin: "echo", args: ["No test framework detected"] };
  }
}

function parseTestOutput(
  output: string,
  framework: DetectedFramework,
): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  switch (framework) {
    case "npm": {
      // Jest/Vitest/Mocha patterns
      const passMatch = output.match(/(\d+)\s+pass(?:ing|ed)/i);
      const failMatch = output.match(/(\d+)\s+fail(?:ing|ed|ure)/i);
      const skipMatch = output.match(/(\d+)\s+(?:skip|pending|todo)/i);
      if (passMatch) passed = parseInt(passMatch[1], 10);
      if (failMatch) failed = parseInt(failMatch[1], 10);
      if (skipMatch) skipped = parseInt(skipMatch[1], 10);

      // Jest summary: Tests: X passed, Y failed, Z total
      const jestSummary = output.match(
        /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/i,
      );
      if (jestSummary) {
        failed = parseInt(jestSummary[1] ?? "0", 10);
        skipped = parseInt(jestSummary[2] ?? "0", 10);
        passed = parseInt(jestSummary[3] ?? "0", 10);
      }
      break;
    }
    case "pytest": {
      // pytest: 5 passed, 2 failed, 1 skipped
      const pytestMatch = output.match(
        /(\d+)\s+passed|(\d+)\s+failed|(\d+)\s+skipped/g,
      );
      if (pytestMatch) {
        for (const m of pytestMatch) {
          const num = parseInt(m, 10);
          if (m.includes("passed")) passed = num;
          if (m.includes("failed")) failed = num;
          if (m.includes("skipped")) skipped = num;
        }
      }
      break;
    }
    case "go": {
      // Go: ok/FAIL per package, individual --- PASS/FAIL
      const passMatches = output.match(/--- PASS/g);
      const failMatches = output.match(/--- FAIL/g);
      const skipMatches = output.match(/--- SKIP/g);
      passed = passMatches?.length ?? 0;
      failed = failMatches?.length ?? 0;
      skipped = skipMatches?.length ?? 0;
      break;
    }
    case "cargo": {
      // Rust: test result: ok. X passed; Y failed; Z ignored
      const cargoMatch = output.match(
        /test result:.*?(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/,
      );
      if (cargoMatch) {
        passed = parseInt(cargoMatch[1], 10);
        failed = parseInt(cargoMatch[2], 10);
        skipped = parseInt(cargoMatch[3], 10);
      }
      break;
    }
  }

  return { passed, failed, skipped };
}

function extractExportedFunctions(content: string, ext: string): string[] {
  const functions: string[] = [];

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const re =
      /export\s+(?:async\s+)?(?:function)\s+(\w+)|export\s+(?:const|let)\s+(\w+)\s*=/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1] ?? match[2];
      if (name) functions.push(name);
    }
    // Also match default export class/function
    const defaultMatch = content.match(
      /export\s+default\s+(?:class|function)\s+(\w+)/,
    );
    if (defaultMatch?.[1]) functions.push(defaultMatch[1]);
  } else if (ext === ".py") {
    const re = /^def\s+(\w+)\s*\(/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith("_")) functions.push(match[1]);
    }
  }

  return functions;
}

function generateTsTestTemplate(
  filePath: string,
  functions: string[],
): string {
  const relImport = `./${basename(filePath, extname(filePath))}`;
  const imports =
    functions.length > 0
      ? `import { ${functions.join(", ")} } from "${relImport}";`
      : `// import { } from "${relImport}";`;

  const blocks = functions.map(
    (fn) => `  it("should handle ${fn} correctly", () => {
    // Arrange
    // const input = ...;

    // Act
    // const result = ${fn}(input);

    // Assert
    // expect(result).toBeDefined();
  });`,
  );

  return `${imports}

describe("${basename(filePath, extname(filePath))}", () => {
${blocks.length > 0 ? blocks.join("\n\n") : `  it("should work", () => {\n    // TODO: implement test\n  });`}
});
`;
}

function generatePyTestTemplate(
  filePath: string,
  functions: string[],
): string {
  const moduleName = basename(filePath, ".py");
  const imports =
    functions.length > 0
      ? `from ${moduleName} import ${functions.join(", ")}`
      : `# from ${moduleName} import ...`;

  const blocks = functions.map(
    (fn) => `
def test_${fn}():
    """Test ${fn} function."""
    # Arrange
    # input_data = ...

    # Act
    # result = ${fn}(input_data)

    # Assert
    # assert result is not None`,
  );

  return `${imports}

${blocks.length > 0 ? blocks.join("\n") : `\ndef test_placeholder():\n    """TODO: implement test."""\n    pass`}
`;
}

function deriveTestFilePath(filePath: string): string {
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  const dir = dirname(filePath);

  if (ext === ".py") {
    return join(dir, `test_${base}.py`);
  }
  // TS/JS: file.test.ts or file.spec.ts
  return join(dir, `${base}.test${ext}`);
}

const testRunnerSkill: SkillDefinition = {
  name: "test_runner",
  version: "1.0.0",

  manifest: {
    id: "test_runner",
    name: "Test Runner",
    description:
      "Auto-detect and run test suites, parse results, and generate test templates for source files.",
    category: "execute",
    tools: ["run_tests", "generate_test"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "run_tests",
      description:
        "Auto-detect the test framework and run tests. Supports npm (Jest/Vitest/Mocha), pytest, go test, and cargo test.",
      parameters: RunTestsParams,

      async execute(params) {
        const repoPath = params.repoPath ?? process.cwd();
        const framework: DetectedFramework = (params.framework as DetectedFramework) ?? detectFramework(repoPath);

        if (framework === "unknown") {
          return {
            framework: "unknown",
            passed: 0,
            failed: 0,
            skipped: 0,
            output: "No test framework detected. Checked for: package.json, pytest.ini, setup.cfg, pyproject.toml, go.mod, Cargo.toml",
          };
        }

        const cmd = buildTestCommand(framework, params.filter);

        let output: string;
        let exitedClean = true;
        try {
          output = execFileSync(cmd.bin, cmd.args, {
            cwd: repoPath,
            encoding: "utf-8",
            timeout: 120_000,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err) {
          exitedClean = false;
          // Test failures cause non-zero exit — capture output from the error
          if (err && typeof err === "object" && "stdout" in err) {
            const execErr = err as { stdout?: string; stderr?: string };
            output = (execErr.stdout ?? "") + "\n" + (execErr.stderr ?? "");
          } else {
            output = err instanceof Error ? err.message : String(err);
          }
        }

        const truncated = output.slice(0, MAX_OUTPUT);
        const counts = parseTestOutput(truncated, framework);

        return {
          framework,
          ...counts,
          exitedClean,
          output: truncated,
        };
      },
    });

    ctx.registerTool({
      name: "generate_test",
      description:
        "Generate a test file template for a source file. Reads the file, extracts exported functions, and produces a skeleton test. Does NOT write the file — returns the template for review.",
      parameters: GenerateTestParams,

      async execute(params) {
        const repoPath = params.repoPath ?? process.cwd();
        const fullPath = join(repoPath, params.filePath);
        const ext = extname(fullPath).toLowerCase();

        let content: string;
        try {
          content = readFileSync(fullPath, "utf-8");
        } catch (err) {
          return {
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const functions = extractExportedFunctions(content, ext);
        const testFilePath = deriveTestFilePath(params.filePath);

        let template: string;
        if (ext === ".py") {
          template = generatePyTestTemplate(params.filePath, functions);
        } else if (
          ext === ".ts" ||
          ext === ".tsx" ||
          ext === ".js" ||
          ext === ".jsx"
        ) {
          template = generateTsTestTemplate(params.filePath, functions);
        } else {
          return {
            error: `Unsupported file extension: ${ext}. Supported: .ts, .tsx, .js, .jsx, .py`,
          };
        }

        return {
          testFilePath,
          sourceFile: params.filePath,
          detectedFunctions: functions,
          template,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "test_runner",
      instructions:
        "You can run tests with `run_tests` (auto-detects npm/pytest/go/cargo, parses pass/fail/skip counts) and generate test templates with `generate_test` (reads a source file and produces a skeleton test file). The template is returned as a string for review before writing.",
    };
  },
};

export default testRunnerSkill;
