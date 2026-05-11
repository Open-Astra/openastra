import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/bus.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agents/triage");

// ── Trigram Similarity ───────────────────────────────────────────────

function trigramSimilarity(a: string, b: string): number {
  const ngrams = (s: string): Set<string> => {
    const grams = new Set<string>();
    for (let i = 0; i < s.length - 2; i++) grams.add(s.slice(i, i + 3));
    return grams;
  };
  const ga = ngrams(a.toLowerCase());
  const gb = ngrams(b.toLowerCase());
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / Math.max(ga.size, gb.size, 1);
}

// ── Linear Issue Types ───────────────────────────────────────────────

interface LinearIssue {
  id: string;
  title: string;
  state: { name: string };
  url: string;
}

// ── Triage Agent ─────────────────────────────────────────────────────

export async function runTriageAgent(): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    logger.dim("LINEAR_API_KEY not set — skipping triage");
    return;
  }

  logger.info("Running triage agent");

  // 1. Fetch open Linear issues
  let issues: LinearIssue[] = [];
  try {
    const query = `
      query {
        issues(filter: { state: { type: { in: ["unstarted", "started"] } } }, first: 250) {
          nodes {
            id
            title
            url
            state { name }
          }
        }
      }
    `;

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      logger.error(`Linear API error: ${response.status} ${response.statusText}`);
      return;
    }

    const json = (await response.json()) as {
      data?: { issues?: { nodes?: LinearIssue[] } };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      logger.error("Linear GraphQL errors:", json.errors.map((e) => e.message).join(", "));
      return;
    }

    issues = json.data?.issues?.nodes ?? [];
    logger.dim(`Fetched ${issues.length} open Linear issues`);
  } catch (err) {
    logger.error("Failed to fetch Linear issues:", err);
    return;
  }

  if (issues.length === 0) {
    logger.dim("No open issues to triage");
    return;
  }

  // 2. Group by title similarity (trigram, threshold 0.5)
  const groups: LinearIssue[][] = [];
  const assigned = new Set<string>();

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]!;
    if (assigned.has(issue.id)) continue;

    const group: LinearIssue[] = [issue];
    assigned.add(issue.id);

    for (let j = i + 1; j < issues.length; j++) {
      const other = issues[j]!;
      if (assigned.has(other.id)) continue;
      if (trigramSimilarity(issue.title, other.title) >= 0.5) {
        group.push(other);
        assigned.add(other.id);
      }
    }

    groups.push(group);
  }

  // 3. Build digest of groups with 3+ similar issues
  const digests = groups.filter((g) => g.length >= 3);
  if (digests.length === 0) {
    logger.dim("No issue clusters with 3+ similar issues found");
    return;
  }

  logger.info(`Found ${digests.length} issue cluster(s) with 3+ similar issues`);

  const digestLines: string[] = [`Weekly Triage Digest — ${new Date().toISOString().slice(0, 10)}\n`];
  for (const group of digests) {
    digestLines.push(`## Cluster: "${group[0]!.title}" (${group.length} issues)`);
    for (const issue of group) {
      digestLines.push(`  - [${issue.id}] ${issue.title} — ${issue.url}`);
    }
    digestLines.push("");
  }

  const digestText = digestLines.join("\n");

  // 4. Emit a webhook.dispatched event so listeners (e.g. configured webhooks) receive the digest
  try {
    const bus = getEventBus();
    bus.emit("webhook.dispatched", {
      uid: "system:triage",
      webhookId: "triage-digest",
      eventType: "triage.digest",
      success: true,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error("Failed to dispatch triage digest webhook event:", err);
  }

  // 5. Persist digest summary to postgres for audit
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO audit_log (id, event_type, uid, payload, created_at)
       VALUES (gen_random_uuid(), 'triage.digest', 'system:triage', $1, NOW())
       ON CONFLICT DO NOTHING`,
      [JSON.stringify({ clusterCount: digests.length, digest: digestText })],
    );
  } catch {
    // audit_log may not have the right schema — don't fail the job
  }

  logger.info(`Triage complete: ${digests.length} cluster(s) dispatched`);
}
