#!/usr/bin/env tsx
// ── Agent Config Validator CLI ─────────────────────────────────────
// Usage: npx tsx src/cli/validate-config.ts [path-to-astra.yml]
//
// Validates agent configs from astra.yml against the AgentConfig Zod
// schema and performs cross-reference checks for tools, skills, spawn
// targets, and session limits.

import { loadAstraConfig, seedAgentsFromConfig } from "../config/yaml-loader.js";
import { AgentConfig, type AgentConfig as AgentConfigType } from "../agents/types.js";
import { getRegisteredToolNames } from "../tools/registry.js";
import { getAllSkills } from "../skills/registry.js";

// ── ANSI Colors ─────────────────────────────────────────────────────

const ESC = "\x1b[";
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const R = `${ESC}0m`;

// ── Validation Result ───────────────────────────────────────────────

interface ValidationIssue {
  agentId: string;
  level: "error" | "warning";
  message: string;
}

// ── Valid Provider/Model Combinations ───────────────────────────────

const PROVIDER_MODEL_PREFIXES: Record<string, string[]> = {
  grok: ["grok-"],
  groq: ["llama", "mixtral", "gemma"],
  openai: ["gpt-", "o1", "o3", "chatgpt"],
  gemini: ["gemini-"],
  claude: ["claude-"],
  ollama: ["llama", "mistral", "phi", "codellama", "deepseek", "qwen"],
  openrouter: [], // accepts anything
  mistral: ["mistral-", "open-mistral", "codestral", "pixtral"],
  bedrock: ["anthropic.", "amazon.", "meta.", "cohere."],
  vllm: [], // accepts anything
};

// ── Session Sane Ranges ─────────────────────────────────────────────

const SESSION_WARNINGS: Record<string, { min: number; max: number; label: string }> = {
  idleTimeoutMinutes: { min: 5, max: 1440, label: "idle timeout" },
  maxContextMessages: { min: 5, max: 500, label: "max context messages" },
};

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args[0] ?? undefined;

  console.log(`${CYAN}${BOLD}Astra Config Validator${R}`);
  console.log(`${DIM}Loading config...${R}\n`);

  // Load the YAML file using the existing loader
  const config = await loadAstraConfig(configPath);

  if (!config) {
    console.error(`${RED}Error:${R} Could not load config file. Make sure astra.yml exists.`);
    process.exit(1);
  }

  if (!config.agents || typeof config.agents !== "object") {
    console.error(`${RED}Error:${R} No 'agents' section found in config`);
    process.exit(1);
  }

  // Build AgentConfig objects using the seeder (catches registration side effects)
  let agents: AgentConfigType[];
  try {
    agents = seedAgentsFromConfig(config);
  } catch (err) {
    console.error(`${RED}Error:${R} Failed to parse agent configs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (agents.length === 0) {
    console.log(`${YELLOW}Warning:${R} No agents found in config`);
    process.exit(0);
  }

  // Collect known tool names (best-effort — tools may not be loaded in CLI mode)
  let knownTools: string[] = [];
  try {
    knownTools = getRegisteredToolNames();
  } catch {
    // tools not loaded — skip tool validation
  }

  // Collect known skill IDs
  let knownSkills: string[] = [];
  try {
    knownSkills = [...getAllSkills().keys()];
  } catch {
    // skills not loaded — skip skill validation
  }

  const allAgentIds = new Set(agents.map((a) => a.id));
  const issues: ValidationIssue[] = [];

  // Validate each agent
  for (const parsed of agents) {
    const agentId = parsed.id;

    // 1. Schema re-validation (should always pass since seedAgentsFromConfig built them)
    const result = AgentConfig.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        issues.push({
          agentId,
          level: "error",
          message: `Schema validation: ${path} — ${issue.message}`,
        });
      }
      continue;
    }

    // 2. Check provider + model combination
    const prefixes = PROVIDER_MODEL_PREFIXES[parsed.model.provider];
    if (prefixes && prefixes.length > 0) {
      const modelId = parsed.model.modelId.toLowerCase();
      const matchesKnown = prefixes.some((p) => modelId.startsWith(p));
      if (!matchesKnown) {
        issues.push({
          agentId,
          level: "warning",
          message: `Model "${parsed.model.modelId}" is unusual for provider "${parsed.model.provider}" (expected prefix: ${prefixes.join(", ")})`,
        });
      }
    }

    // 3. Check tool references
    if (knownTools.length > 0) {
      for (const toolName of parsed.tools.allow) {
        if (toolName !== "*" && !knownTools.includes(toolName)) {
          issues.push({
            agentId,
            level: "warning",
            message: `Tool "${toolName}" in allow list not found in registry`,
          });
        }
      }
      for (const toolName of parsed.tools.deny) {
        if (!knownTools.includes(toolName)) {
          issues.push({
            agentId,
            level: "warning",
            message: `Tool "${toolName}" in deny list not found in registry`,
          });
        }
      }
    }

    // 4. Check skill references
    if (knownSkills.length > 0 && parsed.skills.length > 0) {
      for (const skillId of parsed.skills) {
        if (!knownSkills.includes(skillId)) {
          issues.push({
            agentId,
            level: "warning",
            message: `Skill "${skillId}" not found in skill registry`,
          });
        }
      }
    }

    // 5. Check spawn targets
    if (parsed.spawn.enabled && parsed.spawn.allowedTargets.length > 0) {
      for (const target of parsed.spawn.allowedTargets) {
        if (!allAgentIds.has(target)) {
          issues.push({
            agentId,
            level: "error",
            message: `Spawn target "${target}" does not reference a valid agent ID in this config`,
          });
        }
      }
    }

    // 6. Check handoff targets
    if (parsed.handoffTargets) {
      for (const target of parsed.handoffTargets) {
        if (!allAgentIds.has(target)) {
          issues.push({
            agentId,
            level: "warning",
            message: `Handoff target "${target}" does not reference a valid agent ID in this config`,
          });
        }
      }
    }

    // 7. Session config sanity checks
    for (const [key, range] of Object.entries(SESSION_WARNINGS)) {
      const value = parsed.session[key as keyof typeof parsed.session] as number;
      if (value < range.min) {
        issues.push({
          agentId,
          level: "warning",
          message: `Session ${range.label} (${value}) is below recommended minimum (${range.min})`,
        });
      }
      if (value > range.max) {
        issues.push({
          agentId,
          level: "warning",
          message: `Session ${range.label} (${value}) is above recommended maximum (${range.max})`,
        });
      }
    }

    // 8. Context window sanity check
    if (parsed.model.maxOutputTokens > parsed.model.maxContextTokens) {
      issues.push({
        agentId,
        level: "warning",
        message: `maxOutputTokens (${parsed.model.maxOutputTokens}) exceeds maxContextTokens (${parsed.model.maxContextTokens})`,
      });
    }

    // 9. Empty system prompt
    if (parsed.systemPromptTemplate.trim().length === 0) {
      issues.push({
        agentId,
        level: "warning",
        message: "systemPromptTemplate is empty",
      });
    }

    // If we got here with no issues for this agent, it's fully valid
    const agentIssues = issues.filter((i) => i.agentId === agentId);
    if (agentIssues.length === 0) {
      console.log(`  ${GREEN}ok${R} ${BOLD}${agentId}${R} — valid`);
    }
  }

  // Print issues grouped by agent
  const issuesByAgent = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = issuesByAgent.get(issue.agentId) ?? [];
    list.push(issue);
    issuesByAgent.set(issue.agentId, list);
  }

  for (const [agentId, agentIssues] of issuesByAgent) {
    const hasErrors = agentIssues.some((i) => i.level === "error");
    const icon = hasErrors ? `${RED}FAIL${R}` : `${YELLOW}WARN${R}`;
    console.log(`  ${icon} ${BOLD}${agentId}${R}`);

    for (const issue of agentIssues) {
      const color = issue.level === "error" ? RED : YELLOW;
      const label = issue.level === "error" ? "ERROR" : "WARN";
      console.log(`    ${color}[${label}]${R} ${issue.message}`);
    }
  }

  // Summary
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");

  console.log("");
  console.log(`${DIM}────────────────────────────────────────${R}`);
  console.log(`Agents: ${BOLD}${agents.length}${R}  Errors: ${errors.length > 0 ? RED : GREEN}${BOLD}${errors.length}${R}  Warnings: ${warnings.length > 0 ? YELLOW : GREEN}${BOLD}${warnings.length}${R}`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal:${R}`, err);
  process.exit(1);
});
