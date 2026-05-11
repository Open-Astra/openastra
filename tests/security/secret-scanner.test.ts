import { describe, it, expect } from "vitest";
import {
  scanContent,
  redactSecrets,
  detectPII,
  redactPII,
} from "../../src/secrets/scanner.js";
import type { ScanResult, PIIMatch, PIIResult } from "../../src/secrets/scanner.js";

// ── Secret Pattern Detection ────────────────────────────────────────

describe("scanContent — pattern-based detection", () => {
  it("detects AWS access key IDs (AKIA prefix + 16 alphanumeric)", () => {
    const text = "My key is AKIAIOSFODNN7EXAMPLE ok";
    const result = scanContent(text);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.matches).toBeGreaterThanOrEqual(1);
    expect(result.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.sanitized).toContain("[REDACTED:AKIA***]");
  });

  it("detects GitHub personal access tokens (ghp_ prefix)", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    const result = scanContent(`Token: ${token}`);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.sanitized).toContain("[REDACTED:ghp_***]");
    expect(result.sanitized).not.toContain(token);
  });

  it("detects GitHub server tokens (ghs_ prefix)", () => {
    const token = "ghs_1234567890abcdefghijklmnopqrstuvwxyz12";
    const result = scanContent(`server token: ${token}`);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.sanitized).toContain("[REDACTED:ghs_***]");
  });

  it("detects JWT tokens (three base64url segments)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = scanContent(`Authorization: Bearer ${jwt}`);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.sanitized).toContain("[REDACTED:eyJh***]");
    expect(result.sanitized).not.toContain(jwt);
  });

  it("detects multiple secrets in the same content", () => {
    const text = [
      "AWS: AKIAIOSFODNN7EXAMPLE",
      "GitHub: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm",
    ].join("\n");
    const result = scanContent(text);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.matches).toBeGreaterThanOrEqual(2);
    expect(result.sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.sanitized).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  });
});

// ── Shannon Entropy Detection ───────────────────────────────────────

describe("scanContent — Shannon entropy detection", () => {
  it("flags high-entropy strings of sufficient length", () => {
    // A random-looking 32-char base64 string should have high entropy
    const highEntropy = "aB3kL9mP2xQ7rT5wY8zV4nJ6hF1gD0sE";
    const result = scanContent(`config_secret=${highEntropy}`);
    expect(result.hasPotentialSecrets).toBe(true);
    expect(result.sanitized).toContain("[REDACTED:");
  });

  it("does not flag normal English prose", () => {
    const prose =
      "The quick brown fox jumps over the lazy dog and runs away fast.";
    const result = scanContent(prose);
    expect(result.hasPotentialSecrets).toBe(false);
    expect(result.matches).toBe(0);
    expect(result.sanitized).toBe(prose);
  });

  it("does not flag short tokens even if they look random", () => {
    // Under 20 chars — should not trigger entropy check
    const shortToken = "xK9mP2aB3r";
    const result = scanContent(`id: ${shortToken}`);
    // Only the entropy scanner is relevant here; no pattern match either
    expect(result.sanitized).toContain(shortToken);
  });

  it("does not flag low-entropy long strings", () => {
    // Repetitive chars — low entropy despite length
    const lowEntropy = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = scanContent(`value: ${lowEntropy}`);
    expect(result.hasPotentialSecrets).toBe(false);
    expect(result.sanitized).toContain(lowEntropy);
  });
});

// ── Redaction Format ────────────────────────────────────────────────

describe("scanContent — redaction format", () => {
  it("keeps first 4 characters visible and replaces rest with marker", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const result = scanContent(`key: ${key}`);
    // Redaction format: [REDACTED:<first4>***]
    expect(result.sanitized).toContain("[REDACTED:AKIA***]");
  });

  it("redactSecrets convenience function returns sanitized string directly", () => {
    const text = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    const sanitized = redactSecrets(text);
    expect(sanitized).toContain("[REDACTED:ghp_***]");
    expect(typeof sanitized).toBe("string");
  });
});

// ── Safe Content (no false positives) ───────────────────────────────

describe("scanContent — false positive resistance", () => {
  it("does not flag normal short strings", () => {
    const result = scanContent("hello world");
    expect(result.hasPotentialSecrets).toBe(false);
    expect(result.matches).toBe(0);
    expect(result.sanitized).toBe("hello world");
  });

  it("does not flag empty string", () => {
    const result = scanContent("");
    expect(result.hasPotentialSecrets).toBe(false);
    expect(result.sanitized).toBe("");
  });

  it("returns correct ScanResult shape", () => {
    const result = scanContent("test");
    expect(result).toHaveProperty("hasPotentialSecrets");
    expect(result).toHaveProperty("matches");
    expect(result).toHaveProperty("sanitized");
  });
});

// ── PII Detection ───────────────────────────────────────────────────

describe("detectPII", () => {
  it("detects email addresses", () => {
    const matches = detectPII("Contact us at user@example.com for help");
    expect(matches.length).toBe(1);
    expect(matches[0]!.type).toBe("EMAIL");
    expect(matches[0]!.match).toBe("user@example.com");
  });

  it("detects E.164 phone numbers", () => {
    const matches = detectPII("Call me at +14155551234 anytime");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const phone = matches.find((m) => m.type === "PHONE_E164");
    expect(phone).toBeDefined();
    expect(phone!.match).toBe("+14155551234");
  });

  it("detects US-formatted phone numbers", () => {
    const matches = detectPII("Phone: (415) 555-1234 is my number");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const phone = matches.find((m) => m.type === "PHONE_US");
    expect(phone).toBeDefined();
  });

  it("detects valid SSNs and rejects 000/666/9xx area groups", () => {
    // Valid SSN
    const valid = detectPII("SSN: 123-45-6789");
    const ssn = valid.find((m) => m.type === "SSN");
    expect(ssn).toBeDefined();
    expect(ssn!.match).toBe("123-45-6789");

    // 000 area: invalid per SSA rules
    const invalid000 = detectPII("SSN: 000-45-6789");
    expect(invalid000.find((m) => m.type === "SSN")).toBeUndefined();

    // 666 area: invalid per SSA rules
    const invalid666 = detectPII("SSN: 666-45-6789");
    expect(invalid666.find((m) => m.type === "SSN")).toBeUndefined();

    // 9xx area: invalid (reserved for ITIN)
    const invalid9xx = detectPII("SSN: 900-45-6789");
    expect(invalid9xx.find((m) => m.type === "SSN")).toBeUndefined();

    const invalid987 = detectPII("SSN: 987-65-4321");
    expect(invalid987.find((m) => m.type === "SSN")).toBeUndefined();
  });

  it("rejects SSNs with 00 group or 0000 serial", () => {
    const noGroup = detectPII("SSN: 123-00-6789");
    expect(noGroup.find((m) => m.type === "SSN")).toBeUndefined();

    const noSerial = detectPII("SSN: 123-45-0000");
    expect(noSerial.find((m) => m.type === "SSN")).toBeUndefined();
  });

  it("detects credit card numbers passing Luhn validation", () => {
    // Visa test number: 4111 1111 1111 1111 (passes Luhn)
    const matches = detectPII("Card: 4111111111111111");
    const cc = matches.find((m) => m.type === "CREDIT_CARD");
    expect(cc).toBeDefined();
  });

  it("rejects credit card numbers failing Luhn check", () => {
    // Modify last digit so Luhn fails: 4111 1111 1111 1112
    const matches = detectPII("Card: 4111111111111112");
    const cc = matches.find((m) => m.type === "CREDIT_CARD");
    expect(cc).toBeUndefined();
  });

  it("returns empty array for content with no PII", () => {
    const matches = detectPII("The weather is nice today.");
    expect(matches).toEqual([]);
  });

  it("returns matches sorted by start position", () => {
    const text = "Email: a@b.com and SSN: 123-45-6789";
    const matches = detectPII(text);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.start);
    }
  });

  it("includes start and end positions in matches", () => {
    const text = "My email is test@example.org here";
    const matches = detectPII(text);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const email = matches.find((m) => m.type === "EMAIL")!;
    expect(email.start).toBe(text.indexOf("test@example.org"));
    expect(email.end).toBe(email.start + "test@example.org".length);
  });
});

// ── PII Redaction ───────────────────────────────────────────────────

describe("redactPII", () => {
  it("replaces PII with [REDACTED:TYPE] markers", () => {
    const result = redactPII("Email me at user@example.com please");
    expect(result.redacted).toContain("[REDACTED:EMAIL]");
    expect(result.redacted).not.toContain("user@example.com");
    expect(result.found.length).toBeGreaterThanOrEqual(1);
  });

  it("redacts multiple PII types in the same text", () => {
    const text = "Name test@example.com SSN 123-45-6789 phone +14155551234";
    const result = redactPII(text);
    expect(result.redacted).toContain("[REDACTED:EMAIL]");
    expect(result.redacted).toContain("[REDACTED:SSN]");
    expect(result.found.length).toBeGreaterThanOrEqual(2);
  });

  it("returns original text unchanged when no PII found", () => {
    const text = "Just a normal sentence with nothing sensitive.";
    const result = redactPII(text);
    expect(result.redacted).toBe(text);
    expect(result.found).toEqual([]);
  });

  it("returns PIIResult shape with redacted string and found array", () => {
    const result = redactPII("test");
    expect(result).toHaveProperty("redacted");
    expect(result).toHaveProperty("found");
    expect(Array.isArray(result.found)).toBe(true);
  });
});
