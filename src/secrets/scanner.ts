// ── Secret Scanner ───────────────────────────────────────────────────
// Scans text content for potential secrets before they are persisted to
// memory.  Uses pattern matching and Shannon entropy analysis.
//
// Must NOT throw — if detection fails for any reason, the original
// content is returned unmodified with hasPotentialSecrets: false.

export interface ScanResult {
  hasPotentialSecrets: boolean;
  matches: number;
  sanitized: string;
}

// ── Pattern Definitions ──────────────────────────────────────────────

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // AWS access key IDs
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT tokens (three base64url segments separated by dots)
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // GitHub personal / OAuth / server / refresh tokens
  { name: "github-token", regex: /\bgh[psohr]_[A-Za-z0-9]{36,}\b/g },
  // Stripe live / test secret keys
  { name: "stripe-key", regex: /\b[sr]k_(live|test)_[A-Za-z0-9]{24,}\b/g },
  // AWS temporary access key IDs
  { name: "aws-temp-key", regex: /\bASIA[0-9A-Z]{16}\b/g },
  // Anthropic API keys
  { name: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  // OpenAI / OpenRouter / generic "sk-" API keys (incl. sk-proj-…)
  { name: "openai-key", regex: /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g },
  // xAI and Groq API keys
  { name: "xai-key", regex: /\bxai-[A-Za-z0-9]{20,}\b/g },
  { name: "groq-key", regex: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  // Google API keys
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens and webhook URLs
  { name: "slack-token", regex: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
  { name: "slack-webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  // Notion integration tokens
  { name: "notion-token", regex: /\b(?:secret|ntn)_[A-Za-z0-9]{32,}\b/g },
  // GitHub fine-grained PATs
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  // Telegram bot tokens
  { name: "telegram-bot-token", regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // PEM private keys
  {
    name: "private-key",
    regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  },
  // Credentials embedded in URLs (postgres://user:pass@host)
  { name: "url-credentials", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{3,}@[^\s/]+/gi },
  // key=value style assignments of obviously secret fields
  {
    name: "secret-assignment",
    regex: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  },
];

// ── Shannon Entropy ──────────────────────────────────────────────────

/**
 * Calculate Shannon entropy of a string (bits per character).
 * A uniformly random string of printable characters scores ~6.
 * High-entropy strings (>3.5) that are long enough likely contain
 * encoded secrets (base64, hex, bcrypt, etc.).
 */
function shannonEntropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  let entropy = 0;
  const len = s.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_THRESHOLD = 3.5;
const ENTROPY_MIN_LENGTH = 20;

// Matches candidate tokens: long non-whitespace runs
const TOKEN_RE = /[A-Za-z0-9+/=_\-.]{20,}/g;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD_SEGMENT_RE = /^[A-Za-z_-]+$/;

/**
 * High-entropy-looking tokens that are not secrets: UUIDs, and file paths /
 * hostnames / dotted identifiers (several short, mostly alphabetic segments).
 * Redacting those destroys memory content without protecting anything.
 */
function looksBenign(token: string): boolean {
  if (UUID_RE.test(token)) return true;
  const segments = token.split(/[/.]/).filter((seg) => seg.length > 0);
  if (segments.length < 3) return false;
  if (segments.some((seg) => seg.length >= ENTROPY_MIN_LENGTH)) return false;
  const wordy = segments.filter((seg) => WORD_SEGMENT_RE.test(seg)).length;
  return wordy / segments.length >= 0.6;
}

// ── Redaction Helper ─────────────────────────────────────────────────

/**
 * Redact a matched secret: keep first 4 chars visible for debugging,
 * replace the rest with the marker.
 */
function redact(match: string): string {
  const prefix = match.slice(0, 4);
  return `[REDACTED:${prefix}***]`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Scan `content` for potential secrets.
 * Returns a sanitized version with secrets replaced by redaction markers.
 */
// ── PII Detection (Feature #36) ──────────────────────────────────────

export interface PIIMatch {
  type: string;
  match: string;
  start: number;
  end: number;
}

export interface PIIResult {
  redacted: string;
  found: PIIMatch[];
}

function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, "");
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i]!, 10);
    if (alternate) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

interface PIIPattern {
  type: string;
  regex: RegExp;
  validate?: (match: string) => boolean;
}

const PII_PATTERNS: PIIPattern[] = [
  { type: "EMAIL", regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { type: "PHONE_E164", regex: /\+[1-9]\d{6,14}\b/g },
  { type: "PHONE_US", regex: /\b(?:\(?\d{3}\)?[\s.\-])\d{3}[\s.\-]\d{4}\b/g },
  { type: "SSN", regex: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  {
    type: "CREDIT_CARD",
    regex: /\b(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}(?:\d{3})?\b/g,
    validate: luhnCheck,
  },
  {
    type: "IP_ADDRESS",
    regex: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g,
    validate: (match: string) => match.split(".").map(Number).every((o) => o >= 0 && o <= 255),
  },
  { type: "PASSPORT", regex: /\b[A-Z]{1,2}\d{6,9}\b/g },
  // Date of birth patterns: "DOB: MM/DD/YYYY", "born on YYYY-MM-DD", "date of birth: ..."
  {
    type: "DATE_OF_BIRTH",
    regex: /\b(?:DOB|date\s+of\s+birth|born\s+on|d\.o\.b\.?)\s*[:=]?\s*\d{1,4}[/\-\.]\d{1,2}[/\-\.]\d{1,4}\b/gi,
  },
  // US street addresses: "123 Main St", "456 Elm Avenue", "P.O. Box 789"
  {
    type: "ADDRESS",
    regex: /\b(?:P\.?\s*O\.?\s*Box\s+\d+|\d{1,6}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Pkwy|Parkway|Terr?(?:ace)?))\b\.?/g,
  },
];

export function detectPII(text: string): PIIMatch[] {
  try {
    const results: PIIMatch[] = [];
    for (const pattern of PII_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(text)) !== null) {
        if (pattern.validate && !pattern.validate(m[0])) continue;
        results.push({ type: pattern.type, match: m[0], start: m.index, end: m.index + m[0].length });
      }
    }
    results.sort((a, b) => a.start - b.start);
    const deduped: PIIMatch[] = [];
    let lastEnd = -1;
    for (const r of results) {
      if (r.start >= lastEnd) { deduped.push(r); lastEnd = r.end; }
    }
    return deduped;
  } catch { return []; }
}

export function redactPII(text: string): PIIResult {
  try {
    const found = detectPII(text);
    if (found.length === 0) return { redacted: text, found: [] };
    let redacted = text;
    for (let i = found.length - 1; i >= 0; i--) {
      const pii = found[i]!;
      redacted = redacted.slice(0, pii.start) + `[REDACTED:${pii.type}]` + redacted.slice(pii.end);
    }
    return { redacted, found };
  } catch { return { redacted: text, found: [] }; }
}

/**
 * Redact secrets from text. Convenience wrapper over scanContent().
 */
export function redactSecrets(text: string): string {
  return scanContent(text).sanitized;
}

// ── Public API ───────────────────────────────────────────────────────

export function scanContent(content: string): ScanResult {
  try {
    let sanitized = content;
    let matchCount = 0;

    // 1. Pattern-based matching
    for (const pattern of SECRET_PATTERNS) {
      // Reset lastIndex so repeated calls work correctly
      pattern.regex.lastIndex = 0;
      const newSanitized = sanitized.replace(pattern.regex, (match) => {
        matchCount++;
        return redact(match);
      });
      sanitized = newSanitized;
    }

    // 2. Shannon entropy scan over remaining tokens
    // Re-run on the sanitized string so already-redacted values are skipped
    TOKEN_RE.lastIndex = 0;
    const entropyMatches: Array<{ match: string; start: number; end: number }> = [];

    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(sanitized)) !== null) {
      const token = m[0];
      // Skip redaction markers we already inserted
      if (token.startsWith("[REDACTED:")) continue;
      if (looksBenign(token)) continue;
      if (token.length >= ENTROPY_MIN_LENGTH && shannonEntropy(token) > ENTROPY_THRESHOLD) {
        entropyMatches.push({ match: token, start: m.index, end: m.index + token.length });
      }
    }

    // Apply entropy redactions in reverse order to preserve indices
    for (let i = entropyMatches.length - 1; i >= 0; i--) {
      const em = entropyMatches[i]!;
      sanitized =
        sanitized.slice(0, em.start) + redact(em.match) + sanitized.slice(em.end);
      matchCount++;
    }

    return {
      hasPotentialSecrets: matchCount > 0,
      matches: matchCount,
      sanitized,
    };
  } catch {
    // Never throw — fall back to returning the original content unchanged
    return {
      hasPotentialSecrets: false,
      matches: 0,
      sanitized: content,
    };
  }
}
