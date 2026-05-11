// ── Heartbeat Runner ─────────────────────────────────────────────────
// Fetches data from external sources (http, rss, github, linear) on a
// schedule, runs the result through the agent loop, and persists the output.

import { getPool } from "../config/postgres.js";
import { runAgentLoop } from "../agents/loop.js";
import { getAgentConfig } from "../config/agents.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import type { InferenceClient } from "../inference/types.js";
import type { AgentConfig } from "../agents/types.js";

const log = createLogger("heartbeat");

// ── Types ─────────────────────────────────────────────────────────────

interface HeartbeatConfigRow {
  id: string;
  name: string;
  uid: string | null;
  workspace_id: string | null;
  agent_id: string;
  type: "rss" | "http" | "github" | "linear";
  url: string | null;
  config: Record<string, unknown>;
  interval_minutes: number;
  prompt: string | null;
  enabled: boolean;
  last_run_at: Date | null;
}

interface FetchResult {
  status: "ok" | "changed" | "error";
  data: Record<string, unknown>;
}

// ── HTTP Fetcher ──────────────────────────────────────────────────────

async function fetchHttp(row: HeartbeatConfigRow): Promise<FetchResult> {
  const url = row.url ?? "";
  const expectedStatus = (row.config.expectedStatus as number) ?? 200;
  const start = Date.now();

  try {
    // SSRF check at execution time (not just creation time) to prevent DNS rebinding
    if (await isBlockedUrl(url)) {
      return { status: "error", data: { url, error: "SSRF: URL targets a blocked internal host" } };
    }
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    const latencyMs = Date.now() - start;
    const status = resp.status === expectedStatus ? "ok" : "changed";

    return {
      status,
      data: {
        url,
        statusCode: resp.status,
        expectedStatus,
        latencyMs,
        ok: resp.ok,
      },
    };
  } catch (err) {
    return {
      status: "error",
      data: { url, error: String(err) },
    };
  }
}

// ── RSS Fetcher ───────────────────────────────────────────────────────

async function fetchRss(row: HeartbeatConfigRow): Promise<FetchResult> {
  const url = row.url ?? "";

  try {
    // SSRF check at execution time to prevent DNS rebinding
    if (await isBlockedUrl(url)) {
      return { status: "error", data: { url, error: "SSRF: URL targets a blocked internal host" } };
    }
    const resp = await fetch(url, {
      headers: { "User-Agent": "Astra/1.0 Heartbeat Monitor" },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });

    if (!resp.ok) {
      return {
        status: "error",
        data: { url, statusCode: resp.status },
      };
    }

    const text = await resp.text();
    const items: Array<{ title: string; link: string; pubDate: string }> = [];

    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

    const parseBlock = (block: string) => {
      const titleMatch = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/is);
      const linkMatch = block.match(/<link[^>]*href="([^"]+)"|<link[^>]*>(https?:\/\/[^<]+)<\/link>/i);
      const dateMatch = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>|<published[^>]*>(.*?)<\/published>|<updated[^>]*>(.*?)<\/updated>/is);
      return {
        title: (titleMatch?.[1] ?? titleMatch?.[2] ?? "Untitled").trim(),
        link: (linkMatch?.[1] ?? linkMatch?.[2] ?? "").trim(),
        pubDate: (dateMatch?.[1] ?? dateMatch?.[2] ?? dateMatch?.[3] ?? "").trim(),
      };
    };

    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
      items.push(parseBlock(match[1]!));
    }
    while ((match = entryRegex.exec(text)) !== null && items.length < 5) {
      items.push(parseBlock(match[1]!));
    }

    return {
      status: "ok",
      data: { url, items, count: items.length },
    };
  } catch (err) {
    return {
      status: "error",
      data: { url, error: String(err) },
    };
  }
}

// ── GitHub Fetcher ────────────────────────────────────────────────────

async function fetchGithub(row: HeartbeatConfigRow): Promise<FetchResult> {
  const repo = (row.config.repo as string) ?? row.url ?? "";
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Astra/1.0 Heartbeat Monitor",
        "Accept": "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.status === 404) {
      return {
        status: "ok",
        data: { repo, message: "No releases found" },
      };
    }

    if (!resp.ok) {
      return {
        status: "error",
        data: { repo, statusCode: resp.status },
      };
    }

    const release = await resp.json() as Record<string, unknown>;

    return {
      status: "ok",
      data: {
        repo,
        tag: release.tag_name,
        name: release.name,
        publishedAt: release.published_at,
        htmlUrl: release.html_url,
        body: typeof release.body === "string" ? release.body.slice(0, 500) : "",
      },
    };
  } catch (err) {
    return {
      status: "error",
      data: { repo, error: String(err) },
    };
  }
}

// ── Linear Fetcher ───────────────────────────────────────────────────

async function fetchLinear(row: HeartbeatConfigRow): Promise<FetchResult> {
  const apiKey = row.config.apiKey as string | undefined;
  const labelPrefix = (row.config.labelPrefix as string) ?? "agent:";
  const teamId = row.config.teamId as string | undefined;

  if (!apiKey) {
    return {
      status: "error",
      data: { error: "Missing apiKey in heartbeat config" },
    };
  }

  const sinceDate = row.last_run_at
    ? row.last_run_at.toISOString()
    : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const graphqlQuery = `query HeartbeatIssues($filter: IssueFilter) {
  issues(filter: $filter, first: 50, orderBy: updatedAt) {
    nodes {
      id
      title
      description
      url
      state { name }
      priority
      labels { nodes { name } }
      updatedAt
    }
  }
}`;

  const variables = {
    filter: {
      updatedAt: { gte: sinceDate },
      ...(teamId ? { team: { id: { eq: teamId } } } : {}),
      labels: { name: { startsWith: labelPrefix } },
    },
  };

  try {
    const resp = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: graphqlQuery, variables }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      return {
        status: "error",
        data: { statusCode: resp.status, error: `Linear API error: ${resp.statusText}` },
      };
    }

    const body = (await resp.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    const issues = data?.issues as Record<string, unknown> | undefined;
    const nodes = (issues?.nodes ?? []) as Array<Record<string, unknown>>;

    // Filter out already-processed issues via linear_webhook_events
    const pool = getPool();
    const unprocessedIssues: Array<Record<string, unknown>> = [];

    for (const issue of nodes) {
      const issueId = issue.id as string;
      const result = await pool.query(
        `SELECT 1 FROM linear_webhook_events WHERE issue_id = $1 AND processed_at > $2`,
        [issueId, sinceDate],
      );
      if (result.rows.length === 0) {
        unprocessedIssues.push(issue);
      }
    }

    return {
      status: unprocessedIssues.length > 0 ? "changed" : "ok",
      data: {
        issues: unprocessedIssues,
        labelPrefix,
        count: unprocessedIssues.length,
      },
    };
  } catch (err) {
    return {
      status: "error",
      data: { error: String(err) },
    };
  }
}

// ── Public Fetcher Dispatch ───────────────────────────────────────────

export async function fetchHeartbeatData(config: HeartbeatConfigRow): Promise<FetchResult> {
  switch (config.type) {
    case "http":    return fetchHttp(config);
    case "rss":     return fetchRss(config);
    case "github":  return fetchGithub(config);
    case "linear":  return fetchLinear(config);
  }
}

// ── Run Single Heartbeat ──────────────────────────────────────────────

export async function runHeartbeat(
  configRow: HeartbeatConfigRow,
  resolveClient: (agentConfig: AgentConfig) => InferenceClient,
): Promise<void> {
  const pool = getPool();
  const start = Date.now();

  let runStatus: "ok" | "changed" | "error" | "timeout" = "ok";
  let agentSummary = "";
  let rawData: Record<string, unknown> = {};

  try {
    // 1. Fetch external data
    const fetched = await fetchHeartbeatData(configRow);
    runStatus = fetched.status;
    rawData = fetched.data;

    // 2. Resolve agent config
    const uid = configRow.uid ?? "system";
    const agentId = configRow.agent_id;

    let agentConfig: AgentConfig;
    try {
      agentConfig = getAgentConfig(agentId);
    } catch {
      agentConfig = getAgentConfig("default");
    }

    const client = resolveClient(agentConfig);

    const sessionKey = {
      uid,
      surface: "heartbeat" as const,
      surfaceId: configRow.id,
    };

    // 2b. Linear special handling — process each issue individually
    if (configRow.type === "linear" && fetched.status === "changed") {
      const { postLinearComment, markProcessed: markLinearProcessed } = await import("../channels/linear.js");
      const issues = (fetched.data.issues ?? []) as Array<Record<string, unknown>>;
      const apiKey = configRow.config.apiKey as string;
      let processedCount = 0;

      for (const issue of issues) {
        const issueTitle = (issue.title as string) ?? "Untitled";
        const issueId = issue.id as string;
        const issueUpdatedAt = (issue.updatedAt as string) ?? "";

        const issuePrompt =
          `[Linear Issue: ${issueTitle}]\n\n` +
          `${configRow.prompt ?? "Analyze this issue and provide guidance."}\n\n` +
          `Issue:\n${JSON.stringify(issue, null, 2)}`;

        try {
          const result = await runAgentLoop(
            uid,
            issuePrompt,
            agentConfig,
            client,
            sessionKey,
            configRow.workspace_id ?? undefined,
          );

          await postLinearComment(issueId, result.content, apiKey);
          await markLinearProcessed(
            `heartbeat:${issueId}:${issueUpdatedAt}`,
            "Issue",
            "heartbeat",
            issueId,
          );
          processedCount++;
        } catch (issueErr) {
          log.error(
            `Agent error for Linear issue "${issueTitle}" in heartbeat "${configRow.name}":`,
            issueErr,
          );
        }
      }

      agentSummary = `Processed ${processedCount} Linear issues`;
      // Skip the normal agent loop below — per-issue loop above replaces it
    } else {
      // 3. Build prompt message (non-linear path)
      const userMessage = `[Heartbeat: ${configRow.name}]\n\n${configRow.prompt ?? "Analyze this data and provide a brief summary."}\n\nData:\n${JSON.stringify(rawData, null, 2)}`;

      // 4. Run agent loop
      try {
        const result = await runAgentLoop(
          uid,
          userMessage,
          agentConfig,
          client,
          sessionKey,
          configRow.workspace_id ?? undefined,
        );
        agentSummary = result.content;
      } catch (agentErr) {
        log.error(`Agent error for heartbeat "${configRow.name}":`, agentErr);
        agentSummary = `Agent error: ${String(agentErr)}`;
        runStatus = "error";
      }
    }
  } catch (err) {
    log.error(`Fetch error for heartbeat "${configRow.name}":`, err);
    runStatus = "error";
    rawData = { error: String(err) };
    agentSummary = `Fetch error: ${String(err)}`;
  }

  const durationMs = Date.now() - start;

  // 5. Persist run
  await pool.query(
    `INSERT INTO heartbeat_runs (config_id, status, raw_data, agent_summary, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [configRow.id, runStatus, JSON.stringify(rawData), agentSummary, durationMs],
  );

  // 6. Update last_run_at
  await pool.query(
    `UPDATE heartbeat_configs SET last_run_at = NOW() WHERE id = $1`,
    [configRow.id],
  );

  // 7. Emit event
  getEventBus().emit("heartbeat.completed", {
    configId: configRow.id,
    configName: configRow.name,
    uid: configRow.uid ?? "system",
    status: runStatus,
    agentSummary,
    timestamp: Date.now(),
  });

  // 8. Adaptive interval adjustment (Feature 6)
  await adjustAdaptiveInterval(configRow.id, runStatus);

  log.dim(`"${configRow.name}" → ${runStatus} (${durationMs}ms)`);
}

// ── Adaptive Interval Adjustment ──────────────────────────────────────
// Adjusts heartbeat interval based on recent failure rate (Feature 6).
// Query last 5 runs: if 0 failures, gradually increase toward max.
// If >3 failures, reset to min interval.

async function adjustAdaptiveInterval(
  configId: string,
  _currentStatus: "ok" | "changed" | "error" | "timeout",
): Promise<void> {
  const pool = getPool();

  try {
    // Get config's current and adaptive interval settings
    const { rows: configRows } = await pool.query<{
      current_interval_minutes: number;
      adaptive_min_interval_minutes: number;
      adaptive_max_interval_minutes: number;
    }>(
      `SELECT current_interval_minutes, adaptive_min_interval_minutes, adaptive_max_interval_minutes
       FROM heartbeat_configs WHERE id = $1`,
      [configId],
    );

    if (configRows.length === 0) return;

    const config = configRows[0]!;
    const { current_interval_minutes, adaptive_min_interval_minutes, adaptive_max_interval_minutes } = config;

    // Get last 5 runs to count failures
    const { rows: runRows } = await pool.query<{ status: string }>(
      `SELECT status FROM heartbeat_runs WHERE config_id = $1 ORDER BY run_at DESC LIMIT 5`,
      [configId],
    );

    const failureCount = runRows.filter((r) => r.status === "error" || r.status === "timeout").length;

    let newInterval = current_interval_minutes;

    if (failureCount === 0) {
      // No failures in last 5 runs: gradually increase toward max
      // Increase by 10%, but cap at max
      newInterval = Math.min(
        Math.ceil(current_interval_minutes * 1.1),
        adaptive_max_interval_minutes,
      );
    } else if (failureCount > 3) {
      // More than 3 failures: reset to min interval
      newInterval = adaptive_min_interval_minutes;
    }

    if (newInterval !== current_interval_minutes) {
      await pool.query(
        `UPDATE heartbeat_configs SET current_interval_minutes = $1 WHERE id = $2`,
        [newInterval, configId],
      );
      log.info(`Adjusted interval for config ${configId}: ${current_interval_minutes}m → ${newInterval}m (failures: ${failureCount})`);
    }
  } catch (err) {
    log.warn(`Failed to adjust adaptive interval for config ${configId}:`, err);
  }
}

// ── Run All Due Heartbeats ────────────────────────────────────────────
// Queries for configs where last_run_at is past their interval, runs each.
// Sequential (not parallel) to avoid hammering the agent/inference layer.

export async function runDueHeartbeats(
  resolveClient: (agentConfig: AgentConfig) => InferenceClient,
): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query<HeartbeatConfigRow>(
    `SELECT * FROM heartbeat_configs
     WHERE enabled = true
     AND (last_run_at IS NULL OR last_run_at < NOW() - (interval_minutes || ' minutes')::interval)`,
  );

  for (const row of rows) {
    await runHeartbeat(row, resolveClient).catch((err: unknown) => {
      log.error(`Run failed for "${row.name}":`, err);
    });
  }
}
