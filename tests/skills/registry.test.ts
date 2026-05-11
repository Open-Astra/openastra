import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The skills registry and loader modules use module-level Maps.
// We import them directly (no DB dependencies) but need to clean up
// between tests using registerSkill / unregisterSkill-equivalent patterns.

// Mock tools/registry so getTool doesn't require full setup
vi.mock("../../src/tools/registry.js", () => ({
  getTool: vi.fn().mockReturnValue(undefined),
  registerTool: vi.fn(),
  getRegisteredToolNames: vi.fn().mockReturnValue([]),
}));

// Mock node:fs/promises so discoverSkills won't hit real filesystem
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => false }),
}));

vi.mock("../../src/utils/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { readdir, stat } from "node:fs/promises";
import {
  registerSkill,
  getSkill,
  getAllSkills,
  getSkillToolNames,
  getSkillPromptContext,
  getSkillManifests,
  getSkillForTool,
} from "../../src/skills/registry.js";
import { discoverSkills, initSkills } from "../../src/skills/loader.js";
import type { SkillDefinition, SkillContext } from "../../src/skills/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSkill(id: string, tools: string[], promptInstructions?: string): SkillDefinition {
  return {
    name: `skill-${id}`,
    version: "1.0.0",
    manifest: {
      id,
      name: `Skill ${id}`,
      description: `Test skill ${id}`,
      category: "analyze",
      tools,
      configFields: [],
      version: "1.0.0",
    },
    init: vi.fn().mockResolvedValue(undefined),
    ...(promptInstructions
      ? {
          getPromptContext: () => ({
            skillId: id,
            instructions: promptInstructions,
          }),
        }
      : {}),
  };
}

// Minimal SkillContext
const testCtx: SkillContext = {
  app: {} as never,
  resolveClient: vi.fn() as never,
  getEventBus: vi.fn() as never,
  registerTool: vi.fn() as never,
  registerAgentConfig: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() },
};

// Track registered IDs so we can clean up after each test
const registeredIds: string[] = [];

function registerTestSkill(skill: SkillDefinition): void {
  registerSkill(skill);
  registeredIds.push(skill.manifest.id);
}

afterEach(() => {
  // Remove all test-registered skills from the module-level Map
  const allSkills = getAllSkills();
  for (const id of registeredIds) {
    allSkills.delete(id);
  }
  registeredIds.length = 0;
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("registerSkill / getSkill", () => {
  it("registers a skill and retrieves it by ID", () => {
    const skill = makeSkill("reg-test-1", ["tool-a", "tool-b"]);
    registerTestSkill(skill);

    expect(getSkill("reg-test-1")).toBeDefined();
    expect(getSkill("reg-test-1")!.manifest.id).toBe("reg-test-1");
  });

  it("returns undefined for an unknown skill ID", () => {
    expect(getSkill("non-existent-skill-xyz")).toBeUndefined();
  });
});

describe("getSkillToolNames", () => {
  it("returns tool names for a single registered skill", () => {
    const skill = makeSkill("tools-test-1", ["search", "summarize"]);
    registerTestSkill(skill);

    const tools = getSkillToolNames(["tools-test-1"]);
    expect(tools).toContain("search");
    expect(tools).toContain("summarize");
  });

  it("returns empty array for unknown skill ID", () => {
    const tools = getSkillToolNames(["unknown-skill-abc"]);
    expect(tools).toEqual([]);
  });

  it("merges tools from multiple skills without duplicates", () => {
    const skillA = makeSkill("merge-a", ["tool-x", "tool-y"]);
    const skillB = makeSkill("merge-b", ["tool-y", "tool-z"]); // tool-y is shared
    registerTestSkill(skillA);
    registerTestSkill(skillB);

    const tools = getSkillToolNames(["merge-a", "merge-b"]);
    expect(tools).toContain("tool-x");
    expect(tools).toContain("tool-y");
    expect(tools).toContain("tool-z");
    // Deduplication: tool-y should appear only once
    expect(tools.filter((t) => t === "tool-y")).toHaveLength(1);
  });

  it("includes tools from composed skills", () => {
    const baseSkill = makeSkill("compose-base", ["base-tool"]);
    const composingSkill = makeSkill("compose-main", ["main-tool"]);
    composingSkill.manifest.composes = ["compose-base"];

    registerTestSkill(baseSkill);
    registerTestSkill(composingSkill);

    const tools = getSkillToolNames(["compose-main"]);
    expect(tools).toContain("main-tool");
    expect(tools).toContain("base-tool");
  });
});

describe("getSkillPromptContext", () => {
  it("returns empty string when skill has no getPromptContext", () => {
    const skill = makeSkill("no-ctx-1", ["tool-1"]);
    // No promptInstructions → no getPromptContext
    registerTestSkill(skill);

    const ctx = getSkillPromptContext(["no-ctx-1"]);
    expect(ctx).toBe("");
  });

  it("builds prompt context string from skill instructions", () => {
    const skill = makeSkill("ctx-test-1", ["tool-a"], "Use this skill to search documents.");
    registerTestSkill(skill);

    const ctx = getSkillPromptContext(["ctx-test-1"]);
    expect(ctx).toContain("Use this skill to search documents.");
    expect(ctx).not.toContain("## Available Skills");
  });

  it("returns empty string for unknown skill ID", () => {
    const ctx = getSkillPromptContext(["totally-unknown-skill-xyz"]);
    expect(ctx).toBe("");
  });

  it("combines context from multiple skills", () => {
    const skillA = makeSkill("multi-ctx-a", ["t1"], "Skill A instructions.");
    const skillB = makeSkill("multi-ctx-b", ["t2"], "Skill B instructions.");
    registerTestSkill(skillA);
    registerTestSkill(skillB);

    const ctx = getSkillPromptContext(["multi-ctx-a", "multi-ctx-b"]);
    expect(ctx).toContain("Skill A instructions.");
    expect(ctx).toContain("Skill B instructions.");
  });
});

describe("getSkillManifests", () => {
  it("returns manifests for all registered skills", () => {
    const skillA = makeSkill("manifest-a", ["tool-m"]);
    const skillB = makeSkill("manifest-b", ["tool-n"]);
    registerTestSkill(skillA);
    registerTestSkill(skillB);

    const manifests = getSkillManifests();
    const ids = manifests.map((m) => m.id);
    expect(ids).toContain("manifest-a");
    expect(ids).toContain("manifest-b");
  });
});

describe("getSkillForTool", () => {
  it("returns skill ID for a tool owned by that skill", () => {
    const skill = makeSkill("owner-skill", ["owned-tool-xyz"]);
    registerTestSkill(skill);

    expect(getSkillForTool("owned-tool-xyz")).toBe("owner-skill");
  });

  it("returns null for a tool not owned by any skill", () => {
    expect(getSkillForTool("orphan-tool-that-nobody-owns")).toBeNull();
  });
});

describe("discoverSkills", () => {
  it("returns empty array when directory does not exist", async () => {
    (readdir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("ENOENT"));

    const discovered = await discoverSkills("/non/existent/path");
    expect(discovered).toEqual([]);
  });

  it("returns empty array when directory has no subdirectories", async () => {
    (readdir as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["file.ts"]);
    (stat as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ isDirectory: () => false });

    const discovered = await discoverSkills("/skills/dir");
    expect(discovered).toEqual([]);
  });
});

describe("initSkills", () => {
  it("calls init() on each discovered skill and registers it", async () => {
    const skill = makeSkill("init-test-skill", ["t1"]);
    registeredIds.push("init-test-skill"); // track for cleanup

    await initSkills([skill], testCtx);

    expect(skill.init).toHaveBeenCalledWith(testCtx);
    expect(getSkill("init-test-skill")).toBeDefined();
  });

  it("continues initializing remaining skills when one fails", async () => {
    const failingSkill = makeSkill("init-fail", ["t-fail"]);
    (failingSkill.init as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("init failed"));

    const goodSkill = makeSkill("init-good", ["t-good"]);
    registeredIds.push("init-good");

    await initSkills([failingSkill, goodSkill], testCtx);

    // failingSkill should NOT be in registry (init failed before registerSkill)
    expect(getSkill("init-fail")).toBeUndefined();
    // goodSkill should be registered
    expect(getSkill("init-good")).toBeDefined();
  });
});
