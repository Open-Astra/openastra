import { getPool } from "../config/postgres.js";
import { getTool, getRegisteredToolNames } from "./registry.js";
import { zodToJsonSchema } from "./schema.js";
import { createLogger } from "../utils/logger.js";
import type { ToolContext } from "./types.js";
import type { ToolCall } from "./types.js";
import { executeTool } from "./registry.js";
import { randomUUID } from "node:crypto";

const logger = createLogger("tool-composer");

// ── Type Definitions ────────────────────────────────────────────────

export interface CompositionCompatibility {
  compatible: boolean;
  score: number; // 0-1
  inputMapping: Record<string, string>; // source field -> target field
}

export interface ChainResult {
  results: Array<{ toolName: string; result: unknown; error?: string }>;
  finalOutput: unknown;
  chainedTools: string[];
  errors: string[];
  totalDuration: number;
}

export interface CompositionIssue {
  type: "cycle" | "missing_tool" | "incompatible" | "unknown";
  message: string;
}

// ── Cache for auto-discovered chains (5-min TTL) ───────────────────

const chainCache = new Map<string, { data: CompositionCompatibility; expires: number }>();

function getCachedChain(key: string): CompositionCompatibility | null {
  const cached = chainCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }
  chainCache.delete(key);
  return null;
}

function setCachedChain(key: string, data: CompositionCompatibility): void {
  chainCache.set(key, { data, expires: Date.now() + 5 * 60 * 1000 });
}

// ── Auto-Discover Tool Composition ──────────────────────────────────
// Analyze tool I/O signatures to determine compatibility

export async function autoDiscoverComposition(
  sourceToolName: string,
  targetToolName: string,
): Promise<CompositionCompatibility> {
  const cacheKey = `${sourceToolName}:${targetToolName}`;
  const cached = getCachedChain(cacheKey);
  if (cached) return cached;

  // Check database for previously discovered composition
  const pool = getPool();
  const existing = await pool.query<{
    compatible: boolean;
    compatibility_score: string;
    input_mapping: Record<string, string>;
  }>(
    `SELECT compatible, compatibility_score, input_mapping
     FROM tool_auto_chains
     WHERE source_tool = $1 AND target_tool = $2`,
    [sourceToolName, targetToolName],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const result: CompositionCompatibility = {
      compatible: row.compatible,
      score: parseFloat(row.compatibility_score.toString()),
      inputMapping: row.input_mapping || {},
    };
    setCachedChain(cacheKey, result);
    return result;
  }

  // Discover anew
  const source = getTool(sourceToolName);
  const target = getTool(targetToolName);

  if (!source || !target) {
    const result: CompositionCompatibility = { compatible: false, score: 0, inputMapping: {} };
    setCachedChain(cacheKey, result);
    return result;
  }

  try {
    const sourceSchema = zodToJsonSchema(source.parameters);
    const targetSchema = zodToJsonSchema(target.parameters);

    const sourceProps = sourceSchema.properties as Record<string, { type?: string; description?: string }> || {};
    const targetProps = targetSchema.properties as Record<string, { type?: string; description?: string }> || {};
    const targetRequired = (targetSchema.required as string[]) || [];

    const inputMapping: Record<string, string> = {};
    let matchedCount = 0;

    // Try to map source output -> target input
    for (const [targetField, targetProp] of Object.entries(targetProps)) {
      for (const [sourceField, sourceProp] of Object.entries(sourceProps)) {
        // Simple matching: same name or compatible type
        if (sourceField === targetField || sourceProp.type === targetProp.type) {
          inputMapping[sourceField] = targetField;
          matchedCount++;
          break;
        }
      }
    }

    // Score: % of required target fields that have mappings
    const requiredCount = targetRequired.length;
    const score = requiredCount > 0 ? Math.min(matchedCount / requiredCount, 1) : 0.5;
    const compatible = score > 0.3;

    const result: CompositionCompatibility = {
      compatible,
      score: Math.round(score * 100) / 100,
      inputMapping,
    };

    // Persist discovery
    await pool.query(
      `INSERT INTO tool_auto_chains (source_tool, target_tool, compatible, compatibility_score, input_mapping)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_tool, target_tool) DO UPDATE SET
         compatible = EXCLUDED.compatible,
         compatibility_score = EXCLUDED.compatibility_score,
         input_mapping = EXCLUDED.input_mapping,
         discovered_at = NOW()`,
      [sourceToolName, targetToolName, compatible, score, JSON.stringify(inputMapping)],
    );

    setCachedChain(cacheKey, result);
    return result;
  } catch (err) {
    logger.warn(`Failed to discover composition ${sourceToolName} -> ${targetToolName}`, err);
    return { compatible: false, score: 0, inputMapping: {} };
  }
}

// ── Chain Tool Execution ────────────────────────────────────────────
// Execute tools in topological order, passing output to input

export async function chainToolExecution(
  tools: Array<[string, Record<string, unknown>]>,
  context: ToolContext,
  allowedTools: Set<string>,
): Promise<ChainResult> {
  const startMs = Date.now();
  const results: Array<{ toolName: string; result: unknown; error?: string }> = [];
  const errors: string[] = [];
  const chainedTools: string[] = [];

  let currentOutput: unknown = null;

  for (let i = 0; i < tools.length; i++) {
    const [toolName, baseParams] = tools[i];
    chainedTools.push(toolName);

    // Check allowed
    if (!allowedTools.has(toolName)) {
      const err = `Tool "${toolName}" not allowed in chain`;
      errors.push(err);
      results.push({ toolName, result: null, error: err });
      break;
    }

    // Map previous output to this tool's input
    let params = baseParams;
    if (i > 0 && currentOutput) {
      const prevTool = tools[i - 1][0];
      const composition = await autoDiscoverComposition(prevTool, toolName);
      if (composition.compatible && Object.keys(composition.inputMapping).length > 0) {
        params = mapOutput(currentOutput, composition.inputMapping, baseParams);
      }
    }

    try {
      // Build ToolCall for executeTool
      const toolCall: ToolCall = {
        id: randomUUID(),
        name: toolName,
        arguments: JSON.stringify(params),
      };

      const result = await executeTool(toolCall, context, allowedTools);

      if (result.error) {
        errors.push(`Tool "${toolName}": ${result.error}`);
        results.push({ toolName, result: null, error: result.error });
        // On error, decide whether to continue or stop based on tool policy
        // For now, stop on first error
        break;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        parsed = result.content;
      }

      currentOutput = parsed;
      results.push({ toolName, result: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      results.push({ toolName, result: null, error: msg });
      break;
    }
  }

  const totalDuration = Date.now() - startMs;

  return {
    results,
    finalOutput: currentOutput,
    chainedTools,
    errors,
    totalDuration,
  };
}

// ── Validate Composition Chain ──────────────────────────────────────

export async function validateCompositionChain(chain: string[]): Promise<{ valid: boolean; issues: CompositionIssue[] }> {
  const issues: CompositionIssue[] = [];
  const toolNames = getRegisteredToolNames();

  // Check for missing tools
  for (const toolName of chain) {
    if (!toolNames.includes(toolName)) {
      issues.push({ type: "missing_tool", message: `Tool not registered: ${toolName}` });
    }
  }

  // Check for cycles (simple: no duplicates in linear chain, but check dependency graph)
  const seen = new Set<string>();
  for (const toolName of chain) {
    if (seen.has(toolName)) {
      issues.push({ type: "cycle", message: `Tool appears multiple times in chain: ${toolName}` });
    }
    seen.add(toolName);
  }

  // Check I/O compatibility between consecutive tools
  for (let i = 0; i < chain.length - 1; i++) {
    const source = chain[i];
    const target = chain[i + 1];
    const compat = await autoDiscoverComposition(source, target);

    if (!compat.compatible && compat.score < 0.3) {
      issues.push({
        type: "incompatible",
        message: `Low compatibility (score ${compat.score}) between "${source}" and "${target}"`,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ── Helper: Map Output to Input ─────────────────────────────────────

function mapOutput(output: unknown, mapping: Record<string, string>, baseParams: Record<string, unknown>): Record<string, unknown> {
  const result = { ...baseParams };

  if (typeof output !== "object" || output === null) {
    return result;
  }

  const outputObj = output as Record<string, unknown>;

  for (const [sourceField, targetField] of Object.entries(mapping)) {
    if (sourceField in outputObj) {
      result[targetField] = outputObj[sourceField];
    }
  }

  return result;
}

// ── Log Chain Execution ─────────────────────────────────────────────

export async function logChainExecution(
  sessionId: string,
  agentId: string,
  uid: string,
  chain: string[],
  result: ChainResult,
  workspaceId?: string,
): Promise<void> {
  try {
    const pool = getPool();
    const status = result.errors.length === 0 ? "success" : result.results.length > 0 ? "partial" : "failed";

    await pool.query(
      `INSERT INTO tool_chain_executions
       (workspace_id, session_id, agent_id, uid, chain, status, total_duration_ms, results, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        workspaceId ?? null,
        sessionId,
        agentId,
        uid,
        chain,
        status,
        result.totalDuration,
        JSON.stringify(result.results),
      ],
    );
  } catch (err) {
    logger.warn(`Failed to log chain execution`, err);
  }
}
