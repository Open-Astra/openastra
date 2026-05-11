// ── YAML Agent Config Loader ────────────────────────────────────────
// Loads agent team definitions from an astra.yml file. This is the
// Vagrant-style declarative approach: define your agent team in YAML,
// docker compose up, and everything spins up pre-configured.
//
// On startup, the gateway loads astra.yml, creates/updates agent
// configs in Postgres, and configures channel routing.
//
// No external YAML library needed — we parse the subset we use.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentConfig } from "../agents/types.js";
import { registerAgentConfig } from "./agents.js";
import { setDefaultAgentId } from "../channels/router.js";
import { createLogger } from "../utils/logger.js";
import { applyTransforms } from "./yaml-transforms.js";

const log = createLogger("yaml");

// ── YAML Types ─────────────────────────────────────────────────────

export interface AstraConfig {
  settings?: {
    defaultAgent?: string;
    defaultProvider?: string;
    defaultModel?: string;
  };
  workspace?: {
    name: string;
    owner?: string;
    members?: Array<{ userId: string; role: "admin" | "member" | "viewer" }>;
  };
  channels?: {
    telegram?: {
      enabled?: boolean;
      token?: string;
      userMap?: Record<string, string>;
    };
    imessage?: {
      enabled?: boolean;
      blueBubblesUrl?: string;
      blueBubblesPassword?: string;
    };
    whatsapp?: {
      enabled?: boolean;
      phoneNumberId?: string;
      accessToken?: string;
      verifyToken?: string;
    };
    signal?: {
      enabled?: boolean;
      apiUrl?: string;
      phoneNumber?: string;
    };
    discord?: {
      enabled?: boolean;
      token?: string;
    };
    slack?: {
      enabled?: boolean;
      botToken?: string;
      signingSecret?: string;
    };
    googleChat?: {
      enabled?: boolean;
      serviceAccountKey?: string;
    };
    teams?: {
      enabled?: boolean;
      appId?: string;
      appPassword?: string;
    };
    line?: {
      enabled?: boolean;
      channelAccessToken?: string;
      channelSecret?: string;
    };
    viber?: {
      enabled?: boolean;
      authToken?: string;
      botName?: string;
    };
    twitter?: {
      enabled?: boolean;
      apiKey?: string;
      apiSecret?: string;
      accessToken?: string;
      accessTokenSecret?: string;
      webhookEnv?: string;
    };
  };
  agents?: Record<string, YamlAgentDef>;
  heartbeats?: YamlHeartbeatDef[];
  mcpServers?: Array<
    | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { name: string; transport: "http" | "sse"; url: string; headers?: Record<string, string> }
  >;
}

interface YamlAgentDef {
  displayName: string;
  tier?: string;
  model?: {
    provider?: string;
    modelId?: string;
    endpoint?: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    temperature?: number;
    capabilities?: string[];
  };
  systemPrompt?: string;
  skills?: string[];
  tools?: {
    allow?: string[];
    deny?: string[];
    maxToolCallsPerRound?: number;
  };
  session?: {
    dailyResetHour?: number;
    idleTimeoutMinutes?: number;
    maxContextMessages?: number;
  };
  spawn?: {
    enabled?: boolean;
    allowedTargets?: string[];
    maxDepth?: number;
  };
  fileAccess?: {
    restricted?: boolean;
    allowedPaths?: string[];
  };
  schedule?: {
    cron: string;
    taskMessage: string;
    uid?: string;
  };
}

export interface YamlHeartbeatDef {
  name: string;
  agentId?: string;
  type: "rss" | "http" | "github";
  url?: string;
  repo?: string;
  intervalMinutes?: number;
  prompt?: string;
  expectedStatus?: number;
}

// ── Minimal YAML Parser ────────────────────────────────────────────
// Handles the subset of YAML we need: scalars, maps, arrays, multiline
// strings (|), env var interpolation (${VAR}).

function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  });
}

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Quoted strings — always return as string (preserves "123" as string)
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return interpolateEnvVars(trimmed.slice(1, -1));
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~" || trimmed === "") return null;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return interpolateEnvVars(trimmed);
}

// ── Inline Flow Syntax ──────────────────────────────────────────────
// Parses YAML flow sequences [a, b, c] and flow mappings {k: v, k2: v2}.
// Handles nesting: {allow: [$memory], deny: []}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseFlowValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseInlineArray(trimmed);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseInlineMap(trimmed);
  }
  return parseYamlValue(trimmed);
}

function parseInlineArray(raw: string): unknown[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  return splitFlowItems(inner).map((s) => parseFlowValue(s));
}

function parseInlineMap(raw: string): Record<string, unknown> {
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return {};
  const result: Record<string, unknown> = {};
  for (const pair of splitFlowItems(inner)) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const key = pair.slice(0, colonIdx).trim();
    const value = pair.slice(colonIdx + 1).trim();
    result[key] = parseFlowValue(value);
  }
  return result;
}

interface ParseContext {
  lines: string[];
  index: number;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1]!.length : 0;
}

function parseYamlBlock(ctx: ParseContext, minIndent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  while (ctx.index < ctx.lines.length) {
    const line = ctx.lines[ctx.index]!;

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      ctx.index++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < minIndent) break;

    const trimmed = line.trim();

    // Array item
    if (trimmed.startsWith("- ")) {
      break; // Let parent handle arrays
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      ctx.index++;
      continue;
    }

    let key = trimmed.slice(0, colonIdx).trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1);
    }
    const afterColon = trimmed.slice(colonIdx + 1).trim();
    ctx.index++;

    if (afterColon === "|") {
      // Multiline string
      let text = "";
      const blockIndent = ctx.index < ctx.lines.length ? getIndent(ctx.lines[ctx.index]!) : indent + 2;
      while (ctx.index < ctx.lines.length) {
        const nextLine = ctx.lines[ctx.index]!;
        if (nextLine.trim() === "") {
          text += "\n";
          ctx.index++;
          continue;
        }
        if (getIndent(nextLine) < blockIndent) break;
        text += nextLine.slice(blockIndent) + "\n";
        ctx.index++;
      }
      result[key] = interpolateEnvVars(text.trimEnd());
    } else if (afterColon === "") {
      // Nested map or array
      if (ctx.index < ctx.lines.length) {
        const nextLine = ctx.lines[ctx.index]!;
        const nextIndent = getIndent(nextLine);
        if (nextIndent > indent && nextLine.trim().startsWith("- ")) {
          // Array
          result[key] = parseYamlArray(ctx, nextIndent);
        } else if (nextIndent > indent) {
          // Nested map
          result[key] = parseYamlBlock(ctx, nextIndent);
        } else {
          result[key] = null;
        }
      }
    } else if (afterColon.startsWith("[") && afterColon.endsWith("]")) {
      // Inline flow array: [a, b, c]
      result[key] = parseInlineArray(afterColon);
    } else if (afterColon.startsWith("{") && afterColon.endsWith("}")) {
      // Inline flow map: {k: v, k2: v2}
      result[key] = parseInlineMap(afterColon);
    } else {
      result[key] = parseYamlValue(afterColon);
    }
  }

  return result;
}

function parseYamlArray(ctx: ParseContext, minIndent: number): unknown[] {
  const result: unknown[] = [];

  while (ctx.index < ctx.lines.length) {
    const line = ctx.lines[ctx.index]!;

    if (line.trim() === "" || line.trim().startsWith("#")) {
      ctx.index++;
      continue;
    }

    const indent = getIndent(line);
    if (indent < minIndent) break;

    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) break;

    const value = trimmed.slice(2).trim();
    ctx.index++;

    // Check if this array item has nested content
    if (value === "" && ctx.index < ctx.lines.length) {
      const nextIndent = getIndent(ctx.lines[ctx.index]!);
      if (nextIndent > indent) {
        result.push(parseYamlBlock(ctx, nextIndent));
        continue;
      }
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      result.push(parseInlineArray(value));
    } else if (value.startsWith("{") && value.endsWith("}")) {
      result.push(parseInlineMap(value));
    } else {
      result.push(parseYamlValue(value));
    }
  }

  return result;
}

function parseYaml(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const ctx: ParseContext = { lines, index: 0 };
  return parseYamlBlock(ctx, 0);
}

// ── Config Loading ─────────────────────────────────────────────────

export async function loadAstraConfig(
  configPath?: string,
): Promise<AstraConfig | null> {
  const path = configPath ?? process.env.ASTRA_CONFIG_PATH ?? join(process.cwd(), "astra.yml");

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return null; // File doesn't exist — that's fine
  }

  const raw = parseYaml(content) as Record<string, unknown>;
  const transformed = applyTransforms(raw, dirname(path));
  return transformed as unknown as AstraConfig;
}

// ── Agent Seeding ──────────────────────────────────────────────────
// Converts YAML agent definitions to AgentConfig objects and registers
// them in the runtime. Optionally persists to Postgres.

export function seedAgentsFromConfig(
  config: AstraConfig,
): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const defaults = config.settings ?? {};

  if (!config.agents) return agents;

  for (const [id, def] of Object.entries(config.agents)) {
    const agentConfig: AgentConfig = {
      id,
      displayName: def.displayName ?? id,
      tier: (def.tier ?? "internal") as AgentConfig["tier"],
      model: {
        provider: (def.model?.provider ?? defaults.defaultProvider ?? "claude") as AgentConfig["model"]["provider"],
        modelId: def.model?.modelId ?? defaults.defaultModel ?? "claude-sonnet-4-6",
        ...(def.model?.endpoint ? { endpoint: def.model.endpoint } : {}),
        maxContextTokens: def.model?.maxContextTokens ?? 200_000,
        maxOutputTokens: def.model?.maxOutputTokens ?? 8192,
        temperature: def.model?.temperature ?? 0.7,
        ...(def.model?.capabilities ? { capabilities: def.model.capabilities as AgentConfig["model"]["capabilities"] } : {}),
      },
      systemPromptTemplate: def.systemPrompt ?? "You are a helpful AI assistant.",
      tools: {
        allow: def.tools?.allow ?? [],
        deny: def.tools?.deny ?? [],
        maxToolCallsPerRound: def.tools?.maxToolCallsPerRound ?? 8,
      },
      skills: def.skills ?? [],
      session: {
        dailyResetHour: def.session?.dailyResetHour ?? 4,
        idleTimeoutMinutes: def.session?.idleTimeoutMinutes ?? 120,
        maxContextMessages: def.session?.maxContextMessages ?? 50,
      },
      spawn: {
        enabled: def.spawn?.enabled ?? false,
        allowedTargets: def.spawn?.allowedTargets ?? [],
        maxDepth: def.spawn?.maxDepth ?? 2,
      },
      fileAccess: {
        restricted: def.fileAccess?.restricted ?? true,
        allowedPaths: def.fileAccess?.allowedPaths ?? [],
      },
      ...(def.schedule ? {
        schedule: {
          cron: def.schedule.cron,
          taskMessage: def.schedule.taskMessage,
          ...(def.schedule.uid ? { uid: def.schedule.uid } : {}),
        },
      } : {}),
    };

    registerAgentConfig(id, agentConfig);
    agents.push(agentConfig);
    log.active(`${id}`, `${agentConfig.model.provider}/${agentConfig.model.modelId}`);
  }

  // Set default agent for channels
  if (defaults.defaultAgent) {
    setDefaultAgentId(defaults.defaultAgent);
    log.kv("Default agent", defaults.defaultAgent);
  }

  return agents;
}

// ── Workspace Seeding ─────────────────────────────────────────────
// Creates a workspace from the YAML config if one doesn't already
// exist with that name. Idempotent — safe to call on every startup.

export async function seedWorkspaceFromConfig(
  config: AstraConfig,
): Promise<string | null> {
  if (!config.workspace?.name) return null;

  const { getPool } = await import("./postgres.js");
  const pool = getPool();

  // Check if workspace with this name already exists
  const { rows: existing } = await pool.query<{ id: string }>(
    "SELECT id FROM workspaces WHERE name = $1 LIMIT 1",
    [config.workspace.name],
  );

  if (existing.length > 0) {
    const wsId = existing[0]!.id;
    log.kv("Workspace exists", `${config.workspace.name} (${wsId})`);
    return wsId;
  }

  // Create workspace
  const { createWorkspace, addMember } = await import("../workspaces/store.js");
  const ownerId = config.workspace.owner ?? "system";

  const ws = await createWorkspace(ownerId, config.workspace.name, "team");
  log.active("Workspace created", `${config.workspace.name} (${ws.id})`);

  // Add members if configured
  if (config.workspace.members) {
    for (const member of config.workspace.members) {
      await addMember(ws.id, member.userId, member.role, ownerId);
      log.kv("Member added", `${member.userId} (${member.role})`);
    }
  }

  return ws.id;
}

// ── Heartbeat Seeding ─────────────────────────────────────────────
// Upserts heartbeat configs from YAML by name — idempotent on restart.

export async function seedHeartbeatsFromConfig(
  config: AstraConfig,
  workspaceId: string | null,
): Promise<void> {
  if (!config.heartbeats?.length) return;

  const { getPool } = await import("./postgres.js");
  const pool = getPool();

  for (const def of config.heartbeats) {
    const extraConfig: Record<string, unknown> = {};
    if (def.repo) extraConfig.repo = def.repo;
    if (def.expectedStatus) extraConfig.expectedStatus = def.expectedStatus;

    // Upsert by name + workspace_id
    const { rows: existing } = await pool.query(
      `SELECT id FROM heartbeat_configs WHERE name = $1 AND (workspace_id = $2 OR ($2::uuid IS NULL AND workspace_id IS NULL)) LIMIT 1`,
      [def.name, workspaceId],
    );

    if (existing.length === 0) {
      await pool.query(
        `INSERT INTO heartbeat_configs
           (name, workspace_id, agent_id, type, url, config, interval_minutes, prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          def.name,
          workspaceId,
          def.agentId ?? "default",
          def.type,
          def.url ?? null,
          JSON.stringify(extraConfig),
          def.intervalMinutes ?? 30,
          def.prompt ?? null,
        ],
      );
      log.dim(`Heartbeat seeded: ${def.name}`);
    }
  }
}
