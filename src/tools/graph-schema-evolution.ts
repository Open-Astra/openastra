import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── graph_schema_evolve ─────────────────────────────────────────────
// Knowledge graph schema evolution agent. Observes entity/edge patterns,
// proposes new types, and manages schema additions with an approval
// workflow. Prevents schema bloat via frequency analysis.

const GraphSchemaEvolveParams = z.object({
  action: z
    .enum(["analyze", "propose", "approve", "reject", "list_proposals", "current_schema"])
    .describe("Action: analyze patterns, propose new types, approve/reject proposals, list pending proposals, or view current schema"),
  entity_type: z.string().optional().describe("Proposed entity type name (for propose)"),
  edge_type: z.string().optional().describe("Proposed edge type name (for propose)"),
  description: z.string().optional().describe("Description of proposed type"),
  proposal_id: z.string().optional().describe("Proposal ID (for approve/reject)"),
  reason: z.string().optional().describe("Reason for approval/rejection"),
});

registerTool({
  name: "graph_schema_evolve",
  description:
    "Knowledge graph schema evolution. Analyze entity/edge patterns to discover implicit types, propose new entity/edge types, and manage schema additions with approval workflow.",
  parameters: GraphSchemaEvolveParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "analyze": {
        // Analyze current graph for patterns
        const { rows: entityStats } = await pool.query<{
          type: string;
          count: string;
          avg_score: string;
        }>(
          `SELECT type, COUNT(*)::text AS count, AVG(reinforcement_score)::text AS avg_score
           FROM graph_entities WHERE uid = $1
           GROUP BY type ORDER BY count DESC`,
          [ctx.uid],
        );

        const { rows: edgeStats } = await pool.query<{
          type: string;
          count: string;
          avg_weight: string;
        }>(
          `SELECT type, COUNT(*)::text AS count, AVG(weight)::text AS avg_weight
           FROM graph_edges WHERE uid = $1
           GROUP BY type ORDER BY count DESC`,
          [ctx.uid],
        );

        // Look for entities with "concept" type that might need specialization
        const { rows: conceptAnalysis } = await pool.query<{
          name: string;
          description: string;
          access_count: number;
        }>(
          `SELECT name, description, access_count FROM graph_entities
           WHERE uid = $1 AND type = 'concept'
           ORDER BY access_count DESC LIMIT 20`,
          [ctx.uid],
        );

        // Find property patterns that suggest new types
        const { rows: propertyPatterns } = await pool.query<{
          type: string;
          key: string;
          count: string;
        }>(
          `SELECT type, key, COUNT(*)::text AS count
           FROM graph_entities, jsonb_object_keys(properties) AS key
           WHERE uid = $1
           GROUP BY type, key
           HAVING COUNT(*) > 3
           ORDER BY count DESC LIMIT 20`,
          [ctx.uid],
        );

        // Generate suggestions
        const suggestions: Array<{ suggestion: string; confidence: number; reason: string }> = [];

        // High-frequency concepts might warrant their own type
        for (const concept of conceptAnalysis) {
          if (concept.access_count > 10) {
            suggestions.push({
              suggestion: `entity_type: "${concept.name.toLowerCase().replace(/\s+/g, "_")}"`,
              confidence: Math.min(0.9, concept.access_count / 50),
              reason: `"${concept.name}" is a frequently accessed concept (${concept.access_count} accesses) that may warrant its own entity type`,
            });
          }
        }

        // Property patterns suggesting type specialization
        for (const pp of propertyPatterns) {
          const count = parseInt(pp.count);
          if (count > 5) {
            suggestions.push({
              suggestion: `property "${pp.key}" on ${pp.type} entities (${count} occurrences)`,
              confidence: Math.min(0.8, count / 20),
              reason: `Recurring property pattern suggests schema enrichment`,
            });
          }
        }

        return {
          result: "Schema analysis complete",
          entityTypes: entityStats.map((r) => ({
            type: r.type,
            count: parseInt(r.count),
            avgScore: Math.round(parseFloat(r.avg_score) * 100) / 100,
          })),
          edgeTypes: edgeStats.map((r) => ({
            type: r.type,
            count: parseInt(r.count),
            avgWeight: Math.round(parseFloat(r.avg_weight) * 100) / 100,
          })),
          suggestions,
        };
      }

      case "propose": {
        if (!params.entity_type && !params.edge_type) {
          return { error: "entity_type or edge_type required for propose" };
        }

        const id = randomUUID();
        const proposal = {
          type: params.entity_type ? "entity" : "edge",
          name: params.entity_type ?? params.edge_type,
          description: params.description ?? "",
          proposedBy: ctx.agentId,
          status: "pending",
          proposedAt: Date.now(),
        };

        await pool.query(
          `INSERT INTO graph_schema_proposals (id, uid, value, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [id, ctx.uid, JSON.stringify(proposal)],
        );

        return {
          result: "Schema proposal submitted",
          proposalId: id,
          ...proposal,
        };
      }

      case "approve": {
        if (!params.proposal_id) return { error: "proposal_id required" };

        const { rows } = await pool.query<{
          value: { type: string; name: string; description: string };
        }>(
          "SELECT value FROM graph_schema_proposals WHERE id = $1 AND uid = $2",
          [params.proposal_id, ctx.uid],
        );

        if (rows.length === 0) return { error: "Proposal not found" };

        const proposal = rows[0]!.value;

        // Update proposal status
        await pool.query(
          `UPDATE graph_schema_proposals
           SET value = value || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({ status: "approved", approvedBy: ctx.uid, approvedAt: Date.now(), reason: params.reason }), params.proposal_id],
        );

        // Register the new type in the schema registry
        await pool.query(
          `INSERT INTO graph_schema_registry (uid, type_category, type_name, description, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (uid, type_category, type_name) DO NOTHING`,
          [ctx.uid, proposal.type, proposal.name, proposal.description],
        );

        return {
          result: "Proposal approved and schema updated",
          proposalId: params.proposal_id,
          type: proposal.type,
          name: proposal.name,
        };
      }

      case "reject": {
        if (!params.proposal_id) return { error: "proposal_id required" };

        await pool.query(
          `UPDATE graph_schema_proposals
           SET value = value || $1::jsonb
           WHERE id = $2 AND uid = $3`,
          [JSON.stringify({ status: "rejected", rejectedBy: ctx.uid, rejectedAt: Date.now(), reason: params.reason ?? "No reason given" }), params.proposal_id, ctx.uid],
        );

        return { result: "Proposal rejected", proposalId: params.proposal_id };
      }

      case "list_proposals": {
        const { rows } = await pool.query<{
          id: string;
          value: { type: string; name: string; status: string; proposedBy: string; proposedAt: number };
        }>(
          `SELECT id, value FROM graph_schema_proposals
           WHERE uid = $1 ORDER BY created_at DESC LIMIT 20`,
          [ctx.uid],
        );

        return {
          result: `${rows.length} proposal(s)`,
          proposals: rows.map((r) => ({
            id: r.id,
            ...r.value,
          })),
        };
      }

      case "current_schema": {
        const { rows: entityTypes } = await pool.query<{
          type_name: string;
          description: string;
        }>(
          "SELECT type_name, description FROM graph_schema_registry WHERE uid = $1 AND type_category = 'entity'",
          [ctx.uid],
        );

        const { rows: edgeTypes } = await pool.query<{
          type_name: string;
          description: string;
        }>(
          "SELECT type_name, description FROM graph_schema_registry WHERE uid = $1 AND type_category = 'edge'",
          [ctx.uid],
        );

        // Also include built-in types
        const builtInEntityTypes = ["person", "team", "event", "concept", "market", "outcome", "document"];
        const builtInEdgeTypes = ["plays_for", "related_to", "caused_by", "contradicts", "supports", "part_of", "preceded_by", "correlated_with", "mentioned_in", "user_noted"];

        return {
          result: "Current schema",
          entityTypes: {
            builtIn: builtInEntityTypes,
            custom: entityTypes.map((r) => ({ name: r.type_name, description: r.description })),
          },
          edgeTypes: {
            builtIn: builtInEdgeTypes,
            custom: edgeTypes.map((r) => ({ name: r.type_name, description: r.description })),
          },
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
