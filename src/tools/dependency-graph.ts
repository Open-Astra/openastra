import { getRegisteredToolNames, getTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

export interface ToolNode {
  name: string;
  dependsOn: string[];
}

export interface ToolDependencyGraph {
  nodes: ToolNode[];
  cycles: string[][];
}

// Cache for auto-discovered chains (5-min TTL)
const graphCache = { data: null as ToolDependencyGraph | null, expires: 0 };

export async function buildToolDependencyGraph(): Promise<ToolDependencyGraph> {
  // Check cache
  if (graphCache.data && graphCache.expires > Date.now()) {
    return graphCache.data;
  }

  const names = getRegisteredToolNames();
  const nodes: ToolNode[] = [];

  // Build adjacency list from tool.dependsOn
  for (const name of names) {
    const def = getTool(name);
    const dependencies = def?.dependsOn ?? [];

    // Also check for auto-discovered chains
    try {
      const autoChains = await getAutoDiscoveredDependencies(name);
      dependencies.push(...autoChains);
    } catch {
      // auto-discovery unavailable, continue with explicit dependsOn
    }

    nodes.push({ name, dependsOn: [...new Set(dependencies)] });
  }

  // Detect cycles via DFS
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      cycles.push([...path, node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    const deps = nodes.find((n) => n.name === node)?.dependsOn ?? [];
    for (const dep of deps) {
      dfs(dep, [...path, node]);
    }
    stack.delete(node);
  }

  for (const node of nodes) {
    dfs(node.name, []);
  }

  const result = { nodes, cycles };

  // Cache for 5 minutes
  graphCache.data = result;
  graphCache.expires = Date.now() + 5 * 60 * 1000;

  return result;
}

// Get auto-discovered dependencies for a tool
async function getAutoDiscoveredDependencies(toolName: string): Promise<string[]> {
  try {
    const pool = getPool();
    const result = await pool.query<{ source_tool: string }>(
      `SELECT source_tool FROM tool_auto_chains
       WHERE target_tool = $1 AND compatible = true
       ORDER BY compatibility_score DESC`,
      [toolName],
    );
    return result.rows.map((r) => r.source_tool);
  } catch {
    return [];
  }
}
