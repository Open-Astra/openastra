import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Data Pipeline Skill ─────────────────────────────────────────────
// Extract, transform, and load data through multi-step pipelines.
// Supports chained transformations on arrays of objects.

const TransformStepSchema = z.object({
  operation: z.enum(["filter", "map", "sort", "limit", "deduplicate", "rename", "pick", "omit", "flatten"]),
  field: z.string().optional().describe("Field name for the operation"),
  value: z.string().optional().describe("Value or expression"),
  direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
  fields: z.array(z.string()).optional().describe("Field list for pick/omit/rename"),
});

const PipelineParams = z.object({
  data: z.array(z.record(z.string(), z.unknown())).describe("Input array of objects"),
  steps: z.array(TransformStepSchema).min(1).max(10).describe("Transformation steps to apply in order"),
});

const JoinParams = z.object({
  left: z.array(z.record(z.string(), z.unknown())).describe("Left dataset"),
  right: z.array(z.record(z.string(), z.unknown())).describe("Right dataset"),
  leftKey: z.string().describe("Join key in left dataset"),
  rightKey: z.string().describe("Join key in right dataset"),
  type: z.enum(["inner", "left", "full"]).default("inner").describe("Join type"),
});

type DataRow = Record<string, unknown>;

const dataPipelineSkill: SkillDefinition = {
  name: "data_pipeline",
  version: "1.0.0",

  manifest: {
    id: "data_pipeline",
    name: "Data Pipeline",
    description: "Multi-step data transformation pipelines. Filter, map, sort, deduplicate, join, and reshape data.",
    category: "transform",
    tools: ["pipeline_run", "pipeline_join"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "pipeline_run",
      description: "Run a multi-step data transformation pipeline on an array of objects.",
      parameters: PipelineParams,

      async execute(params, _toolCtx) {
        let data: DataRow[] = params.data as DataRow[];
        const log: string[] = [];

        for (const step of params.steps) {
          const before = data.length;

          switch (step.operation) {
            case "filter": {
              if (!step.field || !step.value) { log.push("filter: missing field/value"); break; }
              const [op, val] = step.value.includes(":") ? step.value.split(":", 2) as [string, string] : ["eq", step.value];
              data = data.filter((row) => {
                const cell = String(row[step.field!] ?? "");
                const numCell = parseFloat(cell);
                const numVal = parseFloat(val!);
                switch (op) {
                  case "eq": return cell === val;
                  case "ne": return cell !== val;
                  case "gt": return numCell > numVal;
                  case "lt": return numCell < numVal;
                  case "contains": return cell.toLowerCase().includes((val ?? "").toLowerCase());
                  default: return cell === val;
                }
              });
              break;
            }
            case "sort": {
              if (!step.field) { log.push("sort: missing field"); break; }
              const dir = step.direction === "desc" ? -1 : 1;
              data.sort((a, b) => {
                const va = a[step.field!];
                const vb = b[step.field!];
                if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
                return String(va ?? "").localeCompare(String(vb ?? "")) * dir;
              });
              break;
            }
            case "limit": {
              const n = parseInt(step.value ?? "10", 10);
              data = data.slice(0, n);
              break;
            }
            case "deduplicate": {
              if (!step.field) { log.push("deduplicate: missing field"); break; }
              const seen = new Set<string>();
              data = data.filter((row) => {
                const key = String(row[step.field!] ?? "");
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              break;
            }
            case "pick": {
              if (!step.fields?.length) { log.push("pick: missing fields"); break; }
              const fields = step.fields;
              data = data.map((row) => {
                const out: DataRow = {};
                for (const f of fields) out[f] = row[f];
                return out;
              });
              break;
            }
            case "omit": {
              if (!step.fields?.length) { log.push("omit: missing fields"); break; }
              const omitSet = new Set(step.fields);
              data = data.map((row) => {
                const out: DataRow = {};
                for (const [k, v] of Object.entries(row)) {
                  if (!omitSet.has(k)) out[k] = v;
                }
                return out;
              });
              break;
            }
            case "map": {
              if (!step.field || !step.value) { log.push("map: missing field/value"); break; }
              data = data.map((row) => ({ ...row, [step.field!]: step.value }));
              break;
            }
            case "rename": {
              if (!step.field || !step.value) { log.push("rename: missing field/value"); break; }
              data = data.map((row) => {
                const out: DataRow = {};
                for (const [k, v] of Object.entries(row)) {
                  out[k === step.field ? step.value! : k] = v;
                }
                return out;
              });
              break;
            }
            case "flatten": {
              if (!step.field) { log.push("flatten: missing field"); break; }
              const flattened: DataRow[] = [];
              for (const row of data) {
                const arr = row[step.field!];
                if (Array.isArray(arr)) {
                  for (const item of arr) {
                    flattened.push({ ...row, [step.field!]: item });
                  }
                } else {
                  flattened.push(row);
                }
              }
              data = flattened;
              break;
            }
          }

          log.push(`${step.operation}: ${before} → ${data.length} rows`);
        }

        return { rowCount: data.length, steps: log, data: data.slice(0, 500) };
      },
    });

    ctx.registerTool({
      name: "pipeline_join",
      description: "Join two datasets on a common key. Supports inner, left, and full joins.",
      parameters: JoinParams,

      async execute(params, _toolCtx) {
        const rightMap = new Map<string, DataRow[]>();
        for (const row of params.right as DataRow[]) {
          const key = String(row[params.rightKey] ?? "");
          const arr = rightMap.get(key) ?? [];
          arr.push(row);
          rightMap.set(key, arr);
        }

        const results: DataRow[] = [];
        const matchedRightKeys = new Set<string>();

        for (const lRow of params.left as DataRow[]) {
          const key = String(lRow[params.leftKey] ?? "");
          const rRows = rightMap.get(key);

          if (rRows) {
            matchedRightKeys.add(key);
            for (const rRow of rRows) {
              results.push({ ...lRow, ...rRow });
            }
          } else if (params.type === "left" || params.type === "full") {
            results.push({ ...lRow });
          }
        }

        if (params.type === "full") {
          for (const [key, rRows] of rightMap) {
            if (!matchedRightKeys.has(key)) {
              for (const rRow of rRows) results.push({ ...rRow });
            }
          }
        }

        return { joinType: params.type, leftRows: params.left.length, rightRows: params.right.length, resultRows: results.length, data: results.slice(0, 500) };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "data_pipeline",
      instructions: "You can transform data with `pipeline_run` (chain filter/sort/limit/deduplicate/pick/omit/rename/flatten steps) and `pipeline_join` (join two datasets on a key).",
    };
  },
};

export default dataPipelineSkill;
