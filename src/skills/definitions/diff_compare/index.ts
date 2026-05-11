import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Diff Compare Skill ──────────────────────────────────────────────
// Compare two texts and show differences. Supports line-by-line
// unified diff and word-level comparison.

const DiffParams = z.object({
  textA: z.string().describe("First text (original)"),
  textB: z.string().describe("Second text (modified)"),
  context: z.number().int().min(0).max(10).default(3).describe("Lines of context around changes"),
  labelA: z.string().default("original").describe("Label for first text"),
  labelB: z.string().default("modified").describe("Label for second text"),
});

const SimilarityParams = z.object({
  textA: z.string().describe("First text"),
  textB: z.string().describe("Second text"),
});

function computeLCS(a: string[], b: string[]): boolean[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  // Backtrack to find which lines are in the LCS
  const inLCS: boolean[][] = [
    Array(m).fill(false) as boolean[],
    Array(n).fill(false) as boolean[],
  ];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      inLCS[0]![i - 1] = true;
      inLCS[1]![j - 1] = true;
      i--; j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  return inLCS;
}

const diffCompareSkill: SkillDefinition = {
  name: "diff_compare",
  version: "1.0.0",

  manifest: {
    id: "diff_compare",
    name: "Diff Compare",
    description: "Compare two texts and show differences in unified diff format. Also calculates similarity score.",
    category: "analyze",
    tools: ["diff_unified", "diff_similarity"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "diff_unified",
      description: "Generate a unified diff between two texts showing additions, removals, and context.",
      parameters: DiffParams,

      async execute(params) {
        const linesA = params.textA.split("\n");
        const linesB = params.textB.split("\n");
        const inLCS = computeLCS(linesA, linesB);

        const changes: Array<{ type: "add" | "remove" | "context"; line: string; lineA?: number; lineB?: number }> = [];
        let ia = 0, ib = 0;

        while (ia < linesA.length || ib < linesB.length) {
          if (ia < linesA.length && inLCS[0]![ia] && ib < linesB.length && inLCS[1]![ib]) {
            changes.push({ type: "context", line: linesA[ia]!, lineA: ia + 1, lineB: ib + 1 });
            ia++; ib++;
          } else if (ia < linesA.length && !inLCS[0]![ia]) {
            changes.push({ type: "remove", line: linesA[ia]!, lineA: ia + 1 });
            ia++;
          } else if (ib < linesB.length && !inLCS[1]![ib]) {
            changes.push({ type: "add", line: linesB[ib]!, lineB: ib + 1 });
            ib++;
          } else {
            break;
          }
        }

        // Format as unified diff
        const diffLines: string[] = [
          `--- ${params.labelA}`,
          `+++ ${params.labelB}`,
        ];

        let lastChangeIdx = -Infinity;
        for (let c = 0; c < changes.length; c++) {
          const change = changes[c]!;
          if (change.type !== "context") {
            // Show context before
            for (let k = Math.max(0, c - params.context); k < c; k++) {
              if (k > lastChangeIdx && changes[k]!.type === "context") {
                diffLines.push(` ${changes[k]!.line}`);
              }
            }
            // Show change
            if (change.type === "remove") diffLines.push(`-${change.line}`);
            else diffLines.push(`+${change.line}`);
            lastChangeIdx = c;

            // Show context after
            for (let k = c + 1; k <= Math.min(changes.length - 1, c + params.context); k++) {
              if (changes[k]!.type === "context") {
                diffLines.push(` ${changes[k]!.line}`);
                lastChangeIdx = k;
              }
            }
          }
        }

        const additions = changes.filter((c) => c.type === "add").length;
        const removals = changes.filter((c) => c.type === "remove").length;

        return {
          diff: diffLines.join("\n"),
          additions,
          removals,
          unchanged: changes.filter((c) => c.type === "context").length,
          linesA: linesA.length,
          linesB: linesB.length,
        };
      },
    });

    ctx.registerTool({
      name: "diff_similarity",
      description: "Calculate similarity score between two texts (0-100%).",
      parameters: SimilarityParams,

      async execute(params) {
        const a = params.textA;
        const b = params.textB;

        // Levenshtein distance at word level
        const wordsA = a.toLowerCase().split(/\s+/);
        const wordsB = b.toLowerCase().split(/\s+/);
        const m = wordsA.length;
        const n = wordsB.length;

        if (m === 0 && n === 0) return { similarity: 100, distance: 0 };

        const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => {
          const row = Array(n + 1).fill(0) as number[];
          row[0] = i;
          return row;
        });
        for (let j = 0; j <= n; j++) dp[0]![j] = j;

        for (let i = 1; i <= m; i++) {
          for (let j = 1; j <= n; j++) {
            const cost = wordsA[i - 1] === wordsB[j - 1] ? 0 : 1;
            dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
          }
        }

        const distance = dp[m]![n]!;
        const maxLen = Math.max(m, n);
        const similarity = maxLen > 0 ? Math.round((1 - distance / maxLen) * 10000) / 100 : 100;

        return {
          similarity,
          distance,
          wordsA: m,
          wordsB: n,
          interpretation: similarity >= 80 ? "very similar" : similarity >= 50 ? "somewhat similar" : similarity >= 20 ? "different" : "very different",
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "diff_compare",
      instructions: "You can compare texts with `diff_unified` (show line-by-line differences in unified diff format) and `diff_similarity` (calculate similarity percentage).",
    };
  },
};

export default diffCompareSkill;
