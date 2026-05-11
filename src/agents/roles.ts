import type { AgentConfig } from "./types.js";
import { getOutputContract, formatContractForPrompt } from "./output-contracts.js";

// ── Role Cards ──────────────────────────────────────────────────────
// Typed templates for dynamically spawning specialized sub-agents.
// Each role card defines a system prompt, scoped tools, memory view,
// and depth limit. The swarm orchestrator instantiates agents from
// these cards at runtime.

export interface RoleCard {
  roleId: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];                    // allowed tool names
  memoryView: "full" | "readonly" | "none"; // access to user memory
  maxTokens: number;                  // output token budget
  temperature: number;
  maxDepth: number;                   // how deep this role can spawn children
  timeout: number;                    // max execution time in ms
  outputContract?: string;            // Feature 10: references an OutputContract ID
}

// ── Built-in Role Cards ─────────────────────────────────────────────

export const ROLE_CARDS: Record<string, RoleCard> = {
  researcher: {
    roleId: "researcher",
    name: "Researcher",
    description: "Gathers data from tools and memory, returns structured findings",
    systemPrompt: `You are a Research Agent in a swarm. Your job is to gather data and return structured findings.
- Use available tools to collect information
- Return your findings in a clear, structured format
- Do NOT make recommendations — just report facts
- Be concise and cite your sources`,
    tools: ["prop_lookup", "line_compare", "x_search", "memory_search"],
    memoryView: "readonly",
    maxTokens: 4096,
    temperature: 0.3,
    maxDepth: 1,
    timeout: 60_000,
    outputContract: "researcher",
  },

  analyst: {
    roleId: "analyst",
    name: "Analyst",
    description: "Performs quantitative analysis on provided data",
    systemPrompt: `You are an Analysis Agent in a swarm. Your job is to perform quantitative analysis.
- Analyze the data provided by the Research Agent
- Calculate probabilities, edges, and expected values
- Use Kelly criterion and portfolio optimization tools
- Show your work — explain the math
- Return structured analysis with confidence levels`,
    tools: ["kelly_criterion", "portfolio_optimizer", "model_inference", "memory_search"],
    memoryView: "readonly",
    maxTokens: 8192,
    temperature: 0.3,
    maxDepth: 1,
    timeout: 90_000,
    outputContract: "analyst",
  },

  writer: {
    roleId: "writer",
    name: "Writer",
    description: "Synthesizes research and analysis into user-facing content",
    systemPrompt: `You are a Writer Agent in a swarm. Your job is to synthesize findings into user-facing content.
- Take research findings and analysis results
- Write clear, actionable summaries
- Match the user's communication style from their profile
- Include key data points and confidence levels`,
    tools: ["memory_search"],
    memoryView: "readonly",
    maxTokens: 4096,
    temperature: 0.7,
    maxDepth: 1,
    timeout: 30_000,
    outputContract: "writer",
  },

  validator: {
    roleId: "validator",
    name: "Validator",
    description: "Cross-checks facts and validates analysis",
    systemPrompt: `You are a Validation Agent in a swarm. Your job is to cross-check and validate.
- Verify factual claims against available data
- Check mathematical calculations
- Flag inconsistencies or errors
- Return a validation report with pass/fail for each claim`,
    tools: ["prop_lookup", "x_search", "memory_search"],
    memoryView: "readonly",
    maxTokens: 2048,
    temperature: 0.2,
    maxDepth: 1,
    timeout: 45_000,
    outputContract: "validator",
  },

  mediator: {
    roleId: "mediator",
    name: "Mediator",
    description: "Resolves conflicts between agents via structured debate",
    systemPrompt: `You are a Mediator Agent. Two or more agents have produced conflicting outputs.
- Review each position objectively
- Identify the core disagreement
- Evaluate the evidence and reasoning for each position
- Produce a final resolution with justification
- If you cannot resolve, escalate with a clear summary of the impasse`,
    tools: ["memory_search"],
    memoryView: "readonly",
    maxTokens: 4096,
    temperature: 0.4,
    maxDepth: 1,
    timeout: 60_000,
  },
};

// ── Build AgentConfig from RoleCard ─────────────────────────────────
// Creates a temporary AgentConfig for a swarm sub-agent.

export function roleCardToConfig(
  role: RoleCard,
  baseConfig: AgentConfig,
): AgentConfig {
  // Feature 10: Append output contract format to system prompt
  let systemPrompt = role.systemPrompt;
  if (role.outputContract) {
    const contract = getOutputContract(role.outputContract);
    if (contract) {
      systemPrompt += "\n" + formatContractForPrompt(contract);
    }
  }

  return {
    id: baseConfig.id, // inherit parent's ID for audit
    displayName: role.name,
    tier: "internal",
    model: {
      ...baseConfig.model,
      maxOutputTokens: role.maxTokens,
      temperature: role.temperature,
    },
    systemPromptTemplate: systemPrompt,
    tools: {
      allow: role.tools,
      deny: [],
      maxToolCallsPerRound: 8,
    },
    skills: [],
    session: {
      dailyResetHour: 4,
      idleTimeoutMinutes: 5, // short-lived
      maxContextMessages: 20,
    },
    spawn: {
      enabled: role.maxDepth > 1,
      allowedTargets: [],
      maxDepth: role.maxDepth,
    },
    fileAccess: { restricted: true, allowedPaths: [] },
  };
}

export function getRoleCard(roleId: string): RoleCard | undefined {
  return ROLE_CARDS[roleId];
}

export function listRoleCards(): RoleCard[] {
  return Object.values(ROLE_CARDS);
}
