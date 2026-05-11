// ── Multi-modal Message Input Types ─────────────────────────────────
// Normalizes various input formats to a single string for agent loops.
// Also provides structured content part extraction for vision-capable models.

import type { ContentPart } from "../inference/types.js";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string };

export type MessageInput =
  | string
  | { type: "text"; text: string }
  | { type: "image_url"; url: string }
  | MessagePart[];

/**
 * Normalize a MessageInput to a plain text string for persistence
 * and context assembly. Image URLs are represented as placeholders.
 */
export function normalizeMessageInput(input: MessageInput): string {
  if (typeof input === "string") return input;

  if (Array.isArray(input)) {
    return input
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image_url") return `[image: ${part.url}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Single part object
  if (input.type === "text") return input.text;
  if (input.type === "image_url") return `[image: ${input.url}]`;

  return "";
}

/**
 * Convert a MessageInput to OpenAI-compatible content parts for vision models.
 * Returns null if there are no image parts (caller should use plain string).
 */
export function toContentParts(input: MessageInput): ContentPart[] | null {
  if (typeof input === "string") return null;

  if (Array.isArray(input)) {
    const hasImages = input.some((p) => p.type === "image_url");
    if (!hasImages) return null;

    return input.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      return {
        type: "image_url" as const,
        image_url: { url: part.url, detail: "auto" as const },
      };
    });
  }

  if (input.type === "image_url") {
    return [{ type: "image_url" as const, image_url: { url: input.url, detail: "auto" as const } }];
  }

  return null;
}

/**
 * Check whether a MessageInput contains any images.
 */
export function hasImageContent(input: MessageInput): boolean {
  if (typeof input === "string") return false;
  if (Array.isArray(input)) return input.some((p) => p.type === "image_url");
  return input.type === "image_url";
}

/**
 * Extract just the text portions from a MessageInput (for persistence).
 */
export function extractText(input: MessageInput): string {
  if (typeof input === "string") return input;

  if (Array.isArray(input)) {
    return input
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  if (input.type === "text") return input.text;
  return "";
}
