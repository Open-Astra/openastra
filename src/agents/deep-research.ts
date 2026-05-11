import { randomUUID } from "node:crypto";
import type { InferenceClient } from "../inference/types.js";
import { extractAndPersist } from "../memory/auto-extract.js";
import { appendDailyMemory } from "../memory/store.js";
import { logAgentAction } from "./audit.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Deep Research Mode ──────────────────────────────────────────────
// Long-running autonomous research that runs for hours or days.
// Like a PhD researcher: given a topic, it iteratively searches,
// reads, synthesizes, and builds a comprehensive knowledge base.
//
// The research agent:
//   1. Breaks the topic into research questions
//   2. Iteratively searches and reads sources
//   3. Synthesizes findings into a structured report
//   4. Extracts entities → knowledge graph
//   5. Saves daily progress to memory
//   6. Sends periodic status updates
//   7. Produces a final research report
//
// Uses the provider defined in the research task config (can be
// Grok, Gemini, or any other configured model).

const log = createLogger("deep-research");

// ── Types ───────────────────────────────────────────────────────────

export type ResearchStatus = "planning" | "researching" | "synthesizing" | "completed" | "paused" | "failed";

export interface ResearchTask {
  id: string;
  uid: string;
  topic: string;
  questions: string[];           // research questions to answer
  status: ResearchStatus;
  config: ResearchTaskConfig;
  progress: ResearchProgress;
  findings: ResearchFinding[];
  report?: string;               // final synthesized report
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  scheduledEndAt?: number;       // when to stop (deadline)
}

export interface ResearchTaskConfig {
  maxDurationHours: number;      // total research time budget
  iterationsPerDay: number;      // how many research cycles per day
  intervalMinutes: number;       // minutes between iterations
  provider?: string;             // inference provider override
  modelId?: string;              // model override
  skills: string[];              // skills to use (brave_search, web_scrape, etc.)
  agentId?: string;              // existing agent to use
  depth: "shallow" | "moderate" | "deep" | "exhaustive";
  notifyOnProgress: boolean;
  extractToGraph: boolean;       // auto-extract to knowledge graph
}

export interface ResearchProgress {
  totalIterations: number;
  completedIterations: number;
  questionsAnswered: number;
  sourcesFound: number;
  entitiesExtracted: number;
  tokensUsed: number;
  lastIterationAt?: number;
}

export interface ResearchFinding {
  id: string;
  question: string;
  answer: string;
  sources: string[];
  confidence: number;
  iteration: number;
  timestamp: number;
}

const DEFAULT_RESEARCH_CONFIG: ResearchTaskConfig = {
  maxDurationHours: 24,
  iterationsPerDay: 12,
  intervalMinutes: 120, // every 2 hours
  skills: ["brave_search", "web_scrape", "summarize"],
  depth: "moderate",
  notifyOnProgress: true,
  extractToGraph: true,
};

const DEPTH_ITERATIONS: Record<string, number> = {
  shallow: 3,
  moderate: 8,
  deep: 20,
  exhaustive: 50,
};

// ── Start Research ──────────────────────────────────────────────────

/**
 * Start a new deep research task.
 */
export async function startResearch(
  uid: string,
  topic: string,
  config: Partial<ResearchTaskConfig> = {},
  inferenceClient: InferenceClient,
): Promise<ResearchTask> {
  const opts = { ...DEFAULT_RESEARCH_CONFIG, ...config };
  const taskId = randomUUID();

  log.info(`Starting deep research: "${topic}" (${opts.depth}, ${opts.maxDurationHours}h)`);

  // Phase 1: Generate research questions
  const questions = await generateResearchQuestions(topic, opts.depth, inferenceClient);

  const task: ResearchTask = {
    id: taskId,
    uid,
    topic,
    questions,
    status: "planning",
    config: opts,
    progress: {
      totalIterations: DEPTH_ITERATIONS[opts.depth] ?? 8,
      completedIterations: 0,
      questionsAnswered: 0,
      sourcesFound: 0,
      entitiesExtracted: 0,
      tokensUsed: 0,
    },
    findings: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    scheduledEndAt: Date.now() + opts.maxDurationHours * 3_600_000,
  };

  await persistResearchTask(task);

  await logAgentAction(uid, opts.agentId ?? "researcher", "research_started" as any, {
    taskId,
    topic,
    depth: opts.depth,
    questions: questions.length,
  });

  return task;
}

/**
 * Run one iteration of research. Called by the scheduler.
 */
export async function runResearchIteration(
  taskId: string,
  inferenceClient: InferenceClient,
): Promise<ResearchFinding[]> {
  const task = await getResearchTask(taskId);
  if (!task) throw new Error(`Research task ${taskId} not found`);
  if (task.status === "completed" || task.status === "failed") return [];

  // Check deadline
  if (task.scheduledEndAt && Date.now() > task.scheduledEndAt) {
    await completeResearch(taskId, inferenceClient);
    return [];
  }

  task.status = "researching";
  task.updatedAt = Date.now();

  log.dim(`Research iteration ${task.progress.completedIterations + 1}/${task.progress.totalIterations} for "${task.topic}"`);

  const newFindings: ResearchFinding[] = [];

  // Pick the next unanswered question (or revisit with more depth)
  const questionIndex = task.progress.completedIterations % task.questions.length;
  const question = task.questions[questionIndex] ?? task.topic;

  // Build context from existing findings
  const existingContext = task.findings
    .slice(-5) // last 5 findings for context
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n");

  try {
    const response = await inferenceClient.chat({
      messages: [
        {
          role: "system",
          content: `You are a deep research agent investigating: "${task.topic}"

Your current research question: ${question}

${existingContext ? `Previous findings:\n${existingContext}` : ""}

Research deeply. Provide detailed, well-sourced answers. Include specific data points, quotes, and references.
If you've already covered this question, go deeper or explore a new angle.

Respond in JSON:
{
  "answer": "Detailed answer with facts and analysis",
  "sources": ["source1", "source2"],
  "confidence": 0.0-1.0,
  "followUpQuestions": ["question to explore next"]
}`,
        },
        { role: "user", content: question },
      ],
      temperature: 0.3,
      maxTokens: 2000,
    });

    const content = response.content ?? "{}";
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as {
        answer?: string;
        sources?: string[];
        confidence?: number;
        followUpQuestions?: string[];
      };

      const finding: ResearchFinding = {
        id: randomUUID(),
        question,
        answer: parsed.answer ?? content,
        sources: parsed.sources ?? [],
        confidence: parsed.confidence ?? 0.5,
        iteration: task.progress.completedIterations + 1,
        timestamp: Date.now(),
      };

      newFindings.push(finding);
      task.findings.push(finding);
      task.progress.sourcesFound += finding.sources.length;
      task.progress.questionsAnswered++;

      // Add follow-up questions
      if (parsed.followUpQuestions?.length) {
        for (const q of parsed.followUpQuestions) {
          if (!task.questions.includes(q)) {
            task.questions.push(q);
          }
        }
      }

      // Extract to knowledge graph
      if (task.config.extractToGraph) {
        const extracted = await extractAndPersist(
          finding.answer,
          task.uid,
          inferenceClient,
          task.topic,
        ).catch(() => ({ entitiesCreated: 0, edgesCreated: 0 }));
        task.progress.entitiesExtracted += extracted.entitiesCreated;
      }

      // Save to daily memory
      await appendDailyMemory(task.uid, {
        category: "note",
        content: `[Research: ${task.topic}] ${finding.answer.slice(0, 500)}`,
        timestamp: Date.now(),
      });
    }

    task.progress.completedIterations++;
    task.progress.tokensUsed += response.usage.totalTokens;
    task.progress.lastIterationAt = Date.now();
    task.updatedAt = Date.now();

    // Check if we've completed all iterations
    if (task.progress.completedIterations >= task.progress.totalIterations) {
      await completeResearch(taskId, inferenceClient);
    } else {
      await persistResearchTask(task);
    }

    return newFindings;
  } catch (err) {
    log.error(`Research iteration failed:`, err);
    task.status = "paused";
    await persistResearchTask(task);
    return [];
  }
}

// ── Complete Research ────────────────────────────────────────────────

async function completeResearch(
  taskId: string,
  inferenceClient: InferenceClient,
): Promise<void> {
  const task = await getResearchTask(taskId);
  if (!task) return;

  log.info(`Completing research: "${task.topic}" (${task.findings.length} findings)`);

  // Synthesize final report
  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `Synthesize all research findings into a comprehensive research report.

Structure:
1. Executive Summary (2-3 sentences)
2. Key Findings (bulleted)
3. Detailed Analysis (organized by theme)
4. Open Questions
5. Sources

Be thorough but clear. This is the final report from days of research.`,
      },
      {
        role: "user",
        content: `Research topic: ${task.topic}\n\nFindings:\n${task.findings.map((f) => `Q: ${f.question}\nA: ${f.answer}\nConfidence: ${f.confidence}\nSources: ${f.sources.join(", ")}`).join("\n\n")}`,
      },
    ],
    temperature: 0.3,
    maxTokens: 4000,
  });

  task.report = response.content ?? "Research report generation failed.";
  task.status = "completed";
  task.completedAt = Date.now();
  task.updatedAt = Date.now();

  await persistResearchTask(task);

  // Save report as strategic note
  await appendDailyMemory(task.uid, {
    category: "strategy",
    content: `[Research Complete: ${task.topic}] ${task.report.slice(0, 1000)}`,
    timestamp: Date.now(),
  });

  await logAgentAction(task.uid, task.config.agentId ?? "researcher", "research_completed" as any, {
    taskId,
    topic: task.topic,
    findings: task.findings.length,
    tokensUsed: task.progress.tokensUsed,
    durationMs: Date.now() - task.startedAt,
  });

  log.info(`Research complete: "${task.topic}" — ${task.findings.length} findings, ${task.progress.tokensUsed} tokens`);
}

// ── Research Question Generation ────────────────────────────────────

async function generateResearchQuestions(
  topic: string,
  depth: string,
  inferenceClient: InferenceClient,
): Promise<string[]> {
  const numQuestions = depth === "shallow" ? 3 : depth === "moderate" ? 5 : depth === "deep" ? 8 : 12;

  const response = await inferenceClient.chat({
    messages: [
      {
        role: "system",
        content: `Generate ${numQuestions} research questions for a deep investigation of the given topic.
Cover different angles: fundamentals, current state, trends, controversies, practical implications.
Respond as a JSON array of strings.`,
      },
      { role: "user", content: topic },
    ],
    temperature: 0.5,
    maxTokens: 800,
  });

  try {
    const content = response.content ?? "[]";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [topic];
    return JSON.parse(jsonMatch[0]) as string[];
  } catch {
    return [topic];
  }
}

// ── CRUD ────────────────────────────────────────────────────────────

export async function getResearchTask(taskId: string): Promise<ResearchTask | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: ResearchTask }>(
    "SELECT config FROM research_tasks WHERE id = $1",
    [taskId],
  );
  return rows[0]?.config ?? null;
}

export async function listResearchTasks(uid: string): Promise<ResearchTask[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: ResearchTask }>(
    "SELECT config FROM research_tasks WHERE uid = $1 ORDER BY created_at DESC LIMIT 20",
    [uid],
  );
  return rows.map((r) => r.config);
}

export async function pauseResearch(taskId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE research_tasks SET status = 'paused', config = jsonb_set(config, '{status}', '"paused"') WHERE id = $1`,
    [taskId],
  );
}

export async function resumeResearch(taskId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE research_tasks SET status = 'researching', config = jsonb_set(config, '{status}', '"researching"') WHERE id = $1`,
    [taskId],
  );
}

async function persistResearchTask(task: ResearchTask): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO research_tasks (id, uid, topic, status, config, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET status = $4, config = $5::jsonb`,
    [task.id, task.uid, task.topic, task.status, JSON.stringify(task)],
  );
}
