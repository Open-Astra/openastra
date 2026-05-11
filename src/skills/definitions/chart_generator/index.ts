import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Chart Generator Skill ───────────────────────────────────────────
// Creates ASCII charts and SVG visualizations from data.
// Zero dependencies — generates charts programmatically.

const BarChartParams = z.object({
  labels: z.array(z.string()).min(1).max(30).describe("Category labels"),
  values: z.array(z.number()).min(1).max(30).describe("Numeric values for each label"),
  title: z.string().optional().describe("Chart title"),
  width: z.number().int().min(20).max(80).default(50).describe("Chart width in characters"),
});

const LineChartParams = z.object({
  labels: z.array(z.string()).min(2).max(50).describe("X-axis labels"),
  values: z.array(z.number()).min(2).max(50).describe("Y-axis values"),
  title: z.string().optional().describe("Chart title"),
  height: z.number().int().min(5).max(20).default(10).describe("Chart height in rows"),
});

const PieChartParams = z.object({
  labels: z.array(z.string()).min(1).max(10).describe("Segment labels"),
  values: z.array(z.number().positive()).min(1).max(10).describe("Segment values"),
  title: z.string().optional().describe("Chart title"),
});

const chartGeneratorSkill: SkillDefinition = {
  name: "chart_generator",
  version: "1.0.0",

  manifest: {
    id: "chart_generator",
    name: "Chart Generator",
    description: "Create bar charts, line charts, and pie charts from data. Outputs ASCII art and SVG.",
    category: "transform",
    tools: ["chart_bar", "chart_line", "chart_pie"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "chart_bar",
      description: "Create a horizontal bar chart from labels and values.",
      parameters: BarChartParams,

      async execute(params) {
        const maxVal = Math.max(...params.values, 1);
        const maxLabel = Math.max(...params.labels.map((l) => l.length), 5);

        const lines: string[] = [];
        if (params.title) lines.push(`  ${params.title}`, "");

        for (let i = 0; i < params.labels.length; i++) {
          const label = params.labels[i]!.padStart(maxLabel);
          const val = params.values[i] ?? 0;
          const barLen = Math.round((val / maxVal) * params.width);
          const bar = "█".repeat(barLen);
          lines.push(`${label} │${bar} ${val}`);
        }

        lines.push(" ".repeat(maxLabel) + " └" + "─".repeat(params.width + 6));

        return { chart: lines.join("\n"), type: "bar", dataPoints: params.labels.length };
      },
    });

    ctx.registerTool({
      name: "chart_line",
      description: "Create an ASCII line chart from sequential data points.",
      parameters: LineChartParams,

      async execute(params) {
        const { values, labels, height } = params;
        const maxVal = Math.max(...values);
        const minVal = Math.min(...values);
        const range = maxVal - minVal || 1;

        const grid: string[][] = Array.from({ length: height }, () =>
          Array.from({ length: values.length }, () => " "),
        );

        // Plot points
        for (let x = 0; x < values.length; x++) {
          const y = Math.round(((values[x]! - minVal) / range) * (height - 1));
          const row = height - 1 - y;
          grid[row]![x] = "●";

          // Connect with line to previous point
          if (x > 0) {
            const prevY = Math.round(((values[x - 1]! - minVal) / range) * (height - 1));
            const prevRow = height - 1 - prevY;
            const step = prevRow < row ? 1 : -1;
            for (let r = prevRow + step; r !== row; r += step) {
              if (grid[r]![x - 1] === " ") grid[r]![x - 1] = "│";
            }
          }
        }

        const lines: string[] = [];
        if (params.title) lines.push(`  ${params.title}`, "");

        const yLabelWidth = Math.max(String(Math.round(maxVal)).length, String(Math.round(minVal)).length) + 1;
        for (let r = 0; r < height; r++) {
          const yVal = maxVal - (r / (height - 1)) * range;
          const yLabel = (r === 0 || r === height - 1) ? String(Math.round(yVal)).padStart(yLabelWidth) : " ".repeat(yLabelWidth);
          lines.push(`${yLabel} │${grid[r]!.join("")}`);
        }

        lines.push(" ".repeat(yLabelWidth) + " └" + "─".repeat(values.length));

        // X-axis labels (first, middle, last)
        if (labels.length > 0) {
          const xLine = " ".repeat(yLabelWidth + 2) + labels[0] +
            " ".repeat(Math.max(0, Math.floor(values.length / 2) - (labels[0]?.length ?? 0))) +
            (labels[Math.floor(labels.length / 2)] ?? "") +
            " ".repeat(Math.max(0, values.length - Math.floor(values.length / 2) - (labels[labels.length - 1]?.length ?? 0))) +
            labels[labels.length - 1];
          lines.push(xLine);
        }

        return { chart: lines.join("\n"), type: "line", dataPoints: values.length, min: minVal, max: maxVal };
      },
    });

    ctx.registerTool({
      name: "chart_pie",
      description: "Create a text-based pie chart showing percentage distribution.",
      parameters: PieChartParams,

      async execute(params) {
        const total = params.values.reduce((a, b) => a + b, 0);
        const chars = ["█", "▓", "▒", "░", "▪", "▫", "◆", "◇", "■", "□"];

        const lines: string[] = [];
        if (params.title) lines.push(`  ${params.title}`, "");

        const maxLabel = Math.max(...params.labels.map((l) => l.length), 5);
        const segments = params.labels.map((label, i) => {
          const value = params.values[i] ?? 0;
          const pct = (value / total) * 100;
          const barLen = Math.round(pct / 2);
          return { label, value, pct: Math.round(pct * 10) / 10, bar: (chars[i % chars.length]!).repeat(barLen) };
        });

        for (const seg of segments) {
          lines.push(`${seg.label.padStart(maxLabel)} │${seg.bar} ${seg.pct}% (${seg.value})`);
        }

        lines.push("");
        lines.push(`Total: ${total}`);

        return { chart: lines.join("\n"), type: "pie", segments: segments.map((s) => ({ label: s.label, value: s.value, percent: s.pct })) };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "chart_generator",
      instructions: "You can create charts with `chart_bar` (horizontal bar chart), `chart_line` (line chart), and `chart_pie` (percentage distribution). All output ASCII art.",
    };
  },
};

export default chartGeneratorSkill;
