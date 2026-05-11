import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_CONTRACTS,
  buildContractRetryHint,
  formatContractForPrompt,
  validateAgentOutput,
} from "../../src/agents/output-contracts.js";

describe("output contracts", () => {
  it("parses valid JSON embedded in prose", () => {
    const result = validateAgentOutput(
      "researcher",
      [
        "Here is the structured output:",
        "{",
        '  "findings": ["Market sentiment is improving"],',
        '  "sources": ["https://example.com/report"],',
        '  "confidence": 0.91',
        "}",
        "Thanks.",
      ].join("\n"),
    );

    expect(result.valid).toBe(true);
    expect(result.parsed).toMatchObject({
      findings: ["Market sentiment is improving"],
      sources: ["https://example.com/report"],
      confidence: 0.91,
    });
  });

  it("returns useful retry hints with an example payload", () => {
    const hint = buildContractRetryHint(DEFAULT_OUTPUT_CONTRACTS.researcher, [
      "findings: Required",
      "confidence: Invalid input",
    ]);

    expect(hint).toContain("Output Contract Retry");
    expect(hint).toContain("findings");
    expect(hint).toContain("confidence");
    expect(hint).toContain("Required");
    expect(hint).toContain("```json");
  });

  it("includes the contract description and example in the prompt", () => {
    const prompt = formatContractForPrompt(DEFAULT_OUTPUT_CONTRACTS.writer);

    expect(prompt).toContain("Written content with word count");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"content"');
    expect(prompt).toContain('"wordCount"');
  });
});
