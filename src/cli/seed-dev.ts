#!/usr/bin/env tsx
// ── Local Dev Seed Data CLI ────────────────────────────────────────
// Usage: npx tsx src/cli/seed-dev.ts
//
// Seeds the local database with sample data for development.
// Requires LOCAL_DEV=true or NODE_ENV=development.

import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { initPostgres, getPool } from "../config/postgres.js";
import { runMigrations } from "../db/migrate.js";

// ── ANSI Colors ─────────────────────────────────────────────────────

const ESC = "\x1b[";
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const R = `${ESC}0m`;

// ── Sample Data ─────────────────────────────────────────────────────

const SEED_PREFIX = "seed-dev-";

const SAMPLE_AGENTS = [
  {
    id: `${SEED_PREFIX}general-assistant`,
    display_name: "General Assistant (Dev)",
    tier: "free",
    model_provider: "openai",
    model_id: "gpt-4o-mini",
    max_context_tokens: 128000,
    max_output_tokens: 4096,
    temperature: 0.7,
    system_prompt_template: "You are a helpful general-purpose assistant. Answer questions clearly and concisely.",
    tools_allow: ["web-search", "calculator"],
    tools_deny: [],
    skills: [],
  },
  {
    id: `${SEED_PREFIX}code-helper`,
    display_name: "Code Helper (Dev)",
    tier: "premium",
    model_provider: "openai",
    model_id: "gpt-4o",
    max_context_tokens: 128000,
    max_output_tokens: 8192,
    temperature: 0.3,
    system_prompt_template: "You are a senior software engineer. Help the user write, debug, and review code. Prefer concise, idiomatic solutions.",
    tools_allow: ["code_execute", "file_read", "file_write", "web-search"],
    tools_deny: [],
    skills: ["code_formatter", "code_review"],
  },
  {
    id: `${SEED_PREFIX}research-agent`,
    display_name: "Research Agent (Dev)",
    tier: "premium",
    model_provider: "gemini",
    model_id: "gemini-2.0-flash",
    max_context_tokens: 1000000,
    max_output_tokens: 8192,
    temperature: 0.5,
    system_prompt_template: "You are a research specialist. Find, synthesize, and summarize information from multiple sources. Always cite your sources.",
    tools_allow: ["web-search", "url_fetch", "brave_search"],
    tools_deny: [],
    skills: ["brave_search", "summarize", "wikipedia"],
  },
];

const DEV_USER_ID = `${SEED_PREFIX}user-001`;
const DEV_WORKSPACE_ID = `${SEED_PREFIX}workspace-001`;

interface SeedResult {
  agents: number;
  sessions: number;
  messages: number;
  memoryNotes: number;
  graphEntities: number;
  tasks: number;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Check environment
  const isDev = process.env.LOCAL_DEV === "true" || process.env.NODE_ENV === "development";
  if (!isDev) {
    console.error(`${RED}Error:${R} Seed data can only be created in development mode.`);
    console.error(`Set LOCAL_DEV=true or NODE_ENV=development before running.`);
    process.exit(1);
  }

  console.log(`${CYAN}${BOLD}Astra Dev Seed Data${R}\n`);

  // Initialize Postgres
  const env = loadEnv();
  initPostgres({
    host: env.pgHost,
    port: env.pgPort,
    database: env.pgDatabase,
    user: env.pgUser,
    password: env.pgPassword,
    useSocket: env.pgUseSocket,
    instanceConnectionName: env.pgInstanceConnectionName,
    maxConnections: env.pgMaxConnections,
  });

  // Run migrations
  console.log(`${DIM}Running migrations...${R}`);
  await runMigrations();

  const pool = getPool();
  const result: SeedResult = {
    agents: 0,
    sessions: 0,
    messages: 0,
    memoryNotes: 0,
    graphEntities: 0,
    tasks: 0,
  };

  // 1. Create sample agent configs
  console.log(`\n${BOLD}Seeding agent configs...${R}`);
  for (const agent of SAMPLE_AGENTS) {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM agent_configs WHERE id = $1",
      [agent.id],
    );
    if (rows.length > 0) {
      console.log(`  ${DIM}Skipping${R} ${agent.id} (exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO agent_configs (id, display_name, tier, model_provider, model_id,
         max_context_tokens, max_output_tokens, temperature,
         system_prompt_template, tools_allow, tools_deny, skills, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1)`,
      [
        agent.id,
        agent.display_name,
        agent.tier,
        agent.model_provider,
        agent.model_id,
        agent.max_context_tokens,
        agent.max_output_tokens,
        agent.temperature,
        agent.system_prompt_template,
        JSON.stringify(agent.tools_allow),
        JSON.stringify(agent.tools_deny),
        JSON.stringify(agent.skills),
      ],
    );
    console.log(`  ${GREEN}+${R} ${agent.display_name}`);
    result.agents++;
  }

  // 2. Create sample sessions with messages
  console.log(`\n${BOLD}Seeding sessions and messages...${R}`);

  const sessionSpecs = [
    { agentId: SAMPLE_AGENTS[0]!.id, surface: "chat", surfaceId: "main", messageCount: 4 },
    { agentId: SAMPLE_AGENTS[0]!.id, surface: "chat", surfaceId: "second", messageCount: 2 },
    { agentId: SAMPLE_AGENTS[1]!.id, surface: "chat", surfaceId: "main", messageCount: 6 },
    { agentId: SAMPLE_AGENTS[2]!.id, surface: "chat", surfaceId: "main", messageCount: 3 },
    { agentId: SAMPLE_AGENTS[2]!.id, surface: "group", surfaceId: "team-chat", messageCount: 4 },
  ];

  const sampleConversations = [
    ["What is the weather today?", "I'd be happy to help with weather info. However, I would need your location to provide an accurate forecast."],
    ["Can you explain async/await in JavaScript?", "Async/await is syntactic sugar over Promises. An `async` function always returns a Promise. The `await` keyword pauses execution until the Promise resolves."],
    ["Write a function to reverse a string", "```javascript\nfunction reverseString(str) {\n  return str.split('').reverse().join('');\n}\n```"],
    ["Search for recent papers on transformer architectures", "I found several recent papers on transformer architectures. Key developments include sparse attention mechanisms and efficient inference techniques."],
    ["Hello team, let's discuss the Q1 roadmap", "Great idea! I can help organize the discussion. What areas would you like to prioritize?"],
  ];

  for (let i = 0; i < sessionSpecs.length; i++) {
    const spec = sessionSpecs[i]!;
    const sessionId = `${SEED_PREFIX}session-${String(i + 1).padStart(3, "0")}`;

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM sessions WHERE id = $1",
      [sessionId],
    );
    if (rows.length > 0) {
      console.log(`  ${DIM}Skipping${R} session ${sessionId} (exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, agent_id, surface, surface_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
      [sessionId, DEV_USER_ID, DEV_WORKSPACE_ID, spec.agentId, spec.surface, spec.surfaceId],
    );
    result.sessions++;

    // Add messages
    const convo = sampleConversations[i] ?? sampleConversations[0]!;
    const now = Date.now();
    let msgIdx = 0;

    for (let j = 0; j < Math.min(spec.messageCount, convo.length); j++) {
      const msgId = randomUUID();
      const role = j % 2 === 0 ? "user" : "assistant";
      const content = convo[j] ?? "...";
      const timestamp = now - (spec.messageCount - msgIdx) * 60000;

      await pool.query(
        `INSERT INTO messages (id, session_id, role, content, token_estimate, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [msgId, sessionId, role, content, Math.ceil(content.length / 4), timestamp],
      );
      result.messages++;
      msgIdx++;
    }

    console.log(`  ${GREEN}+${R} Session ${sessionId} (${spec.agentId}, ${msgIdx} messages)`);
  }

  // 3. Create sample memory entries (daily notes)
  console.log(`\n${BOLD}Seeding memory (daily notes)...${R}`);

  const sampleNotes = [
    { category: "decision", content: "User prefers TypeScript over JavaScript for all new projects" },
    { category: "outcome", content: "Successfully migrated database schema to v2 without downtime" },
    { category: "strategy", content: "Use RAG pipeline with Typesense for knowledge retrieval" },
    { category: "note", content: "User timezone is PST. Prefers morning standup summaries." },
    { category: "interaction", content: "User responds well to code examples over theoretical explanations" },
  ];

  for (const note of sampleNotes) {
    const noteId = `${SEED_PREFIX}note-${note.category}`;
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM daily_notes WHERE id = $1",
      [noteId],
    );
    if (rows.length > 0) {
      console.log(`  ${DIM}Skipping${R} note ${note.category} (exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO daily_notes (id, uid, workspace_id, category, content, date)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
      [noteId, DEV_USER_ID, DEV_WORKSPACE_ID, note.category, note.content],
    );
    result.memoryNotes++;
    console.log(`  ${GREEN}+${R} ${note.category}: ${note.content.slice(0, 60)}...`);
  }

  // 4. Create sample graph entities
  console.log(`\n${BOLD}Seeding memory (graph entities)...${R}`);

  const sampleEntities = [
    { name: "TypeScript", entityType: "technology", description: "Primary programming language" },
    { name: "PostgreSQL", entityType: "technology", description: "Main database" },
    { name: "Astra Platform", entityType: "project", description: "Multi-agent runtime platform" },
  ];

  for (const entity of sampleEntities) {
    const entityId = `${SEED_PREFIX}entity-${entity.name.toLowerCase().replace(/\s+/g, "-")}`;
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM graph_entities WHERE id = $1",
      [entityId],
    );
    if (rows.length > 0) {
      console.log(`  ${DIM}Skipping${R} entity ${entity.name} (exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO graph_entities (id, user_id, workspace_id, name, entity_type, description, score)
       VALUES ($1, $2, $3, $4, $5, $6, 1.0)`,
      [entityId, DEV_USER_ID, DEV_WORKSPACE_ID, entity.name, entity.entityType, entity.description],
    );
    result.graphEntities++;
    console.log(`  ${GREEN}+${R} ${entity.name} (${entity.entityType})`);
  }

  // 5. Create sample scheduled tasks
  console.log(`\n${BOLD}Seeding scheduled tasks...${R}`);

  const sampleTasks = [
    { name: "Daily Briefing", cron: "0 8 * * *", agentId: SAMPLE_AGENTS[0]!.id, payload: { type: "briefing" } },
    { name: "Weekly Research Digest", cron: "0 9 * * 1", agentId: SAMPLE_AGENTS[2]!.id, payload: { type: "digest", scope: "weekly" } },
  ];

  for (const task of sampleTasks) {
    const taskId = `${SEED_PREFIX}task-${task.name.toLowerCase().replace(/\s+/g, "-")}`;
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM scheduled_tasks WHERE id = $1",
      [taskId],
    );
    if (rows.length > 0) {
      console.log(`  ${DIM}Skipping${R} task ${task.name} (exists)`);
      continue;
    }

    await pool.query(
      `INSERT INTO scheduled_tasks (id, user_id, workspace_id, agent_id, name, cron_expression, payload, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)`,
      [taskId, DEV_USER_ID, DEV_WORKSPACE_ID, task.agentId, task.name, task.cron, JSON.stringify(task.payload)],
    );
    result.tasks++;
    console.log(`  ${GREEN}+${R} ${task.name} (${task.cron})`);
  }

  // Summary
  console.log(`\n${DIM}────────────────────────────────────────${R}`);
  console.log(`${BOLD}Seed complete:${R}`);
  console.log(`  Agents:     ${GREEN}${result.agents}${R} created`);
  console.log(`  Sessions:   ${GREEN}${result.sessions}${R} created`);
  console.log(`  Messages:   ${GREEN}${result.messages}${R} created`);
  console.log(`  Notes:      ${GREEN}${result.memoryNotes}${R} created`);
  console.log(`  Entities:   ${GREEN}${result.graphEntities}${R} created`);
  console.log(`  Tasks:      ${GREEN}${result.tasks}${R} created`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}Seed failed:${R}`, err);
  process.exit(1);
});
