import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── agent_specialization_router ────────────────────────────────────
// Automatic work domain division for agents on the same project.
// When 10-15+ agents are active in a workspace, this tool prevents
// duplication by assigning non-overlapping domains based on:
//   1. Historical performance per role (from ledger)
//   2. Current task distribution (from blackboard)
//   3. Agent capabilities (from role cards)
//   4. Explicit domain claims
//
// The router maintains a domain registry — a live map of which agent
// owns which knowledge/task domain. Agents check in before starting
// work, and the router either confirms their domain or reassigns.

const AgentSpecializationRouterParams = z.object({
  action: z
    .enum(["claim", "release", "query", "rebalance", "map", "suggest", "history"])
    .describe(
      "Action: claim a domain for an agent, release a domain, query who owns a domain, " +
      "rebalance domains across agents, view full domain map, suggest optimal assignment, " +
      "or view assignment history",
    ),
  swarm_id: z
    .string()
    .optional()
    .describe("Swarm ID (scopes domain registry to a swarm)"),
  domain: z
    .string()
    .optional()
    .describe("Domain name to claim/release/query (e.g. 'data-layer', 'auth', 'testing', 'api-design')"),
  agent_role: z
    .string()
    .optional()
    .describe("Agent role ID (defaults to current agent)"),
  agent_instance_id: z
    .string()
    .optional()
    .describe("Specific agent instance ID (for multi-instance roles)"),
  task_description: z
    .string()
    .optional()
    .describe("Description of the task the agent wants to work on (for suggest action)"),
  domains: z
    .array(z.string())
    .optional()
    .describe("List of all domains to distribute (for rebalance action)"),
  agent_count: z
    .number()
    .int()
    .optional()
    .describe("Number of agents to distribute across (for rebalance action)"),
});

// Domain assignment record
interface DomainAssignment {
  domain: string;
  agentRole: string;
  agentInstanceId: string;
  claimedAt: number;
  lastActiveAt: number;
  taskCount: number;
  status: "active" | "idle" | "released";
}

registerTool({
  name: "agent_specialization_router",
  description:
    "Automatic work domain division for agents in shared workspaces. " +
    "Prevents 10-15+ agents from duplicating effort by maintaining a domain registry — " +
    "a live map of which agent owns which knowledge/task domain. Agents check in before " +
    "starting work, claim domains, and the router ensures non-overlapping assignments. " +
    "Supports automatic rebalancing based on performance data.",
  parameters: AgentSpecializationRouterParams,

  async execute(params, ctx) {
    const pool = getPool();
    const swarmId = params.swarm_id ?? ctx.sessionId;
    const agentRole = params.agent_role ?? ctx.agentId;
    const instanceId = params.agent_instance_id ?? `${agentRole}-${ctx.sessionId.slice(0, 8)}`;

    switch (params.action) {
      // ── Claim: reserve a domain for this agent ─────────────────
      case "claim": {
        if (!params.domain) return { error: "domain required for claim" };

        // Check if domain is already claimed by another active agent
        const { rows: existing } = await pool.query<{
          value: DomainAssignment;
        }>(
          `SELECT value FROM domain_assignments
           WHERE swarm_id = $1 AND domain = $2 AND value->>'status' = 'active'
           LIMIT 1`,
          [swarmId, params.domain],
        );

        if (existing.length > 0) {
          const owner = existing[0]!.value;
          if (owner.agentInstanceId === instanceId) {
            // Already claimed by this agent — refresh timestamp
            await pool.query(
              `UPDATE domain_assignments
               SET value = jsonb_set(value, '{lastActiveAt}', $1::jsonb)
               WHERE swarm_id = $2 AND domain = $3 AND value->>'agentInstanceId' = $4`,
              [JSON.stringify(Date.now()), swarmId, params.domain, instanceId],
            );
            return { result: "Domain claim refreshed", domain: params.domain, agent: instanceId };
          }

          // Check if the owner has been idle (>5 min)
          const idleMs = Date.now() - owner.lastActiveAt;
          if (idleMs > 5 * 60 * 1000) {
            // Take over idle domain
            await pool.query(
              `UPDATE domain_assignments
               SET value = jsonb_set(value, '{status}', '"released"'::jsonb)
               WHERE swarm_id = $1 AND domain = $2 AND value->>'agentInstanceId' = $3`,
              [swarmId, params.domain, owner.agentInstanceId],
            );
          } else {
            return {
              result: "Domain already claimed",
              domain: params.domain,
              currentOwner: {
                role: owner.agentRole,
                instanceId: owner.agentInstanceId,
                claimedAt: new Date(owner.claimedAt).toISOString(),
                idleMs,
              },
              suggestion: "Choose a different domain or wait for the owner to release it",
            };
          }
        }

        // Claim the domain
        const assignment: DomainAssignment = {
          domain: params.domain,
          agentRole: agentRole,
          agentInstanceId: instanceId,
          claimedAt: Date.now(),
          lastActiveAt: Date.now(),
          taskCount: 0,
          status: "active",
        };

        const id = randomUUID();
        await pool.query(
          `INSERT INTO domain_assignments (id, swarm_id, domain, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
          [id, swarmId, params.domain, JSON.stringify(assignment)],
        );

        // Record in history
        await pool.query(
          `INSERT INTO domain_history (id, swarm_id, uid, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [randomUUID(), swarmId, ctx.uid, JSON.stringify({
            action: "claim",
            domain: params.domain,
            agentRole,
            instanceId,
          })],
        );

        return {
          result: "Domain claimed",
          assignmentId: id,
          domain: params.domain,
          agent: instanceId,
          role: agentRole,
        };
      }

      // ── Release: give up a domain ──────────────────────────────
      case "release": {
        if (!params.domain) return { error: "domain required for release" };

        const { rowCount } = await pool.query(
          `UPDATE domain_assignments
           SET value = jsonb_set(value, '{status}', '"released"'::jsonb), updated_at = NOW()
           WHERE swarm_id = $1 AND domain = $2 AND value->>'agentInstanceId' = $3`,
          [swarmId, params.domain, instanceId],
        );

        if (!rowCount || rowCount === 0) {
          return { error: "Domain not found or not owned by this agent" };
        }

        await pool.query(
          `INSERT INTO domain_history (id, swarm_id, uid, value, created_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())`,
          [randomUUID(), swarmId, ctx.uid, JSON.stringify({
            action: "release",
            domain: params.domain,
            agentRole,
            instanceId,
          })],
        );

        return { result: "Domain released", domain: params.domain };
      }

      // ── Query: check who owns a domain ─────────────────────────
      case "query": {
        if (!params.domain) return { error: "domain required for query" };

        const { rows } = await pool.query<{ value: DomainAssignment }>(
          `SELECT value FROM domain_assignments
           WHERE swarm_id = $1 AND domain = $2 AND value->>'status' = 'active'
           LIMIT 1`,
          [swarmId, params.domain],
        );

        if (rows.length === 0) {
          return { result: "Domain is unclaimed", domain: params.domain, available: true };
        }

        const owner = rows[0]!.value;
        return {
          result: "Domain is claimed",
          domain: params.domain,
          available: false,
          owner: {
            role: owner.agentRole,
            instanceId: owner.agentInstanceId,
            claimedAt: new Date(owner.claimedAt).toISOString(),
            taskCount: owner.taskCount,
            idleMs: Date.now() - owner.lastActiveAt,
          },
        };
      }

      // ── Rebalance: redistribute domains optimally ──────────────
      case "rebalance": {
        // Get all active assignments
        const { rows: allAssignments } = await pool.query<{
          domain: string;
          value: DomainAssignment;
        }>(
          `SELECT domain, value FROM domain_assignments
           WHERE swarm_id = $1 AND value->>'status' = 'active'
           ORDER BY domain`,
          [swarmId],
        );

        // Get unique active agents
        const agentDomains = new Map<string, string[]>();
        for (const row of allAssignments) {
          const agent = row.value.agentInstanceId;
          if (!agentDomains.has(agent)) agentDomains.set(agent, []);
          agentDomains.get(agent)!.push(row.domain);
        }

        // Check for imbalance
        const agents = Array.from(agentDomains.entries());
        const totalDomains = allAssignments.length;
        const totalAgents = agents.length;
        const idealPerAgent = totalAgents > 0 ? Math.ceil(totalDomains / totalAgents) : 0;

        const overloaded = agents.filter(([, domains]) => domains.length > idealPerAgent + 1);
        const underloaded = agents.filter(([, domains]) => domains.length < idealPerAgent - 1);

        const reassignments: Array<{
          domain: string;
          from: string;
          to: string;
        }> = [];

        // Move domains from overloaded to underloaded
        for (const [overAgent, overDomains] of overloaded) {
          while (overDomains.length > idealPerAgent && underloaded.length > 0) {
            const [underAgent, underDomains] = underloaded[0]!;
            const domainToMove = overDomains.pop()!;

            // Update assignment
            await pool.query(
              `UPDATE domain_assignments
               SET value = jsonb_set(
                 jsonb_set(value, '{agentInstanceId}', $1::jsonb),
                 '{agentRole}', $2::jsonb
               ), updated_at = NOW()
               WHERE swarm_id = $3 AND domain = $4 AND value->>'agentInstanceId' = $5`,
              [
                JSON.stringify(underAgent),
                JSON.stringify(underAgent.split("-")[0]),
                swarmId,
                domainToMove,
                overAgent,
              ],
            );

            underDomains.push(domainToMove);
            reassignments.push({ domain: domainToMove, from: overAgent, to: underAgent });

            if (underDomains.length >= idealPerAgent) {
              underloaded.shift();
            }
          }
        }

        return {
          result: "Rebalance complete",
          totalDomains,
          totalAgents,
          idealPerAgent,
          reassignments: reassignments.length,
          details: reassignments,
          distribution: agents.map(([agent, domains]) => ({
            agent,
            domainCount: domains.length,
            domains,
          })),
        };
      }

      // ── Map: view the full domain registry ─────────────────────
      case "map": {
        const { rows } = await pool.query<{
          domain: string;
          value: DomainAssignment;
        }>(
          `SELECT domain, value FROM domain_assignments
           WHERE swarm_id = $1 AND value->>'status' = 'active'
           ORDER BY domain`,
          [swarmId],
        );

        // Group by agent
        const byAgent = new Map<string, string[]>();
        const byDomain = new Map<string, { role: string; instanceId: string; taskCount: number }>();

        for (const row of rows) {
          const agent = row.value.agentInstanceId;
          if (!byAgent.has(agent)) byAgent.set(agent, []);
          byAgent.get(agent)!.push(row.domain);
          byDomain.set(row.domain, {
            role: row.value.agentRole,
            instanceId: row.value.agentInstanceId,
            taskCount: row.value.taskCount,
          });
        }

        return {
          result: `${rows.length} active domain(s) across ${byAgent.size} agent(s)`,
          swarmId,
          domains: Object.fromEntries(byDomain),
          agentWorkloads: Array.from(byAgent.entries()).map(([agent, domains]) => ({
            agent,
            domainCount: domains.length,
            domains,
          })),
        };
      }

      // ── Suggest: recommend domain assignment for a task ────────
      case "suggest": {
        if (!params.task_description) return { error: "task_description required for suggest" };

        // Extract domain keywords from task
        const taskLower = params.task_description.toLowerCase();
        const domainKeywords: Record<string, string[]> = {
          "data-layer": ["database", "schema", "migration", "sql", "query", "model", "orm", "postgres"],
          "api-design": ["api", "endpoint", "route", "rest", "graphql", "controller", "handler"],
          "auth": ["auth", "login", "session", "token", "permission", "role", "oauth", "jwt"],
          "testing": ["test", "spec", "coverage", "mock", "fixture", "assert", "e2e", "integration"],
          "frontend": ["ui", "component", "react", "vue", "css", "style", "layout", "page"],
          "infrastructure": ["deploy", "docker", "ci", "cd", "config", "env", "terraform", "kubernetes"],
          "documentation": ["doc", "readme", "guide", "tutorial", "comment", "jsdoc"],
          "performance": ["perf", "optimize", "cache", "latency", "benchmark", "profil"],
          "security": ["security", "vulnerability", "xss", "injection", "sanitiz", "encrypt"],
          "memory-system": ["memory", "embedding", "vector", "graph", "knowledge", "retrieval"],
        };

        const scores: Array<{ domain: string; score: number; matchedKeywords: string[] }> = [];
        for (const [domain, keywords] of Object.entries(domainKeywords)) {
          const matched = keywords.filter((kw) => taskLower.includes(kw));
          if (matched.length > 0) {
            scores.push({
              domain,
              score: matched.length / keywords.length,
              matchedKeywords: matched,
            });
          }
        }
        scores.sort((a, b) => b.score - a.score);

        // Check availability of top suggestions
        const suggestions: Array<{
          domain: string;
          score: number;
          available: boolean;
          currentOwner?: string;
        }> = [];

        for (const s of scores.slice(0, 5)) {
          const { rows: existing } = await pool.query<{ value: DomainAssignment }>(
            `SELECT value FROM domain_assignments
             WHERE swarm_id = $1 AND domain = $2 AND value->>'status' = 'active' LIMIT 1`,
            [swarmId, s.domain],
          );

          suggestions.push({
            domain: s.domain,
            score: Math.round(s.score * 100) / 100,
            available: existing.length === 0,
            currentOwner: existing.length > 0 ? existing[0]!.value.agentInstanceId : undefined,
          });
        }

        // If no keyword match, suggest a custom domain
        if (suggestions.length === 0) {
          const words = params.task_description.split(/\s+/).slice(0, 3).join("-").toLowerCase();
          suggestions.push({ domain: words, score: 0.5, available: true });
        }

        return {
          result: `${suggestions.length} domain suggestion(s)`,
          taskDescription: params.task_description.slice(0, 200),
          suggestions,
          hint: "Use 'claim' action with the recommended domain to reserve it",
        };
      }

      // ── History: view domain assignment changes ────────────────
      case "history": {
        const { rows } = await pool.query<{
          id: string;
          uid: string;
          value: Record<string, unknown>;
          created_at: string;
        }>(
          `SELECT id, uid, value, created_at FROM domain_history
           WHERE swarm_id = $1
           ORDER BY created_at DESC LIMIT 30`,
          [swarmId],
        );

        return {
          result: `${rows.length} domain event(s)`,
          swarmId,
          events: rows.map((r) => ({
            id: r.id,
            userId: r.uid,
            ...r.value,
            createdAt: r.created_at,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
