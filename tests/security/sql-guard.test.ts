import { describe, it, expect } from "vitest";
import { guardSelect, SQL_ALLOWED_TABLES } from "../../src/tools/sql-guard.js";

const scope = { uid: "user-1", workspaceId: "ws-1" };
const run = (q: string, params?: unknown[], s = scope) => guardSelect(q, params, s, { limit: 100 });

function expectRejected(q: string, params?: unknown[]) {
  const r = run(q, params);
  expect(r.ok, `expected rejection: ${q}`).toBe(false);
  return r.ok ? "" : r.error;
}

describe("guardSelect — tenant scoping", () => {
  it("rewrites the table to a sub-select filtered to the caller", () => {
    const r = run("SELECT id, name FROM graph_entities WHERE type = 'person'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain("(SELECT * FROM graph_entities WHERE uid = $1) AS graph_entities");
    expect(r.params).toEqual(["user-1"]);
    expect(r.sql).toMatch(/LIMIT 100$/);
  });

  it("appends the scope parameter after caller parameters", () => {
    const r = run("SELECT * FROM sessions s WHERE s.status = $1 ORDER BY s.created_at DESC LIMIT 5", ["active"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain("(SELECT * FROM sessions WHERE user_id = $2) AS s");
    expect(r.params).toEqual(["active", "user-1"]);
    expect(r.sql).not.toMatch(/LIMIT 100/);
  });

  it("scopes messages through the caller's sessions", () => {
    const r = run("SELECT count(*) FROM messages");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sql).toContain("session_id::text IN (SELECT id::text FROM sessions WHERE user_id = $1)");
  });

  it("requires a workspace for workspace-scoped tables", () => {
    const r = guardSelect("SELECT id FROM agent_configs", [], { uid: "user-1" }, { limit: 10 });
    expect(r.ok).toBe(false);
    const ok = run("SELECT id FROM agent_configs");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.params).toEqual(["ws-1"]);
  });

  it("refuses to run without a user", () => {
    expect(guardSelect("SELECT 1 FROM sessions", [], { uid: "" }, { limit: 10 }).ok).toBe(false);
  });

  it("only lists tables that have a scoping predicate", () => {
    for (const t of ["workspace_secrets", "users", "audit_log", "agent_credentials", "pg_shadow"]) {
      expect(SQL_ALLOWED_TABLES.has(t)).toBe(false);
    }
  });
});

describe("guardSelect — the validated text is the executed text", () => {
  it("rejects comments outright (the old strip-then-execute bypass)", () => {
    expectRejected("SELECT * FROM sessions WHERE '--' = '' UNION SELECT secret_value FROM workspace_secrets --'");
    expectRejected("SELECT * FROM sessions -- trailing");
    expectRejected("SELECT * FROM sessions /* x */");
  });

  it("rejects UNION / set operations and extra SELECTs", () => {
    expectRejected("SELECT id FROM sessions UNION SELECT secret_value FROM workspace_secrets");
    expectRejected("SELECT id FROM sessions WHERE id IN (SELECT id FROM users)");
    expectRejected("SELECT (SELECT secret_value FROM workspace_secrets LIMIT 1) FROM sessions");
    expectRejected("SELECT id FROM sessions EXCEPT SELECT id FROM sessions");
  });

  it("rejects CTEs", () => {
    expectRejected("WITH x AS (SELECT * FROM workspace_secrets) SELECT * FROM x");
    expectRejected("SELECT * FROM sessions WHERE id IN (WITH x AS (SELECT 1) SELECT * FROM x)");
  });

  it("rejects joins, comma joins and second tables", () => {
    expectRejected("SELECT * FROM sessions, workspace_secrets");
    expectRejected("SELECT * FROM sessions s JOIN workspace_secrets w ON true");
    expectRejected("SELECT * FROM sessions s, users u WHERE s.user_id = u.id");
    expectRejected("SELECT * FROM sessions CROSS JOIN users");
  });

  it("rejects tables outside the allowlist and system schemas", () => {
    expectRejected("SELECT * FROM workspace_secrets");
    expectRejected("SELECT * FROM users");
    expectRejected("SELECT * FROM pg_catalog.pg_shadow");
    expectRejected("SELECT * FROM information_schema.tables");
    expectRejected("SELECT * FROM billing.sessions");
  });

  it("rejects multiple statements, quoted identifiers and exotic strings", () => {
    expectRejected("SELECT 1 FROM sessions; DROP TABLE sessions");
    expectRejected('SELECT * FROM "workspace_secrets"');
    expectRejected("SELECT $$x$$ FROM sessions");
    expectRejected("SELECT E'\\x41' FROM sessions");
    expectRejected("SELECT * FROM sessions WHERE a = 'unterminated");
  });

  it("rejects functions that are not on the allowlist", () => {
    expectRejected("SELECT query_to_xml('select * from workspace_secrets', true, true, '') FROM sessions");
    expectRejected("SELECT pg_read_file('/etc/passwd') FROM sessions");
    expectRejected("SELECT current_setting('app.secret') FROM sessions");
    expectRejected("SELECT pg_sleep(30) FROM sessions");
    expectRejected("SELECT dblink('host=evil', 'select 1') FROM sessions");
    expectRejected("SELECT set_config('role', 'postgres', false) FROM sessions");
  });

  it("rejects writes and locking clauses", () => {
    expectRejected("DELETE FROM sessions");
    expectRejected("SELECT * INTO evil FROM sessions");
    expectRejected("SELECT * FROM sessions FOR UPDATE");
    expectRejected("UPDATE sessions SET status = 'x'");
  });

  it("rejects parameters without a value and oversized limits", () => {
    expectRejected("SELECT * FROM sessions WHERE id = $1");
    expectRejected("SELECT * FROM sessions LIMIT 100000");
    expectRejected("SELECT * FROM sessions LIMIT $1", [5]);
  });

  it("keeps string literals intact and allows ordinary analytics", () => {
    const r = run(
      "SELECT type, count(*) AS n, avg(reinforcement_score)::numeric FROM graph_entities WHERE name ILIKE '%it''s; -- fine%' GROUP BY type ORDER BY n DESC",
    );
    // a comment marker inside a string literal is data, not a comment
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toContain("'%it''s; -- fine%'");

    const dates = run("SELECT date_trunc('day', created_at) AS d, count(*) FROM sessions WHERE created_at > now() - interval '7 days' GROUP BY d");
    expect(dates.ok).toBe(true);
    const extract = run("SELECT extract(year from created_at) FROM sessions");
    expect(extract.ok).toBe(true);
  });
});
