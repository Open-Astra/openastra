import { z } from "zod";
import { writeFile, readFile } from "node:fs/promises";
import { resolve, normalize } from "node:path";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import type { DailyMemoryEntry, MemoryProfile } from "../memory/types.js";
import { appendDailyMemory, updateProfile } from "../memory/store.js";
import { findOrCreateEntity, createEdge } from "../memory/graph.js";
import type { EntityType, EdgeType } from "../memory/graph.js";

// ── memory_export Tool ──────────────────────────────────────────────
// Exports all memory layers (daily, profile, graph, procedures) as a
// single JSON file. Useful for backups, migration, or analysis.

const MemoryExportParams = z.object({
  path: z.string().describe("File path to write the export JSON"),
  layers: z
    .array(z.enum(["daily", "profile", "graph", "procedures"]))
    .default(["daily", "profile", "graph", "procedures"])
    .describe("Memory layers to export (defaults to all)"),
  daysBack: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe("How many days of daily memory to export (default 30)"),
});

registerTool({
  name: "memory_export",
  description:
    "Export the user's memory to a JSON file. Includes daily memories, long-term profile, knowledge graph entities/edges, and procedural memory. Use for backups, migration, or offline analysis.",
  parameters: MemoryExportParams,
  async execute(params, ctx) {
    const pool = getPool();
    const filePath = resolve(normalize(params.path));
    const exportData: Record<string, unknown> = {
      version: 1,
      exportedAt: new Date().toISOString(),
      uid: ctx.uid,
      layers: {},
    };

    const layers = exportData.layers as Record<string, unknown>;

    // Daily memory
    if (params.layers.includes("daily")) {
      const { rows } = await pool.query<{
        date: string;
        entries: DailyMemoryEntry[];
      }>(
        `SELECT date, entries FROM daily_memory
         WHERE user_id = $1
         ORDER BY date DESC
         LIMIT $2`,
        [ctx.uid, params.daysBack],
      );

      layers.daily = rows.map((r) => ({
        date: typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10),
        entries: r.entries,
      }));
    }

    // Profile
    if (params.layers.includes("profile")) {
      const { rows } = await pool.query<{ profile_data: MemoryProfile }>(
        "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
        [ctx.uid],
      );
      layers.profile = rows.length > 0 ? rows[0]!.profile_data : null;
    }

    // Graph entities and edges
    if (params.layers.includes("graph")) {
      const { rows: entities } = await pool.query(
        `SELECT id, type, name, description, properties, reinforcement_score,
                access_count, created_at, last_accessed_at
         FROM graph_entities WHERE uid = $1
         ORDER BY reinforcement_score DESC
         LIMIT 1000`,
        [ctx.uid],
      );

      const { rows: edges } = await pool.query(
        `SELECT id, source_id, target_id, type, weight, metadata,
                reinforcement_count, created_at, last_reinforced_at
         FROM graph_edges WHERE uid = $1
         LIMIT 5000`,
        [ctx.uid],
      );

      layers.graph = { entities, edges };
    }

    // Procedural memory
    if (params.layers.includes("procedures")) {
      const { rows } = await pool.query(
        `SELECT id, title, content, type, trigger_pattern, steps, tags,
                execution_count, success_count, source, created_at, updated_at
         FROM procedural_memory WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 200`,
        [ctx.uid],
      );
      layers.procedures = rows;
    }

    const json = JSON.stringify(exportData, null, 2);
    await writeFile(filePath, json, "utf-8");

    // Count items
    const counts = {
      daily: Array.isArray(layers.daily) ? (layers.daily as unknown[]).length : 0,
      profile: layers.profile ? 1 : 0,
      graphEntities: (layers.graph as { entities: unknown[] } | undefined)?.entities.length ?? 0,
      graphEdges: (layers.graph as { edges: unknown[] } | undefined)?.edges.length ?? 0,
      procedures: Array.isArray(layers.procedures) ? (layers.procedures as unknown[]).length : 0,
    };

    return {
      path: filePath,
      bytes: Buffer.byteLength(json),
      counts,
      message: `Exported memory to ${filePath}`,
    };
  },
});

// ── memory_import Tool ──────────────────────────────────────────────
// Imports memory from a previously exported JSON file. Merges with
// existing memory (does not overwrite).

const MemoryImportParams = z.object({
  path: z.string().describe("File path of the export JSON to import"),
  layers: z
    .array(z.enum(["daily", "profile", "graph", "procedures"]))
    .default(["daily", "profile", "graph", "procedures"])
    .describe("Memory layers to import (defaults to all)"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("If true, only report what would be imported without making changes"),
});

registerTool({
  name: "memory_import",
  description:
    "Import memory from a previously exported JSON file. Merges with existing memory (additive, does not overwrite). Supports dry-run mode to preview changes before applying. Use for restoring backups or migrating memory between instances.",
  parameters: MemoryImportParams,
  async execute(params, ctx) {
    const filePath = resolve(normalize(params.path));
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as {
      version: number;
      layers: {
        daily?: Array<{ date: string; entries: DailyMemoryEntry[] }>;
        profile?: MemoryProfile | null;
        graph?: {
          entities: Array<{ type: string; name: string; description: string; properties: Record<string, unknown> }>;
          edges: Array<{ source_id: string; target_id: string; type: string; weight: number; metadata: Record<string, unknown> }>;
        };
        procedures?: Array<{
          title: string;
          content: string;
          type: string;
          trigger_pattern: string;
          steps: unknown[];
          tags: string[];
          source: string;
        }>;
      };
    };

    const counts = {
      dailyEntries: 0,
      profileUpdated: false,
      graphEntities: 0,
      graphEdges: 0,
      procedures: 0,
    };

    // Daily memory
    if (params.layers.includes("daily") && data.layers.daily) {
      for (const day of data.layers.daily) {
        for (const entry of day.entries) {
          counts.dailyEntries++;
          if (!params.dryRun) {
            await appendDailyMemory(ctx.uid, entry);
          }
        }
      }
    }

    // Profile
    if (params.layers.includes("profile") && data.layers.profile) {
      counts.profileUpdated = true;
      if (!params.dryRun) {
        await updateProfile(ctx.uid, data.layers.profile);
      }
    }

    // Graph
    if (params.layers.includes("graph") && data.layers.graph) {
      const entityIdMap = new Map<string, string>(); // old ID → new entity ID

      for (const ent of data.layers.graph.entities) {
        counts.graphEntities++;
        if (!params.dryRun) {
          const created = await findOrCreateEntity(
            ctx.uid,
            ent.type as EntityType,
            ent.name,
            ent.description,
            ent.properties ?? {},
          );
          entityIdMap.set(ent.name, created.id);
        }
      }

      // Edges need entity ID mapping — use name-based lookup
      for (const edge of data.layers.graph.edges) {
        counts.graphEdges++;
        if (!params.dryRun) {
          // Resolve source and target by looking up from the map
          const sourceId = entityIdMap.get(edge.source_id);
          const targetId = entityIdMap.get(edge.target_id);
          if (sourceId && targetId) {
            await createEdge(
              ctx.uid,
              sourceId,
              targetId,
              edge.type as EdgeType,
              edge.weight,
              edge.metadata ?? {},
            );
          }
        }
      }
    }

    // Procedures
    if (params.layers.includes("procedures") && data.layers.procedures) {
      const pool = getPool();
      for (const proc of data.layers.procedures) {
        counts.procedures++;
        if (!params.dryRun) {
          const { randomUUID } = await import("node:crypto");
          await pool.query(
            `INSERT INTO procedural_memory
               (id, user_id, title, content, type, trigger_pattern, steps, tags, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
             ON CONFLICT DO NOTHING`,
            [
              randomUUID(),
              ctx.uid,
              proc.title,
              proc.content,
              proc.type,
              proc.trigger_pattern,
              JSON.stringify(proc.steps),
              proc.tags,
              proc.source,
            ],
          );
        }
      }
    }

    return {
      dryRun: params.dryRun,
      path: filePath,
      counts,
      message: params.dryRun
        ? `Dry run: would import ${counts.dailyEntries} daily entries, ${counts.graphEntities} entities, ${counts.graphEdges} edges, ${counts.procedures} procedures`
        : `Imported memory from ${filePath}`,
    };
  },
});
