// ── Typesense filter helpers ─────────────────────────────────────────
// filter_by is a mini query language (&&, ||, :=, [ ], backticks). Values
// interpolated into it must be escaped or a crafted uid such as
// "x || uid:!=x" would widen the filter to every user's documents.

/**
 * Quote a string value for use in a Typesense filter_by expression.
 * Values are wrapped in backticks (Typesense's literal-string quoting);
 * backticks and control characters cannot be represented and are rejected.
 */
export function tsFilterValue(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Typesense filter value must be a non-empty string");
  }
  // eslint-disable-next-line no-control-regex
  if (/[`\u0000-\u001f]/.test(value)) {
    throw new Error("Typesense filter value contains illegal characters");
  }
  return `\`${value}\``;
}

/** Exact-match filter on the uid field. */
export function uidFilter(uid: string): string {
  return `uid:=${tsFilterValue(uid)}`;
}
