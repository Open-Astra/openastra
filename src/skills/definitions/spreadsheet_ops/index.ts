import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Spreadsheet Operations Skill ────────────────────────────────────
// Read and manipulate tabular data in a spreadsheet-like format.
// Supports formulas, cell references, and data transformations.
// Works with inline data (no file dependency).

const CreateSheetParams = z.object({
  headers: z.array(z.string()).min(1).describe("Column headers"),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe("Row data as 2D array"),
  name: z.string().default("Sheet1").describe("Sheet name"),
});

const FormulaParams = z.object({
  data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe("Table data as 2D array"),
  headers: z.array(z.string()).describe("Column headers"),
  formula: z.string().describe("Formula to apply (e.g. 'SUM(C)', 'AVG(B)', 'C = A * B')"),
});

const PivotParams = z.object({
  data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe("Table data"),
  headers: z.array(z.string()).describe("Column headers"),
  rowField: z.string().describe("Column to use as row labels"),
  valueField: z.string().describe("Column to aggregate"),
  aggFunction: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
});

const spreadsheetOpsSkill: SkillDefinition = {
  name: "spreadsheet_ops",
  version: "1.0.0",

  manifest: {
    id: "spreadsheet_ops",
    name: "Spreadsheet Operations",
    description: "Create, transform, and analyze tabular data with formulas, pivots, and cell operations.",
    category: "transform",
    tools: ["sheet_create", "sheet_formula", "sheet_pivot"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "sheet_create",
      description: "Create a formatted spreadsheet from headers and row data. Returns as structured table.",
      parameters: CreateSheetParams,

      async execute(params) {
        const colWidths = params.headers.map((h, i) => {
          let max = h.length;
          for (const row of params.rows) {
            const val = String(row[i] ?? "");
            if (val.length > max) max = val.length;
          }
          return Math.min(max, 30);
        });

        const formatRow = (cells: Array<string | number | null>) =>
          cells.map((c, i) => String(c ?? "").padEnd(colWidths[i] ?? 10)).join(" | ");

        const headerLine = formatRow(params.headers);
        const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
        const dataLines = params.rows.map((r) => formatRow(r));

        return {
          name: params.name,
          columns: params.headers.length,
          rows: params.rows.length,
          table: [headerLine, separator, ...dataLines].join("\n"),
          data: params.rows.map((row) => {
            const obj: Record<string, string | number | null> = {};
            params.headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
            return obj;
          }),
        };
      },
    });

    ctx.registerTool({
      name: "sheet_formula",
      description: "Apply a formula to spreadsheet data. Supports SUM(col), AVG(col), MIN(col), MAX(col), COUNT(col), and computed columns like 'C = A * B'.",
      parameters: FormulaParams,

      async execute(params) {
        const { data, headers, formula } = params;
        const getCol = (name: string) => {
          const idx = headers.indexOf(name);
          if (idx === -1) return null;
          return data.map((row) => {
            const v = row[idx];
            return typeof v === "number" ? v : parseFloat(String(v ?? ""));
          }).filter((n) => !isNaN(n));
        };

        // Aggregate formulas: SUM(col), AVG(col), etc.
        const aggMatch = formula.match(/^(SUM|AVG|MIN|MAX|COUNT)\((\w+)\)$/i);
        if (aggMatch) {
          const [, fn, colName] = aggMatch;
          const values = getCol(colName!);
          if (!values) return { error: `Column "${colName}" not found. Available: ${headers.join(", ")}` };

          let result: number;
          switch (fn!.toUpperCase()) {
            case "SUM": result = values.reduce((a, b) => a + b, 0); break;
            case "AVG": result = values.reduce((a, b) => a + b, 0) / values.length; break;
            case "MIN": result = Math.min(...values); break;
            case "MAX": result = Math.max(...values); break;
            case "COUNT": result = values.length; break;
            default: return { error: `Unknown function: ${fn}` };
          }

          return { formula, result: Math.round(result * 1000) / 1000, rowsProcessed: values.length };
        }

        // Computed column: NewCol = ColA * ColB
        const computeMatch = formula.match(/^(\w+)\s*=\s*(\w+)\s*([+\-*/])\s*(\w+)$/);
        if (computeMatch) {
          const [, newCol, colA, op, colB] = computeMatch;
          const idxA = headers.indexOf(colA!);
          const idxB = headers.indexOf(colB!);
          if (idxA === -1) return { error: `Column "${colA}" not found.` };
          if (idxB === -1) return { error: `Column "${colB}" not found.` };

          const newHeaders = [...headers, newCol!];
          const newRows = data.map((row) => {
            const a = typeof row[idxA] === "number" ? row[idxA] as number : parseFloat(String(row[idxA] ?? "0"));
            const b = typeof row[idxB] === "number" ? row[idxB] as number : parseFloat(String(row[idxB] ?? "0"));
            let val: number;
            switch (op) {
              case "+": val = a + b; break;
              case "-": val = a - b; break;
              case "*": val = a * b; break;
              case "/": val = b !== 0 ? a / b : 0; break;
              default: val = 0;
            }
            return [...row, Math.round(val * 1000) / 1000];
          });

          return { formula, headers: newHeaders, rows: newRows.slice(0, 100), totalRows: newRows.length };
        }

        return { error: `Unsupported formula: "${formula}". Use SUM(col), AVG(col), MIN(col), MAX(col), COUNT(col), or 'NewCol = ColA op ColB'.` };
      },
    });

    ctx.registerTool({
      name: "sheet_pivot",
      description: "Create a pivot table from spreadsheet data. Groups by a row field and aggregates a value field.",
      parameters: PivotParams,

      async execute(params) {
        const { data, headers } = params;
        const rowIdx = headers.indexOf(params.rowField);
        const valIdx = headers.indexOf(params.valueField);
        if (rowIdx === -1) return { error: `Row field "${params.rowField}" not found.` };
        if (valIdx === -1) return { error: `Value field "${params.valueField}" not found.` };

        const groups = new Map<string, number[]>();
        for (const row of data) {
          const key = String(row[rowIdx] ?? "unknown");
          const val = typeof row[valIdx] === "number" ? row[valIdx] as number : parseFloat(String(row[valIdx] ?? ""));
          if (isNaN(val)) continue;
          const arr = groups.get(key) ?? [];
          arr.push(val);
          groups.set(key, arr);
        }

        const agg = (values: number[]) => {
          switch (params.aggFunction) {
            case "sum": return values.reduce((a, b) => a + b, 0);
            case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
            case "count": return values.length;
            case "min": return Math.min(...values);
            case "max": return Math.max(...values);
          }
        };

        const pivotRows = [...groups.entries()].map(([key, values]) => ({
          [params.rowField]: key,
          [params.aggFunction]: Math.round(agg(values) * 1000) / 1000,
          count: values.length,
        }));

        return { rowField: params.rowField, valueField: params.valueField, aggFunction: params.aggFunction, rows: pivotRows };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "spreadsheet_ops",
      instructions: "You can work with tabular data using `sheet_create` (format data as table), `sheet_formula` (apply SUM/AVG/MIN/MAX/COUNT or computed columns), and `sheet_pivot` (pivot table with grouping).",
    };
  },
};

export default spreadsheetOpsSkill;
