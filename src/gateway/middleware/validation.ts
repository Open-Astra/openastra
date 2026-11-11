// ── Small request-validation helpers ────────────────────────────────

/**
 * Parse a `limit`-style query value into a bounded positive integer.
 * Anything missing, non-numeric or out of range collapses to a safe value
 * so a caller cannot ask the database for an unbounded result set.
 */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === "") return Math.min(fallback, max);
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.min(fallback, max);
  return Math.min(Math.max(1, Math.trunc(n)), max);
}
