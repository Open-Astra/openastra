// ── SQL Guard ───────────────────────────────────────────────────────
// Shared validator + tenant-scoping rewriter for the agent-facing SQL tools
// (sql-query, database_query, sql_query skill).
//
// The previous tools validated a comment-stripped copy of the query and then
// executed the original text, matched tables with a regex, and had no notion
// of tenants: `SELECT * FROM session_messages` returned every user's rows.
//
// This module takes the opposite approach — accept only a small, fully
// understood subset of SQL and make everything else a hard error:
//
//   • one statement, one SELECT, exactly one table in FROM
//   • no comments, no quoted identifiers, no dollar/escape strings
//   • no joins, subqueries, CTEs, set operations, INTO, FOR UPDATE
//   • function calls only from an explicit allowlist
//   • the table must be in SCOPED_TABLES, and its reference is rewritten to
//     a sub-select filtered to the calling user / workspace, so a query can
//     only ever see the caller's own rows
//
// The SQL that is validated is exactly the SQL that is executed (the
// rewritten text is rebuilt from the validated token stream).

export interface SqlScope {
  uid: string;
  workspaceId?: string | null;
}

type ScopeKind = "uid" | "workspace";

interface TableScope {
  kind: ScopeKind;
  /** Predicate over the base table; `$SCOPE` is replaced with the bound param. */
  predicate: string;
}

// Every table an agent may read, with the predicate that confines it to the
// caller. A table without a sound scoping column is simply not listed.
export const SCOPED_TABLES: Readonly<Record<string, TableScope>> = Object.freeze({
  daily_memory: { kind: "uid", predicate: "user_id = $SCOPE" },
  graph_entities: { kind: "uid", predicate: "uid = $SCOPE" },
  graph_edges: { kind: "uid", predicate: "uid = $SCOPE" },
  procedural_memory: { kind: "uid", predicate: "user_id = $SCOPE" },
  skill_metrics: { kind: "uid", predicate: "uid = $SCOPE" },
  sessions: { kind: "uid", predicate: "user_id = $SCOPE" },
  billing_usage: { kind: "uid", predicate: "user_id = $SCOPE" },
  memory_profiles: { kind: "uid", predicate: "user_id = $SCOPE" },
  knowledge_store: { kind: "uid", predicate: "uid = $SCOPE" },
  workspace_members: { kind: "uid", predicate: "user_id = $SCOPE" },
  messages: {
    kind: "uid",
    predicate: "session_id::text IN (SELECT id::text FROM sessions WHERE user_id = $SCOPE)",
  },
  tool_tasks: {
    kind: "uid",
    predicate: "session_id::text IN (SELECT id::text FROM sessions WHERE user_id = $SCOPE)",
  },
  agent_configs: { kind: "workspace", predicate: "workspace_id::text = $SCOPE" },
  agent_config_versions: { kind: "workspace", predicate: "workspace_id::text = $SCOPE" },
});

export const SQL_ALLOWED_TABLES: ReadonlySet<string> = new Set(Object.keys(SCOPED_TABLES));

// Keywords that may never appear (outside string literals).
const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "drop", "alter", "create", "truncate", "grant", "revoke",
  "copy", "execute", "exec", "call", "do", "set", "reset", "show", "explain", "analyze",
  "vacuum", "reindex", "lock", "discard", "comment", "notify", "listen", "unlisten", "load",
  "prepare", "deallocate", "begin", "commit", "rollback", "savepoint", "release",
  "with", "recursive", "union", "intersect", "except", "into", "join", "lateral", "natural",
  "cross", "tablesample", "table", "values", "returning", "for", "fetch", "declare",
  "cursor", "refresh", "cluster", "checkpoint", "security", "merge", "import",
]);

// Words that may legitimately be followed by "(" without being a function.
const PAREN_KEYWORDS = new Set([
  "select", "distinct", "on", "where", "and", "or", "not", "in", "any", "all", "some",
  "by", "having", "when", "then", "else", "case", "between", "like", "ilike", "is",
  "limit", "offset", "over", "filter", "as", "from", "end", "asc", "desc",
]);

// Side-effect-free functions agents can use. Anything else is rejected —
// which is what keeps out pg_read_file, query_to_xml, dblink, set_config,
// current_setting, pg_sleep, lo_*, etc. without having to enumerate them.
const ALLOWED_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "array_agg", "string_agg",
  "jsonb_agg", "json_agg", "stddev", "variance", "percentile_cont", "percentile_disc",
  "row_number", "rank", "dense_rank", "lag", "lead", "first_value", "last_value", "ntile",
  "lower", "upper", "length", "char_length", "trim", "ltrim", "rtrim", "btrim", "substring",
  "substr", "left", "right", "replace", "split_part", "concat", "concat_ws", "position",
  "strpos", "initcap", "md5", "starts_with", "to_char", "format",
  "coalesce", "nullif", "greatest", "least", "cast",
  "round", "abs", "floor", "ceil", "ceiling", "trunc", "mod", "power", "sqrt", "ln", "log", "exp", "sign",
  "now", "date_trunc", "date_part", "extract", "age", "to_timestamp", "to_date", "make_date", "make_interval",
  "jsonb_array_length", "json_array_length", "jsonb_typeof", "json_typeof", "jsonb_extract_path_text",
  "json_extract_path_text", "jsonb_extract_path", "jsonb_build_object", "json_build_object", "to_jsonb", "to_json",
  "array_length", "cardinality", "array_to_string", "unnest_not_allowed_placeholder",
]);
ALLOWED_FUNCTIONS.delete("unnest_not_allowed_placeholder");

const CLAUSE_KEYWORDS = new Set(["where", "group", "order", "having", "limit", "offset", "window"]);

type TokenType = "word" | "string" | "number" | "param" | "punct";
interface Token {
  type: TokenType;
  text: string;
  lower: string;
  depth: number;
}

export type SqlGuardResult =
  | { ok: true; sql: string; params: unknown[]; table: string }
  | { ok: false; error: string };

function fail(error: string): SqlGuardResult {
  return { ok: false, error };
}

function tokenize(query: string): Token[] | string {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const n = query.length;

  while (i < n) {
    const ch = query[i]!;

    if (/\s/.test(ch)) { i++; continue; }

    // Comments are never allowed: they are how validated text and executed
    // text were made to disagree.
    if (ch === "-" && query[i + 1] === "-") return "SQL comments are not allowed";
    if (ch === "/" && query[i + 1] === "*") return "SQL comments are not allowed";
    if (ch === "*" && query[i + 1] === "/") return "SQL comments are not allowed";
    if (ch === ";") return "Only a single statement is allowed (no semicolons)";
    if (ch === '"') return "Double-quoted identifiers are not allowed";
    if (ch === "`") return "Backtick identifiers are not allowed";
    if (ch === "\\") return "Backslashes are not allowed";
    if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) return "Only printable ASCII is allowed in queries";

    if (ch === "'") {
      // Standard string literal with '' escapes. E'' / U&'' / B'' / X''
      // prefixes are rejected below (the preceding word check).
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === "word" && /^(e|u|b|x|n)$/.test(prev.lower) && query[i - 1] !== " ") {
        return "Prefixed string literals (E'', U&'', B'', X'') are not allowed";
      }
      if (query[i - 1] === "&") return "Unicode escape strings are not allowed";
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = query[j]!;
        if (c === "\\") return "Backslashes are not allowed";
        if (c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t") return "Control characters are not allowed";
        if (c === "'") {
          if (query[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return "Unterminated string literal";
      tokens.push({ type: "string", text: query.slice(i, j + 1), lower: "", depth });
      i = j + 1;
      continue;
    }

    if (ch === "$") {
      const m = /^\$(\d+)/.exec(query.slice(i));
      if (!m) return "Dollar-quoted strings are not allowed";
      // `$1$ ... $1$` style dollar quoting
      if (query[i + m[0].length] === "$") return "Dollar-quoted strings are not allowed";
      tokens.push({ type: "param", text: m[0], lower: m[0], depth });
      i += m[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(i))!;
      tokens.push({ type: "word", text: m[0], lower: m[0].toLowerCase(), depth });
      i += m[0].length;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(query.slice(i))!;
      tokens.push({ type: "number", text: m[0], lower: m[0], depth });
      i += m[0].length;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "punct", text: "(", lower: "(", depth });
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth < 0) return "Unbalanced parentheses";
      tokens.push({ type: "punct", text: ")", lower: ")", depth });
      i++;
      continue;
    }

    // Multi-char operators first, then single chars.
    const op = /^(::|<>|!=|<=|>=|\|\||->>|->|#>>|#>|@>|<@|~\*|!~\*|!~|[=<>+\-*/%,.~?@&|!:^\[\]])/.exec(query.slice(i));
    if (!op) return `Unsupported character in query: "${ch}"`;
    tokens.push({ type: "punct", text: op[0], lower: op[0], depth });
    i += op[0].length;
  }

  if (depth !== 0) return "Unbalanced parentheses";
  return tokens;
}

/**
 * Validate a read-only SELECT and rewrite it so it can only see rows that
 * belong to `scope`. Returns the exact SQL + params to execute.
 */
export function guardSelect(
  query: string,
  userParams: unknown[] | undefined,
  scope: SqlScope,
  opts: { limit: number; maxLimit?: number; tables?: ReadonlySet<string> },
): SqlGuardResult {
  if (typeof query !== "string" || query.trim().length === 0) return fail("Query is empty");
  if (query.length > 4000) return fail("Query is too long (max 4000 characters)");
  if (!scope?.uid) return fail("SQL tools require an authenticated user context");

  const tokens = tokenize(query.trim());
  if (typeof tokens === "string") return fail(tokens);
  if (tokens.length === 0) return fail("Query is empty");

  if (tokens[0]!.type !== "word" || tokens[0]!.lower !== "select") {
    return fail("Only SELECT queries are allowed");
  }

  const params = [...(userParams ?? [])];
  let selectCount = 0;
  const topLevelFrom: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];

    if (t.type === "param") {
      const idx = Number(t.text.slice(1));
      if (!Number.isInteger(idx) || idx < 1 || idx > params.length) {
        return fail(`Parameter ${t.text} has no matching value in params`);
      }
      continue;
    }
    if (t.type !== "word") continue;

    if (t.lower === "select") {
      selectCount++;
      if (selectCount > 1) return fail("Subqueries and compound SELECTs are not allowed");
    }
    if (FORBIDDEN_KEYWORDS.has(t.lower)) {
      return fail(`Query contains a forbidden keyword: ${t.text.toUpperCase()}`);
    }
    if (t.lower.startsWith("pg_") || t.lower === "information_schema") {
      return fail("System catalogs and pg_* functions are not accessible");
    }
    if (t.lower === "from" && t.depth === 0) topLevelFrom.push(i);

    // Function call: word immediately followed by "(".
    if (next && next.text === "(" && !PAREN_KEYWORDS.has(t.lower)) {
      if (!ALLOWED_FUNCTIONS.has(t.lower)) {
        return fail(`Function "${t.text}" is not allowed`);
      }
    }
  }

  if (topLevelFrom.length !== 1) {
    return fail("Query must have exactly one FROM clause referencing a single allowed table");
  }

  // ── Table reference ───────────────────────────────────────────────
  const fromIdx = topLevelFrom[0]!;
  let cursor = fromIdx + 1;
  let tableTok = tokens[cursor];
  if (tableTok && tableTok.type === "word" && tableTok.lower === "only") {
    return fail("FROM ONLY is not allowed");
  }
  if (!tableTok || tableTok.type !== "word") return fail("FROM must be followed by a table name");

  let tableStart = cursor;
  if (tokens[cursor + 1]?.text === ".") {
    if (tableTok.lower !== "public") return fail(`Schema "${tableTok.text}" is not accessible`);
    cursor += 2;
    tableTok = tokens[cursor];
    if (!tableTok || tableTok.type !== "word") return fail("FROM must be followed by a table name");
  }
  const tableEnd = cursor; // inclusive
  const table = tableTok.lower;

  const allowed = opts.tables ?? SQL_ALLOWED_TABLES;
  const tableScope = SCOPED_TABLES[table];
  if (!tableScope || !allowed.has(table)) {
    return fail(
      `Table "${table}" is not in the allowed table list. Allowed: ${[...allowed].filter((t) => SCOPED_TABLES[t]).join(", ")}`,
    );
  }

  // Optional alias, then a clause keyword or the end. Anything else (comma
  // join, function call, another table) is rejected.
  cursor = tableEnd + 1;
  let alias: string | null = null;
  let aliasEnd = tableEnd;
  if (tokens[cursor]?.type === "word" && tokens[cursor]!.lower === "as") cursor++;
  const maybeAlias = tokens[cursor];
  if (maybeAlias && maybeAlias.type === "word" && !CLAUSE_KEYWORDS.has(maybeAlias.lower)) {
    alias = maybeAlias.text;
    aliasEnd = cursor;
    cursor++;
  } else if (tokens[tableEnd + 1]?.lower === "as") {
    return fail("AS must be followed by an alias");
  }
  const after = tokens[cursor];
  if (after && !(after.type === "word" && CLAUSE_KEYWORDS.has(after.lower) && after.depth === 0)) {
    return fail("Only a single table is allowed in FROM (no joins or comma-separated tables)");
  }

  // ── Scope binding ─────────────────────────────────────────────────
  let scopeValue: string;
  if (tableScope.kind === "workspace") {
    if (!scope.workspaceId) return fail(`Table "${table}" can only be queried inside a workspace`);
    scopeValue = scope.workspaceId;
  } else {
    scopeValue = scope.uid;
  }
  params.push(scopeValue);
  const scopeParam = `$${params.length}`;
  const scopedSource =
    `(SELECT * FROM ${table} WHERE ${tableScope.predicate.replace(/\$SCOPE/g, scopeParam)}) AS ${alias ?? table}`;

  // ── LIMIT ─────────────────────────────────────────────────────────
  const maxLimit = opts.maxLimit ?? 1000;
  const limit = Math.max(1, Math.min(Math.floor(opts.limit), maxLimit));
  let hasLimit = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === "word" && t.lower === "limit" && t.depth === 0) {
      hasLimit = true;
      const v = tokens[i + 1];
      if (!v || v.type !== "number" || !/^\d+$/.test(v.text)) return fail("LIMIT must be a literal integer");
      if (Number(v.text) > maxLimit) return fail(`LIMIT may not exceed ${maxLimit}`);
    }
  }

  // ── Rebuild from the validated tokens ─────────────────────────────
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i === tableStart) {
      parts.push(scopedSource);
      i = aliasEnd;
      continue;
    }
    parts.push(tokens[i]!.text);
  }
  let sql = joinTokens(parts);
  if (!hasLimit) sql += ` LIMIT ${limit}`;

  return { ok: true, sql, params, table };
}

// Join tokens with single spaces except around "." and "::" (qualified
// names / casts) and before "," / ")" and after "(" for readability.
function joinTokens(parts: string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const prev = parts[i - 1];
    const tight =
      i === 0 || p === "." || prev === "." || p === "::" || prev === "::" ||
      p === "," || p === ")" || prev === "(" || p === "[" || prev === "[" || p === "]";
    out += (tight ? "" : " ") + p;
  }
  return out;
}

/**
 * Run a guarded query inside a READ ONLY transaction with a transaction-
 * local statement timeout (SET LOCAL, so the pooled connection is not left
 * with a modified timeout).
 */
export async function runGuardedSelect(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null; fields?: Array<{ name: string; dataTypeID: number }> }> },
  guarded: { sql: string; params: unknown[] },
  timeoutMs = 10_000,
): Promise<{ rows: unknown[]; rowCount: number; fields: Array<{ name: string; dataTypeID: number }> }> {
  const ms = Math.max(1000, Math.min(Math.floor(timeoutMs), 30_000));
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout = ${ms}`);
    const result = await client.query(guarded.sql, guarded.params);
    await client.query("COMMIT");
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
      fields: (result.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}
