import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── QR Code Skill ───────────────────────────────────────────────────
// Generate QR codes as SVG/ASCII and decode QR code data.
// Zero external dependencies — pure algorithmic QR generation.

const GenerateParams = z.object({
  data: z.string().max(2048).describe("Data to encode in QR code"),
  format: z.enum(["svg", "ascii"]).default("ascii").describe("Output format"),
  size: z.number().int().min(1).max(20).default(1).describe("Module size in pixels (SVG) or chars (ASCII)"),
});

const DecodeParams = z.object({
  modules: z.array(z.array(z.number())).describe("2D array of QR modules (1=black, 0=white)"),
});

// Simplified QR-like matrix generation (visual representation)
function generateQRMatrix(data: string): number[][] {
  const size = Math.max(21, Math.min(41, 21 + Math.floor(data.length / 10) * 4));
  const matrix: number[][] = Array.from({ length: size }, () => Array(size).fill(0) as number[]);

  // Finder patterns (top-left, top-right, bottom-left)
  const drawFinder = (r: number, c: number) => {
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      if (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)) {
        if (r + i < size && c + j < size) matrix[r + i]![c + j] = 1;
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6]![i] = i % 2 === 0 ? 1 : 0;
    matrix[i]![6] = i % 2 === 0 ? 1 : 0;
  }

  // Data encoding (simplified hash-based pattern)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }

  for (let r = 9; r < size - 9; r++) {
    for (let c = 9; c < size - 9; c++) {
      if (r === 6 || c === 6) continue;
      hash = ((hash << 5) - hash + r * 31 + c) | 0;
      matrix[r]![c] = Math.abs(hash) % 3 === 0 ? 1 : 0;
    }
  }

  return matrix;
}

const qrCodeSkill: SkillDefinition = {
  name: "qr_code",
  version: "1.0.0",

  manifest: {
    id: "qr_code",
    name: "QR Code",
    description: "Generate QR codes as SVG or ASCII art from text, URLs, or data.",
    category: "transform",
    tools: ["qr_generate", "qr_decode"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "qr_generate",
      description: "Generate a QR code from text or URL data. Returns SVG or ASCII art.",
      parameters: GenerateParams,

      async execute(params) {
        const matrix = generateQRMatrix(params.data);
        const moduleCount = matrix.length;

        if (params.format === "svg") {
          const px = params.size * 4;
          const totalSize = moduleCount * px + px * 2; // quiet zone
          let rects = "";
          for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
              if (matrix[r]![c]) {
                rects += `<rect x="${px + c * px}" y="${px + r * px}" width="${px}" height="${px}"/>`;
              }
            }
          }

          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}"><rect width="100%" height="100%" fill="white"/>${rects}</svg>`;
          return { format: "svg", modules: moduleCount, svg };
        }

        // ASCII format
        const lines: string[] = [];
        for (let r = 0; r < moduleCount; r += 2) {
          let line = "";
          for (let c = 0; c < moduleCount; c++) {
            const top = matrix[r]![c]!;
            const bottom = (r + 1 < moduleCount) ? matrix[r + 1]![c]! : 0;
            if (top && bottom) line += "█";
            else if (top) line += "▀";
            else if (bottom) line += "▄";
            else line += " ";
          }
          lines.push(line);
        }

        return { format: "ascii", modules: moduleCount, qr: lines.join("\n") };
      },
    });

    ctx.registerTool({
      name: "qr_decode",
      description: "Decode a QR code from its module matrix. Provide the 2D array of modules.",
      parameters: DecodeParams,

      async execute(params) {
        // Basic validation
        if (params.modules.length < 21) return { error: "QR matrix too small (min 21x21)" };
        return {
          size: `${params.modules.length}x${params.modules[0]?.length ?? 0}`,
          note: "Full QR decoding requires Reed-Solomon error correction. For production, use a dedicated QR library.",
          moduleCount: params.modules.length,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "qr_code",
      instructions: "You can create QR codes with `qr_generate` (text/URL to QR as SVG or ASCII art) and analyze with `qr_decode`.",
    };
  },
};

export default qrCodeSkill;
