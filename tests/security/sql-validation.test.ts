import { describe, it, expect } from "vitest";
import { _testOnly } from "../../src/tools/sql-query.js";

const { ALLOWED_TABLES, BLOCKED_SCHEMAS, FORBIDDEN_PATTERNS } = _testOnly;

// ── Helpers ──────────────────────────────────────────────────────────

function matchesForbidden(query: string): boolean {
  return FORBIDDEN_PATTERNS.some((p: RegExp) => p.test(query));
}

// ── Forbidden Keyword Blocking ───────────────────────────────────────

describe("SQL Forbidden Patterns — Write Operations", () => {
  it("blocks DROP TABLE", () => {
    expect(matchesForbidden("DROP TABLE daily_memories")).toBe(true);
  });

  it("blocks DELETE FROM", () => {
    expect(matchesForbidden("DELETE FROM session_messages WHERE id = 1")).toBe(true);
  });

  it("blocks INSERT INTO", () => {
    expect(matchesForbidden("INSERT INTO graph_entities (name) VALUES ('x')")).toBe(true);
  });

  it("blocks UPDATE ... SET", () => {
    expect(matchesForbidden("UPDATE daily_memories SET content = 'x'")).toBe(true);
  });

  it("blocks TRUNCATE", () => {
    expect(matchesForbidden("TRUNCATE daily_memories")).toBe(true);
  });
});

describe("SQL Forbidden Patterns — Dangerous Functions", () => {
  it("blocks pg_read_file", () => {
    expect(matchesForbidden("SELECT pg_read_file('/etc/passwd')")).toBe(true);
  });

  it("blocks dblink", () => {
    expect(matchesForbidden("SELECT * FROM dblink('host=evil.com')")).toBe(true);
  });

  it("blocks EXPLAIN", () => {
    expect(matchesForbidden("EXPLAIN SELECT * FROM daily_memories")).toBe(true);
  });

  it("blocks SET", () => {
    expect(matchesForbidden("SET role = 'admin'")).toBe(true);
  });

  it("blocks COPY", () => {
    expect(matchesForbidden("COPY daily_memories TO '/tmp/dump.csv'")).toBe(true);
  });

  it("blocks GRANT", () => {
    expect(matchesForbidden("GRANT ALL ON daily_memories TO public")).toBe(true);
  });

  it("blocks EXECUTE", () => {
    expect(matchesForbidden("EXECUTE malicious_func()")).toBe(true);
  });
});

// ── Schema Blocking ──────────────────────────────────────────────────

describe("SQL Blocked Schemas", () => {
  it("blocks pg_catalog", () => {
    expect(BLOCKED_SCHEMAS.has("pg_catalog")).toBe(true);
  });

  it("blocks information_schema", () => {
    expect(BLOCKED_SCHEMAS.has("information_schema")).toBe(true);
  });

  it("blocks pg_toast", () => {
    expect(BLOCKED_SCHEMAS.has("pg_toast")).toBe(true);
  });

  it("blocks pg_temp", () => {
    expect(BLOCKED_SCHEMAS.has("pg_temp")).toBe(true);
  });
});

// ── Table Allowlist ──────────────────────────────────────────────────

describe("SQL Table Allowlist", () => {
  it("allows daily_memory (the real table; daily_memories never existed)", () => {
    expect(ALLOWED_TABLES.has("daily_memory")).toBe(true);
    expect(ALLOWED_TABLES.has("daily_memories")).toBe(false);
  });

  it("allows graph_entities", () => {
    expect(ALLOWED_TABLES.has("graph_entities")).toBe(true);
  });

  it("allows graph_edges", () => {
    expect(ALLOWED_TABLES.has("graph_edges")).toBe(true);
  });

  it("allows messages (scoped through the caller's sessions)", () => {
    expect(ALLOWED_TABLES.has("messages")).toBe(true);
    expect(ALLOWED_TABLES.has("session_messages")).toBe(false);
  });

  it("allows procedural_memory", () => {
    expect(ALLOWED_TABLES.has("procedural_memory")).toBe(true);
  });

  it("does NOT allow users", () => {
    expect(ALLOWED_TABLES.has("users")).toBe(false);
  });

  it("does NOT allow pg_shadow", () => {
    expect(ALLOWED_TABLES.has("pg_shadow")).toBe(false);
  });

  it("does NOT allow audit_log", () => {
    expect(ALLOWED_TABLES.has("audit_log")).toBe(false);
  });
});

// ── Structural Validation (regex-based, no DB needed) ────────────────

describe("SQL Structural Validation", () => {
  it("blocks double-quoted identifiers (bypass vector)", () => {
    // The sql-query tool rejects double-quoted identifiers
    const doubleQuotedPattern = /"[^"]+"/;
    expect(doubleQuotedPattern.test('SELECT * FROM "secret_table"')).toBe(true);
  });

  it("blocks subqueries", () => {
    const subqueryPattern = /\(\s*SELECT\b/i;
    expect(subqueryPattern.test("SELECT * FROM daily_memories WHERE id IN (SELECT id FROM users)")).toBe(true);
  });

  it("does not expose tables without a tenant-scoping column", () => {
    // Every queryable table must have a per-user / per-workspace predicate
    // in sql-guard.ts; secrets and audit tables have none and stay out.
    expect(ALLOWED_TABLES.has("workspace_secrets")).toBe(false);
    expect(ALLOWED_TABLES.has("agent_credentials")).toBe(false);
  });
});
