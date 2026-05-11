// ── Skill Dependency Graph & Auto-Resolution (Feature 29) ───────────
// Builds a dependency graph from skill composes/requires relationships,
// topologically sorts skills for initialization ordering, detects
// cycles, and validates the graph for the dashboard.

import type { SkillDefinition } from "./types.js";
import { getAllSkills } from "./registry.js";

// ── Types ────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  tools: string[];
  composes: string[];
  requires: string[];
  category: string;
  version: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "composes" | "requires";
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  cycles: string[][];
}

// ── Build Graph ──────────────────────────────────────────────────────

export function buildDependencyGraph(): DependencyGraph {
  const skills = getAllSkills();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [id, skill] of skills) {
    nodes.push({
      id,
      name: skill.manifest.name,
      tools: skill.manifest.tools,
      composes: skill.manifest.composes ?? [],
      requires: skill.manifest.requires ?? [],
      category: skill.manifest.category,
      version: skill.manifest.version,
    });

    for (const dep of skill.manifest.composes ?? []) {
      edges.push({ from: id, to: dep, type: "composes" });
    }
    for (const dep of skill.manifest.requires ?? []) {
      edges.push({ from: id, to: dep, type: "requires" });
    }
  }

  return { nodes, edges };
}

// ── Topological Sort ─────────────────────────────────────────────────
// Kahn's algorithm with DFS-based cycle detection for clear error
// messages. Returns skills reordered so dependencies init first.

export function topoSortSkills(discovered: SkillDefinition[]): SkillDefinition[] {
  const idToSkill = new Map<string, SkillDefinition>();
  for (const s of discovered) {
    idToSkill.set(s.manifest.id, s);
  }

  const ids = discovered.map((s) => s.manifest.id);
  const idSet = new Set(ids);

  // Build adjacency list (dependency → dependent)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → skills that depend on it

  for (const id of ids) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const skill of discovered) {
    const deps = [
      ...(skill.manifest.composes ?? []),
      ...(skill.manifest.requires ?? []),
    ].filter((d) => idSet.has(d));

    inDegree.set(skill.manifest.id, deps.length);

    for (const dep of deps) {
      dependents.get(dep)?.push(skill.manifest.id);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);

    for (const dep of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (sorted.length < ids.length) {
    // Cycle detected — use DFS to find the cycle path
    const cycle = findCycleDFS(discovered);
    throw new Error(
      `Skill dependency cycle detected: ${cycle.join(" -> ")}. ` +
      `Remove or break the circular dependency to proceed.`,
    );
  }

  return sorted.map((id) => idToSkill.get(id)!).filter(Boolean);
}

// ── Cycle Detection (DFS) ────────────────────────────────────────────

function findCycleDFS(discovered: SkillDefinition[]): string[] {
  const idSet = new Set(discovered.map((s) => s.manifest.id));
  const adj = new Map<string, string[]>();

  for (const skill of discovered) {
    const deps = [
      ...(skill.manifest.composes ?? []),
      ...(skill.manifest.requires ?? []),
    ].filter((d) => idSet.has(d));
    adj.set(skill.manifest.id, deps);
  }

  const WHITE = 0;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const id of idSet) {
    color.set(id, WHITE);
    parent.set(id, null);
  }

  for (const id of idSet) {
    if (color.get(id) === WHITE) {
      const cycle = dfsVisit(id, adj, color, parent);
      if (cycle) return cycle;
    }
  }

  return ["unknown cycle"];
}

function dfsVisit(
  u: string,
  adj: Map<string, string[]>,
  color: Map<string, number>,
  parent: Map<string, string | null>,
): string[] | null {
  color.set(u, 1);

  for (const v of adj.get(u) ?? []) {
    if (color.get(v) === 1) {
      // Back edge — reconstruct cycle
      const cycle = [v, u];
      let cur = u;
      while (cur !== v && parent.get(cur) != null) {
        cur = parent.get(cur)!;
        cycle.push(cur);
      }
      return cycle.reverse();
    }
    if (color.get(v) === 0) {
      parent.set(v, u);
      const cycle = dfsVisit(v, adj, color, parent);
      if (cycle) return cycle;
    }
  }

  color.set(u, 2);
  return null;
}

// ── Transitive Dependencies ──────────────────────────────────────────

export function getTransitiveDependencies(skillId: string): string[] {
  const skills = getAllSkills();
  const visited = new Set<string>();
  const queue = [skillId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const skill = skills.get(id);
    if (!skill) continue;

    for (const dep of [
      ...(skill.manifest.composes ?? []),
      ...(skill.manifest.requires ?? []),
    ]) {
      if (!visited.has(dep)) queue.push(dep);
    }
  }

  visited.delete(skillId); // Don't include self
  return [...visited];
}

// ── Graph Validation ─────────────────────────────────────────────────

export function validateDependencyGraph(): ValidationResult {
  const skills = getAllSkills();
  const errors: string[] = [];
  const warnings: string[] = [];
  const cycles: string[][] = [];

  const registeredIds = new Set(skills.keys());

  // Check for missing dependencies
  for (const [id, skill] of skills) {
    for (const dep of skill.manifest.composes ?? []) {
      if (!registeredIds.has(dep)) {
        errors.push(`Skill "${id}" composes unknown skill "${dep}"`);
      }
    }
    for (const dep of skill.manifest.requires ?? []) {
      if (!registeredIds.has(dep)) {
        warnings.push(`Skill "${id}" requires unresolved dependency "${dep}" (may be a tool ID)`);
      }
    }
  }

  // Check for cycles
  const discovered = [...skills.values()];
  try {
    topoSortSkills(discovered);
  } catch (err) {
    if (err instanceof Error && err.message.includes("cycle")) {
      const cycleMatch = err.message.match(/cycle detected: (.+?)\./);
      if (cycleMatch) {
        cycles.push(cycleMatch[1].split(" -> "));
      }
      errors.push(err.message);
    }
  }

  // Check for orphaned skills (no tools, no composes, not composed by anything)
  const composedBy = new Set<string>();
  for (const skill of skills.values()) {
    for (const dep of skill.manifest.composes ?? []) {
      composedBy.add(dep);
    }
  }

  for (const [id, skill] of skills) {
    if (
      skill.manifest.tools.length === 0 &&
      (skill.manifest.composes ?? []).length === 0 &&
      !composedBy.has(id)
    ) {
      warnings.push(`Skill "${id}" has no tools, composes nothing, and is not composed by any other skill`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    cycles,
  };
}
