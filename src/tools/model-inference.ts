import { z } from "zod";
import { registerTool } from "./registry.js";

// ── model_inference ─────────────────────────────────────────────────
// Runs the 225-feature prediction model against a specific prop.
// Returns predicted probability, confidence interval, and the top
// features driving the prediction.
//
// Supports two modes:
//   1. External HTTP service (MODEL_INFERENCE_URL env var)
//   2. Fallback stub when no service is configured

const MODEL_URL = process.env.MODEL_INFERENCE_URL || "";
const MODEL_API_KEY = process.env.MODEL_INFERENCE_API_KEY || "";
const MODEL_TIMEOUT_MS = parseInt(process.env.MODEL_INFERENCE_TIMEOUT || "10000", 10);

const ModelInferenceParams = z.object({
  playerName: z.string().describe("Player name"),
  market: z.string().describe("Prop market type, e.g. 'points', 'rebounds'"),
  line: z.number().describe("The line to evaluate (e.g., 24.5)"),
  direction: z.enum(["over", "under"]).describe("Which side to evaluate"),
  sport: z
    .enum(["nba", "nfl", "mlb", "nhl"])
    .optional()
    .describe("Sport"),
  features: z
    .record(z.string(), z.number())
    .optional()
    .describe("Optional pre-computed feature overrides"),
});

registerTool({
  name: "model_inference",
  description:
    "Run the Astra 225-feature prediction model on a specific player prop. Returns the model's predicted probability, confidence interval, and the top features influencing the prediction. Premium-only tool.",
  parameters: ModelInferenceParams,

  async execute(params, _ctx) {
    // If no model service URL is configured, return a helpful stub
    if (!MODEL_URL) {
      return {
        player: params.playerName,
        market: params.market,
        line: params.line,
        direction: params.direction,
        prediction: {
          probability: 0.0,
          confidenceInterval: { low: 0.0, high: 0.0 },
          sampleSize: 0,
          modelVersion: "v0-stub",
        },
        topFeatures: [],
        message: `Model inference for ${params.playerName} ${params.market} ${params.direction} ${params.line} — set MODEL_INFERENCE_URL to connect to prediction service.`,
      };
    }

    // Call the external prediction service
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

    try {
      const body = {
        player: params.playerName,
        market: params.market,
        line: params.line,
        direction: params.direction,
        sport: params.sport ?? "nba",
        features: params.features ?? {},
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (MODEL_API_KEY) {
        headers["Authorization"] = `Bearer ${MODEL_API_KEY}`;
      }

      const response = await fetch(`${MODEL_URL}/predict`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "unknown");
        return {
          player: params.playerName,
          market: params.market,
          line: params.line,
          direction: params.direction,
          error: `Model service returned ${response.status}: ${errText}`,
          prediction: null,
        };
      }

      const result = await response.json() as {
        probability: number;
        confidence_interval: { low: number; high: number };
        sample_size: number;
        model_version: string;
        top_features: Array<{ name: string; importance: number; value: number }>;
      };

      return {
        player: params.playerName,
        market: params.market,
        line: params.line,
        direction: params.direction,
        prediction: {
          probability: result.probability,
          confidenceInterval: result.confidence_interval,
          sampleSize: result.sample_size,
          modelVersion: result.model_version,
        },
        topFeatures: result.top_features ?? [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        player: params.playerName,
        market: params.market,
        line: params.line,
        direction: params.direction,
        error: message.includes("aborted")
          ? `Model service timed out after ${MODEL_TIMEOUT_MS}ms`
          : `Model service error: ${message}`,
        prediction: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
