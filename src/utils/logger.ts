// ── Astra Gateway Logger ────────────────────────────────────────────
// Celestial blue themed terminal output. Every gateway log line gets
// styled with a cohesive ANSI color palette inspired by deep space.
//
// Colors:
//   Celestial blue (38;5;39)  — primary accent, service prefixes
//   Ice blue (38;5;117)       — secondary, URLs and paths
//   Star white (1;97)         — bold highlights, values
//   Nebula cyan (38;5;45)     — success states, "active" indicators
//   Dim (2)                   — timestamps, secondary info
//   Amber (38;5;214)          — warnings
//   Soft red (38;5;203)       — errors

// ── ANSI Escape Codes ─────────────────────────────────────────────

const ESC = "\x1b[";

// Core palette
const CELESTIAL = `${ESC}38;5;39m`;    // dodger blue — primary
const ICE = `${ESC}38;5;117m`;         // light sky blue — paths/URLs
const STAR = `${ESC}1;97m`;            // bold bright white — values
const NEBULA = `${ESC}38;5;45m`;       // turquoise — success
const DIM = `${ESC}2m`;                // dim — secondary
const AMBER = `${ESC}38;5;214m`;       // amber — warnings
const SOFT_RED = `${ESC}38;5;203m`;    // coral — errors
const BOLD = `${ESC}1m`;
const R = `${ESC}0m`;                  // reset

// Gradient blues for the banner
const B5 = `${ESC}38;5;39m`;   // dodger blue
const B6 = `${ESC}38;5;45m`;   // turquoise
const B7 = `${ESC}38;5;117m`;  // light sky

// ── Exports for external use ──────────────────────────────────────

export const colors = {
  celestial: CELESTIAL,
  ice: ICE,
  star: STAR,
  nebula: NEBULA,
  dim: DIM,
  amber: AMBER,
  red: SOFT_RED,
  bold: BOLD,
  reset: R,
} as const;

// ── ASCII Banner ──────────────────────────────────────────────────

export function printBanner(): void {
  const lines = [
    ``,
    `${B5}     ░█▀█░█▀▀░▀█▀░█▀▄░█▀█${R}`,
    `${B5}     ░█▀█░▀▀█░░█░░█▀▄░█▀█${R}`,
    `${B6}     ░▀░▀░▀▀▀░░▀░░▀░▀░▀░▀${R}`,
    `${B7}      ✦ Agent Gateway ✦${R}`,
    ``,
  ];
  console.log(lines.join("\n"));
}

// ── Quiet Mode ───────────────────────────────────────────────────
// Standalone CLI sets ASTRA_STANDALONE before imports. In quiet mode,
// only warnings and errors are printed — info/active/inactive/kv/dim
// are suppressed to keep the REPL output clean.

const QUIET = () => !!process.env.ASTRA_STANDALONE;

// ── Prefix Formatter ──────────────────────────────────────────────

function prefix(tag: string): string {
  return `${CELESTIAL}[${STAR}${tag}${CELESTIAL}]${R}`;
}

// ── Log Scrubbing ─────────────────────────────────────────────────
// Scrubs secrets and PII from log output to prevent accidental leaks.
// Only imports scanner lazily to avoid circular dependency at startup.

let _scannerLoaded = false;
let _redactSecretsFn: ((text: string) => string) | null = null;
let _redactPIIFn: ((text: string) => { redacted: string; found: unknown[] }) | null = null;

function loadScrubber(): void {
  if (_scannerLoaded) return;
  _scannerLoaded = true;
  // Trigger async import — first call won't scrub, but subsequent calls will.
  // This avoids circular dependency issues and works in ESM.
  import("../secrets/scanner.js").then((scanner) => {
    _redactSecretsFn = scanner.redactSecrets ?? null;
    _redactPIIFn = scanner.redactPII ?? null;
  }).catch(() => {
    // Scanner not yet available — will try again next call
    _scannerLoaded = false;
  });
}

// Quick check: could this string possibly contain sensitive data?
// Avoids running expensive regex on short/simple strings.
function mightContainSensitive(s: string): boolean {
  return s.length > 12 && /[@\d\-\.+\/=_]/.test(s);
}

/**
 * Scrub a single string value of secrets and PII.
 */
export function scrubLogOutput(message: string): string {
  if (!mightContainSensitive(message)) return message;
  loadScrubber();
  let result = message;
  if (_redactSecretsFn) {
    result = _redactSecretsFn(result);
  }
  // Only scrub PII if policy is not "off" (check env var directly to avoid circular import)
  const piiPolicy = process.env.PII_DETECTION_POLICY;
  if (piiPolicy && piiPolicy !== "off" && piiPolicy !== "allow" && _redactPIIFn) {
    result = _redactPIIFn(result).redacted;
  }
  return result;
}

/**
 * Scrub an argument that may be a string, object, or other value.
 */
function scrubArg(arg: unknown): unknown {
  if (typeof arg === "string") return scrubLogOutput(arg);
  if (arg instanceof Error) return arg; // Don't modify Error objects
  if (arg !== null && typeof arg === "object") {
    try {
      const json = JSON.stringify(arg);
      if (mightContainSensitive(json)) {
        const scrubbed = scrubLogOutput(json);
        if (scrubbed !== json) {
          return JSON.parse(scrubbed);
        }
      }
    } catch {
      // Non-serializable object — return as-is
    }
  }
  return arg;
}

function scrubArgs(args: unknown[]): unknown[] {
  return args.map(scrubArg);
}

// ── Log Functions ─────────────────────────────────────────────────

/** Standard info log with celestial-styled prefix */
export function info(tag: string, ...args: unknown[]): void {
  if (QUIET()) return;
  console.log(prefix(tag), ...scrubArgs(args));
}

/** Highlight a key-value pair (value in star white) */
export function kv(tag: string, key: string, value: unknown): void {
  if (QUIET()) return;
  const scrubbedValue = typeof value === "string" ? scrubLogOutput(value) : value;
  console.log(prefix(tag), `${DIM}${key}:${R} ${STAR}${scrubbedValue}${R}`);
}

/** Log a feature/service as active (turquoise checkmark) */
export function active(tag: string, feature: string, detail?: string): void {
  if (QUIET()) return;
  const extra = detail ? ` ${DIM}(${detail})${R}` : "";
  console.log(prefix(tag), `${NEBULA}✓${R} ${feature}${extra}`);
}

/** Log a feature/service as inactive or skipped */
export function inactive(tag: string, feature: string, reason?: string): void {
  if (QUIET()) return;
  const extra = reason ? ` ${DIM}— ${reason}${R}` : "";
  console.log(prefix(tag), `${DIM}○ ${feature}${extra}${R}`);
}

/** Warning log (amber) */
export function warn(tag: string, ...args: unknown[]): void {
  console.warn(prefix(tag), `${AMBER}⚠${R}`, ...scrubArgs(args));
}

/** Error log (soft red) */
export function error(tag: string, ...args: unknown[]): void {
  console.error(prefix(tag), `${SOFT_RED}✗${R}`, ...scrubArgs(args));
}

/** Dim secondary info */
export function dim(tag: string, ...args: unknown[]): void {
  if (QUIET()) return;
  const scrubbed = scrubArgs(args);
  console.log(prefix(tag), `${DIM}${scrubbed.join(" ")}${R}`);
}

/** Section divider */
export function divider(): void {
  console.log(`${B5}    ─────────────────────────────────────────${R}`);
}

/** Startup summary line — used for the connection info block */
export function connection(tag: string, label: string, url: string): void {
  console.log(prefix(tag), `${DIM}${label}${R} ${ICE}${url}${R}`);
}

/** Create a logger bound to a specific tag (for use in modules) */
export function createLogger(tag: string) {
  return {
    info: (...args: unknown[]) => info(tag, ...args),
    kv: (key: string, value: unknown) => kv(tag, key, value),
    active: (feature: string, detail?: string) => active(tag, feature, detail),
    inactive: (feature: string, reason?: string) => inactive(tag, feature, reason),
    warn: (...args: unknown[]) => warn(tag, ...args),
    error: (...args: unknown[]) => error(tag, ...args),
    dim: (...args: unknown[]) => dim(tag, ...args),
    connection: (label: string, url: string) => connection(tag, label, url),
  };
}
