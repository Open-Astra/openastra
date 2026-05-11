// Prompt injection detection — pattern library for common attack vectors

export interface InjectionScanResult {
  detected: boolean;
  patterns: string[];
  severity: "low" | "medium" | "high";
}

// Common prompt injection patterns
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string; severity: "low" | "medium" | "high" }> = [
  { pattern: /ignore\s+(?:previous|all|above)\s+instructions/i, label: "instruction_ignore", severity: "high" },
  { pattern: /you\s+are\s+now\s+(?:a|an)\s+(?:different|new|jailbreak)/i, label: "role_override", severity: "high" },
  { pattern: /pretend\s+(?:you\s+are|to\s+be)\s+(?:a|an)\s+(?:different|jailbreak|evil)/i, label: "persona_hijack", severity: "high" },
  { pattern: /\bDAN\b|\bjailbreak\b|\bdan\s+mode\b/i, label: "jailbreak_template", severity: "high" },
  { pattern: /system\s*:\s*you\s+are/i, label: "system_prompt_injection", severity: "high" },
  { pattern: /\/system\b|<system>/i, label: "delimiter_injection", severity: "medium" },
  { pattern: /base64[,\s]*decode\s*\(/i, label: "encoded_instruction", severity: "medium" },
  { pattern: /eval\s*\(|exec\s*\(/i, label: "code_injection", severity: "medium" },
  { pattern: /disregard\s+(?:your|all)\s+(?:instructions|guidelines|rules)/i, label: "instruction_disregard", severity: "high" },
  { pattern: /act\s+as\s+if\s+you\s+(?:have\s+no|don't\s+have)\s+(?:restrictions|limits)/i, label: "restriction_bypass", severity: "high" },
];

// Detect base64-encoded instructions
function hasEncodedInstructions(text: string): boolean {
  const b64Matches = text.match(/[A-Za-z0-9+/]{20,}={0,2}/g) ?? [];
  for (const match of b64Matches) {
    try {
      const decoded = Buffer.from(match, "base64").toString("utf8");
      if (/instruction|ignore|system|pretend|jailbreak/i.test(decoded)) {
        return true;
      }
    } catch {
      // not valid base64
    }
  }
  return false;
}

export function detectPromptInjection(message: string): InjectionScanResult {
  const foundPatterns: string[] = [];
  let maxSeverity: "low" | "medium" | "high" = "low";

  for (const { pattern, label, severity } of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      foundPatterns.push(label);
      if (severity === "high") maxSeverity = "high";
      else if (severity === "medium" && maxSeverity !== "high") maxSeverity = "medium";
    }
  }

  if (hasEncodedInstructions(message)) {
    foundPatterns.push("encoded_instruction_b64");
    maxSeverity = "high";
  }

  return {
    detected: foundPatterns.length > 0,
    patterns: foundPatterns,
    severity: foundPatterns.length > 0 ? maxSeverity : "low",
  };
}
