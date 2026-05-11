import { z } from "zod";
import { registerTool } from "./registry.js";
import { getEventBus } from "../events/index.js";

// ── clarify ─────────────────────────────────────────────────────────
// Lets the agent ask the user a clarification question before proceeding.
// The tool does NOT block — it emits a `clarification_requested` event,
// returns immediately with the question text, and the actual answer
// arrives in the next user message.

const ClarifyParams = z.object({
  question: z.string().describe("The clarification question to ask the user"),
  options: z
    .array(z.string())
    .optional()
    .describe("Optional suggested answer choices for the user"),
});

registerTool({
  name: "clarify",
  description:
    "Ask the user a clarification question before proceeding. Returns immediately — the answer will come in the user's next message. Use this when you need more information to give an accurate response.",
  parameters: ClarifyParams,

  async execute(params, ctx) {
    const { question, options } = params;

    // Emit clarification event on the bus so clients can render the question
    const bus = getEventBus();
    bus.emit("clarification.requested" as any, {
      uid: ctx?.uid ?? "unknown",
      agentId: ctx?.agentId ?? "unknown",
      sessionId: ctx?.sessionId ?? "unknown",
      question,
      options: options ?? [],
      timestamp: Date.now(),
    });

    // Build the response content
    let content = `[Clarification requested] ${question}`;
    if (options && options.length > 0) {
      content += `\nSuggested options: ${options.join(", ")}`;
    }

    return {
      content,
      question,
      options: options ?? [],
      status: "awaiting_user_response",
    };
  },
});
