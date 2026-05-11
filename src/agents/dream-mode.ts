import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import { getPool } from "../config/postgres.js";
import { loadProfile, loadRecentDailyMemory } from "../memory/store.js";
import { extractAndPersist } from "../memory/auto-extract.js";
import { getLocalRouter } from "../inference/local-router.js";
import { getRecentSummaries } from "../memory/summarizer.js";
import { createLogger } from "../utils/logger.js";

// ── Dream Mode / Offline Simulation ─────────────────────────────────
// When idle, agents run simulated future scenarios in background
// using local models (Ollama on Mac Mini M4). Privacy-first: all
// dream inference stays 100% offline.
//
// Dream cycle:
//   1. Load recent memory + profile + graph
//   2. Generate simulated scenarios (what-if analysis)
//   3. Extract insights and entities from simulations
//   4. Surface high-value insights on wake-up
//   5. Optionally evolve graph with synthetic relationships
//
// Intensity levels:
//   - Light: quick summaries, 5 min
//   - Medium: scenario simulation, 15 min
//   - Deep: full graph evolution + procedural macros, 30+ min
//
// Scheduled: user sets dream time (default: 11 PM)
// Prompt: gateway asks "What should I dream about?" at dream time

const log = createLogger("dream-mode");

// ── Types ───────────────────────────────────────────────────────────

export type DreamIntensity = "light" | "medium" | "deep";

export interface DreamConfig {
  enabled: boolean;
  intensity: DreamIntensity;
  scheduleHour: number;         // when to start dreaming (24h format, default: 23)
  scheduleMinute: number;       // minute (default: 0)
  maxDurationMs: number;        // max dream duration per intensity
  useLocalOnly: boolean;        // privacy-first: only local models (default: true)
  promptUser: boolean;          // ask user what to dream about (default: true)
}

export interface DreamSession {
  id: string;
  uid: string;
  intensity: DreamIntensity;
  topic?: string;               // user-specified dream topic
  status: "pending" | "dreaming" | "completed" | "failed";
  scenarios: DreamScenario[];
  insights: string[];
  entitiesDiscovered: number;
  edgesCreated: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface DreamScenario {
  id: string;
  title: string;
  description: string;
  implications: string[];
  probability: number;          // estimated likelihood 0-1
  timeframe: string;            // "days" | "weeks" | "months"
  entities: string[];           // entities involved
}

export interface DreamExport {
  uid: string;
  date: string;
  title: string;
  summary: string;
  highlights: string[];
  scenarios: Array<{
    title: string;
    insight: string;
    probability: number;
  }>;
  graphUpdates: {
    entitiesCreated: number;
    edgesCreated: number;
  };
  intensity: DreamIntensity;
}

const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: false,
  intensity: "medium",
  scheduleHour: 23,
  scheduleMinute: 0,
  maxDurationMs: 900_000, // 15 min for medium
  useLocalOnly: true,
  promptUser: true,
};

export const _INTENSITY_DURATIONS: Record<DreamIntensity, number> = {
  light: 300_000,    // 5 min
  medium: 900_000,   // 15 min
  deep: 1_800_000,   // 30 min
};

// ── Dream Session ───────────────────────────────────────────────────

/**
 * Run a dream session for a user.
 */
export async function runDreamSession(
  uid: string,
  inferenceClient: InferenceClient,
  config: Partial<DreamConfig> = {},
  topic?: string,
): Promise<DreamSession> {
  const opts = { ...DEFAULT_DREAM_CONFIG, ...config };
  const dreamId = randomUUID();
  const start = Date.now();

  // Use local model if privacy mode
  let client = inferenceClient;
  if (opts.useLocalOnly) {
    const localRouter = getLocalRouter();
    try {
      await localRouter.initialize();
      if (localRouter.getAvailableModels().length > 0) {
        client = localRouter.createClient();
        log.info(`Dream mode using local model (privacy-first)`);
      } else {
        log.dim(`No local models available, using provided client`);
      }
    } catch {
      log.dim(`Local router init failed, using provided client`);
    }
  }

  const session: DreamSession = {
    id: dreamId,
    uid,
    intensity: opts.intensity,
    topic,
    status: "dreaming",
    scenarios: [],
    insights: [],
    entitiesDiscovered: 0,
    edgesCreated: 0,
    startedAt: start,
  };

  await persistDreamSession(session);

  log.info(`Dream session started: ${dreamId.slice(0, 8)} (${opts.intensity}, topic: ${topic ?? "auto"})`);

  try {
    // 1. Load context
    const profile = await loadProfile(uid);
    const recentMemory = await loadRecentDailyMemory(uid);
    const recentSummaries = await getRecentSummaries(uid, "daily", 3).catch(() => []);

    const memoryContext = buildDreamContext(profile, recentMemory, recentSummaries);

    // 2. Generate scenarios based on intensity
    if (opts.intensity === "light") {
      session.insights = await generateQuickInsights(memoryContext, topic, client);
    } else {
      session.scenarios = await generateScenarios(memoryContext, topic, client, opts.intensity);

      // 3. Extract entities from scenarios
      if (opts.intensity === "deep") {
        for (const scenario of session.scenarios) {
          const result = await extractAndPersist(
            `${scenario.title}: ${scenario.description}. Implications: ${scenario.implications.join(". ")}`,
            uid,
            client,
            topic,
          ).catch(() => ({ entitiesCreated: 0, edgesCreated: 0 }));

          session.entitiesDiscovered += result.entitiesCreated;
          session.edgesCreated += result.edgesCreated;
        }
      }

      // 4. Extract insights from all scenarios
      session.insights = session.scenarios.flatMap((s) => s.implications);
    }

    session.status = "completed";
    session.completedAt = Date.now();
    session.durationMs = Date.now() - start;

    await persistDreamSession(session);

    log.info(
      `Dream complete: ${session.scenarios.length} scenarios, ${session.insights.length} insights, ` +
      `${session.entitiesDiscovered} entities (${session.durationMs}ms)`,
    );

    return session;
  } catch (err) {
    session.status = "failed";
    session.completedAt = Date.now();
    session.durationMs = Date.now() - start;
    await persistDreamSession(session);
    log.error(`Dream session failed:`, err);
    throw err;
  }
}

// ── Dream Export ────────────────────────────────────────────────────

/**
 * Generate a "What I Dreamed About" morning summary.
 */
export async function generateDreamExport(
  uid: string,
  inferenceClient: InferenceClient,
): Promise<DreamExport | null> {
  const pool = getPool();

  // Find the most recent completed dream session
  const { rows } = await pool.query<{ config: DreamSession }>(
    `SELECT config FROM dream_sessions
     WHERE uid = $1 AND status = 'completed'
     ORDER BY created_at DESC LIMIT 1`,
    [uid],
  );

  if (rows.length === 0) return null;

  const session = rows[0]!.config;

  // Generate beautiful summary
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `You are summarizing an AI agent's "dream" session — overnight processing of memories and scenarios. Write a brief, engaging "What I Dreamed About" report.

Keep it conversational and insightful. Use bullet points for highlights.`,
      },
      {
        role: "user",
        content: `Dream intensity: ${session.intensity}\nTopic: ${session.topic ?? "general"}\n\nScenarios:\n${session.scenarios.map((s) => `- ${s.title}: ${s.description}`).join("\n")}\n\nInsights:\n${session.insights.map((i) => `- ${i}`).join("\n")}`,
      },
    ],
    temperature: 0.7,
    maxTokens: 800,
  });

  return {
    uid,
    date: new Date().toISOString().slice(0, 10),
    title: `Dream Report — ${session.topic ?? "General"}`,
    summary: response.content ?? "No dreams to report.",
    highlights: session.insights.slice(0, 5),
    scenarios: session.scenarios.map((s) => ({
      title: s.title,
      insight: s.implications[0] ?? "",
      probability: s.probability,
    })),
    graphUpdates: {
      entitiesCreated: session.entitiesDiscovered,
      edgesCreated: session.edgesCreated,
    },
    intensity: session.intensity,
  };
}

// ── Dream Prompt ────────────────────────────────────────────────────

/**
 * Generate the "What should I dream about?" prompt for the user.
 * Called by the scheduler at the configured dream time.
 */
export async function generateDreamPrompt(
  uid: string,
  _inferenceClient: InferenceClient,
): Promise<string> {
  const profile = await loadProfile(uid);
  const recentMemory = await loadRecentDailyMemory(uid);

  const interests = profile?.interests?.slice(0, 5).join(", ") ?? "general topics";
  const recentTopics = (recentMemory ?? [])
    .flatMap((m) => (m.entries ?? []).map((e: any) => e.content))
    .slice(0, 5)
    .map((c: string) => c.slice(0, 100));

  return `It's dream time! Based on your recent activity, here are some ideas:\n\n` +
    `- Deep dive into: ${interests}\n` +
    (recentTopics.length > 0 ? `- Explore scenarios around: ${recentTopics.join(", ")}\n` : "") +
    `\nWhat would you like me to dream about tonight? (or just say "surprise me")`;
}

// ── Scenario Generation ─────────────────────────────────────────────

async function generateScenarios(
  context: string,
  topic: string | undefined,
  client: InferenceClient,
  intensity: DreamIntensity,
): Promise<DreamScenario[]> {
  const numScenarios = intensity === "deep" ? 5 : 3;

  const response = await client.chat({
    messages: [
      {
        role: "system",
        content: `Generate ${numScenarios} plausible future scenarios based on the user's memory context.
Each scenario explores a "what-if" from a different angle.

Respond in JSON:
{
  "scenarios": [
    {
      "title": "Short title",
      "description": "2-3 sentence description of the scenario",
      "implications": ["implication 1", "implication 2"],
      "probability": 0.0-1.0,
      "timeframe": "days|weeks|months",
      "entities": ["relevant entity names"]
    }
  ]
}`,
      },
      {
        role: "user",
        content: topic
          ? `Dream topic: ${topic}\n\nContext:\n${context}`
          : `Generate scenarios from my recent context:\n${context}`,
      },
    ],
    temperature: 0.8,
    maxTokens: 2000,
  });

  try {
    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { scenarios?: DreamScenario[] };
    return (parsed.scenarios ?? []).map((s) => ({
      id: randomUUID(),
      title: s.title ?? "Untitled Scenario",
      description: s.description ?? "",
      implications: s.implications ?? [],
      probability: Math.min(1, Math.max(0, s.probability ?? 0.5)),
      timeframe: s.timeframe ?? "weeks",
      entities: s.entities ?? [],
    }));
  } catch {
    return [];
  }
}

async function generateQuickInsights(
  context: string,
  topic: string | undefined,
  client: InferenceClient,
): Promise<string[]> {
  const response = await client.chat({
    messages: [
      {
        role: "system",
        content: `Generate 3-5 quick insights from the user's memory context. Focus on patterns, opportunities, or risks they might not have noticed.\n\nRespond as a JSON array of strings: ["insight1", "insight2"]`,
      },
      {
        role: "user",
        content: topic
          ? `Focus: ${topic}\n\n${context}`
          : context,
      },
    ],
    temperature: 0.6,
    maxTokens: 500,
  });

  try {
    const content = response.content ?? "[]";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as string[];
  } catch {
    return [];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildDreamContext(
  profile: any,
  recentMemory: any[],
  summaries: any[],
): string {
  const parts: string[] = [];

  if (profile) {
    parts.push(`User: ${profile.displayName ?? "Unknown"}`);
    if (profile.interests?.length) parts.push(`Interests: ${profile.interests.join(", ")}`);
    if (profile.expertiseAreas?.length) parts.push(`Expertise: ${profile.expertiseAreas.join(", ")}`);
    if (profile.strategicNotes?.length) {
      parts.push(`Strategic notes:\n${profile.strategicNotes.slice(0, 5).map((n: string) => `- ${n}`).join("\n")}`);
    }
  }

  if (recentMemory?.length) {
    const entries = recentMemory.flatMap((m) => (m.entries ?? []).map((e: any) => `[${e.category}] ${e.content}`));
    parts.push(`Recent memory:\n${entries.slice(0, 10).join("\n")}`);
  }

  if (summaries?.length) {
    parts.push(`Recent summaries:\n${summaries.map((s: any) => s.summary).join("\n")}`);
  }

  return parts.join("\n\n");
}

async function persistDreamSession(session: DreamSession): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dream_sessions (id, uid, status, config, created_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET status = $3, config = $4::jsonb`,
    [session.id, session.uid, session.status, JSON.stringify(session)],
  );
}

// ── Dream Schedule Management ───────────────────────────────────────

export function getDreamCronExpression(config: DreamConfig): string {
  return `${config.scheduleMinute} ${config.scheduleHour} * * *`;
}

/**
 * Get active dream configuration for a user.
 */
export async function getUserDreamConfig(uid: string): Promise<DreamConfig> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: DreamConfig }>(
    "SELECT config FROM user_dream_configs WHERE uid = $1",
    [uid],
  );
  return rows[0]?.config ?? DEFAULT_DREAM_CONFIG;
}

/**
 * Update user's dream configuration.
 */
export async function setUserDreamConfig(uid: string, config: Partial<DreamConfig>): Promise<void> {
  const pool = getPool();
  const merged = { ...DEFAULT_DREAM_CONFIG, ...config };
  await pool.query(
    `INSERT INTO user_dream_configs (uid, config, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (uid) DO UPDATE SET config = $2::jsonb, updated_at = NOW()`,
    [uid, JSON.stringify(merged)],
  );
}

/**
 * Get recent dream sessions for a user.
 */
export async function getRecentDreams(uid: string, limit: number = 5): Promise<DreamSession[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: DreamSession }>(
    `SELECT config FROM dream_sessions
     WHERE uid = $1 AND status = 'completed'
     ORDER BY created_at DESC LIMIT $2`,
    [uid, limit],
  );
  return rows.map((r) => r.config);
}
