# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Astra is a multi-agent runtime platform with dynamic agent creation, 92 built-in skills, 32 tools, hierarchical swarm orchestration, and a plug-and-play inference layer supporting 7 LLM providers (Grok, Groq, OpenAI, Gemini, Codex, Ollama, vLLM). Three deployment modes: zero-config `npx astra`, Docker Compose, or standalone CLI.

## Commands

```bash
npm run typecheck    # Type-check without emitting (tsc --noEmit) — run after every change
npm run dev          # Server mode: tsx watch (src/gateway/index.ts), auto-restarts
npm run cli          # Standalone CLI: interactive REPL agent
npm run cli:dev      # CLI with tsx watch (auto-restart on changes)
npm run setup        # TUI onboarding wizard (generates .env + astra.yml)
npm run build        # Compile TypeScript to dist/
npm start            # Production server (node dist/gateway/index.js)

# Zero-config CLI (manages Docker services automatically)
npx astra                        # Start gateway (wizard on first run)
npx astra chat                   # Interactive CLI agent
npx astra setup                  # Re-run onboarding wizard
npx astra setup --quickstart     # Provider + key only, all else defaulted
npx astra setup --reset          # Wipe config and re-run wizard
npx astra setup --non-interactive  # Derive config from env vars (CI)
npx astra stop                   # Stop Docker services
npx astra status                 # Show service status

# Docker (for local dev backing services)
docker compose up -d postgres typesense   # Services only
docker compose up -d                       # Full stack including gateway
```

No test suite is configured. Use `npm run typecheck` to verify correctness.

## Architecture — Request Flow

```
HTTP/WS/Channel Message
  → gateway/index.ts (Express + WS bootstrap, route mounting)
    → gateway/routes/chat.ts (parse request, resolve agent)
      → agents/loop.ts (core execution cycle)
        1. sessions/store.ts — resolve or create session by {uid, surface, surfaceId}
        2. sessions/compaction.ts — summarize old messages if context too large
        3. context/assembler.ts — SOUL.md prefix + system prompt + memory + history → ChatMessage[]
        4. inference/factory.ts → provider client (grok|groq|openai|gemini|Codex|ollama|vllm)
        5. tools/registry.ts — execute tool calls, feed results back (max 5 rounds)
        6. agents/post-turn-save.ts — auto-save memory
        7. events/bus.ts — emit typed events, fire webhooks
```

Streaming variant: `agents/loop-stream.ts` yields `AsyncGenerator<AgentStreamEvent>` for SSE/WebSocket.

## Key Architectural Patterns

### Startup / Service Initialization Order

`gateway/index.ts` bootstraps everything sequentially:
1. `loadEnv()` → environment config (single source of truth: `config/env.ts`)
2. `initJwt()`, `initTypesense()`, `initEmbeddings()`, `initPostgres()`
3. `runMigrations()` → auto-runs SQL files from `db/migrations/`
4. `loadAgentConfigs()` → seeds agents from `astra.yml` + Postgres into `config/agents.ts` registry
5. `import "../tools/index.js"` → triggers all tool self-registrations
6. `discoverSkills()` + `discoverPlugins()` → auto-discover from filesystem
7. Mount Express routes with middleware chain (auth → workspace → rate limit → token budget)
8. Start channels (Telegram, Discord, etc.) based on env vars
9. Start scheduler (6 cron jobs)
10. Graceful shutdown: self-healing → hot-reload → skills → plugins → gRPC → scheduler → channels → HTTP → Postgres

### Singletons and Init Functions

Core services use module-level singletons initialized via `init*()` functions called once at startup:
- `config/postgres.ts` — `initPostgres()` creates the pg pool
- `config/typesense.ts` — `initTypesense()` creates the Typesense client
- `config/agents.ts` — `Map<string, AgentConfig>` in-memory registry
- `events/index.ts` — `getEventBus()` returns the singleton EventBus

### Tool Registration (self-registering at import time)

Tools call `registerTool()` at module scope. The import in `tools/index.ts` triggers registration:

```typescript
// src/tools/my-tool.ts
import { z } from "zod";
import { registerTool } from "./registry.js";

const Params = z.object({ query: z.string() });

registerTool({
  name: "my-tool",
  description: "Does a thing",
  parameters: Params,
  execute: async (params, ctx) => {
    // params is typed as z.infer<typeof Params>
    return { result: "done" };
  },
});
```

Tool policy cascades: global defaults → agent `tools.allow`/`tools.deny` → spawn restrictions. **Deny always wins.**

### Skill Auto-Discovery

Skills are auto-discovered from `src/skills/definitions/*/index.ts` at startup. Each exports a `SkillDefinition` with a `SkillManifest` (id, category, tool names) and optional `getPromptContext()`. When an agent lists a skill, its tools are merged into the agent's allow set and its prompt context is injected into the system prompt.

### Inference Provider Interface

All 7 providers implement `InferenceClient` from `inference/types.ts`:
- `chat(request: InferenceRequest): Promise<InferenceResponse>`
- `chatStream(request: InferenceRequest): AsyncGenerator<InferenceStreamDelta>`

The factory (`inference/factory.ts`) creates clients on demand, caches by `provider:modelId:endpoint` key, and wraps each in a resilient layer (retry + fallback + circuit breaker). Provider enum: `grok | groq | openai | gemini | Codex | ollama | vllm`.

`inference/circuit-breaker.ts` — per-provider CircuitBreaker (closed → open → half-open). Tripped providers are skipped immediately in the resilient layer rather than timing out on every call.

### SOUL.md as Cached Prompt Prefix

`SOUL.md` defines ethical constraints for all agents. Loaded once on startup, cached in process memory, and prepended to every system prompt as a stable prefix. This enables provider-side prompt caching (Codex, OpenAI, Gemini all cache stable prefixes).

### Context Assembly

`context/assembler.ts` builds the final `ChatMessage[]` array for inference:
SOUL.md prefix → system prompt template (with `{{variable}}` and `{{#if var}}...{{/if}}` interpolation) → memory context → conversation history → tool schemas

### Agent Spawning Permission Model

- Parent must have `spawn.enabled = true`
- Target must be in `spawn.allowedTargets`
- Sub-agent tools = intersection of parent and target allow lists (no privilege escalation)
- Max depth enforced (default 2, max 3)

### Memory System (5-tier)

- **Tier 1**: Session messages in PostgreSQL (ephemeral, HNSW m=8, ef=32)
- **Tier 2**: Categorized daily notes (decision, outcome, strategy, note, interaction)
- **Tier 3**: User profile with extensible `domains` map
- **Tier 4**: Graph — entity relationships with reinforcement scoring (HNSW m=24, ef=128)
- **Tier 5**: Procedural — learned workflows with fast-path trigger matching

Search uses RRF fusion across Typesense (BM25 + vector) and pgvector (cosine similarity). Embeddings auto-detect: Gemini API if `GEMINI_API_KEY` set, otherwise local fallback.

Additional memory infrastructure:
- `memory/embedding-cache.ts` — LRU(2048) + Postgres SHA-256 keyed cache; wraps all embedding calls in `embeddings.ts`
- `memory/dedup.ts` — near-duplicate consolidation via cosine self-join (0.92 threshold)
- `memory/cold-store.ts` — snapshot all memory tiers to S3/GCS/local (`COLD_STORE_BACKEND=s3|gcs|local`)
- `cache/semantic.ts` — pgvector semantic response cache (0.97 similarity); enabled via `SEMANTIC_CACHE_ENABLED=true`

### Event System

Typed event bus (`events/bus.ts`) with Zod-validated payloads. Key events: `agent.started`, `agent.completed`, `agent.stream.delta`, `tool.executed`, `memory.written`, `session.created`, `webhook.dispatched`.

`events/audit.ts` subscribes to the bus and writes structured rows to the `audit_log` table for compliance/debugging.

### Secrets Backend

`src/secrets/vault.ts` — pluggable backend (Vault KV v2 / AWS ASM / env fallback) with TTL cache. Controlled by `SECRET_BACKEND=vault|asm|env`. `secrets/scanner.ts` detects and redacts high-entropy strings from memory writes. `workspaces/secrets.ts` stores per-workspace API key overrides in `workspace_secrets` (encrypted at rest).

## TypeScript Conventions

- **ESM only**: `"type": "module"` — all local imports **must** use `.js` extensions (Node16 resolution)
- **Strict mode**: `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- **Target**: ES2022, Node16 module resolution
- **Zod-first validation**: All external data uses Zod schemas. Types are derived via `z.infer<typeof Schema>`
- **Naming**: camelCase for variables/functions, PascalCase for types/interfaces, kebab-case for file names
- **Error handling**: Tools return errors as `ToolResult.error` strings — the agent loop is resilient to individual tool failures
- **Logging**: `utils/logger.ts` with `createLogger("module-name")` for structured output
- **`getAgentConfig(id)` throws** `Error("Unknown agent: ...")` when not found — callers must try-catch and return 404, not let it bubble to 500
- **`startScheduler()` is async** — always `await` it in `gateway/index.ts` or dynamic DB agents won't load before traffic opens
- **Crypto**: use `import { randomUUID } from "node:crypto"` — never the global `crypto.randomUUID()`
- **Postgres intervals**: parameterize as `INTERVAL '1 day' * $N` — never string-interpolate user input into SQL

## Security Patterns

### Authentication
- **API key comparison**: always use `timingSafeEqual(Buffer.from(provided), Buffer.from(expected))` from `node:crypto` — plain `!==` leaks key length via timing
- **New admin-only routes**: check whether the route is mounted under an auth middleware in `gateway/index.ts`; `app.use("/skills", createSkillRouter())` has no auth — add `jwtAuth()` at the route level if the router is public
- **Ownership before grants**: when creating cross-resource grants, verify the granting party owns the resource first — `agent_configs WHERE id = $1 AND workspace_id = $2`

### SSRF
- **All outbound HTTP calls with user-supplied URLs** must go through `src/utils/ssrf-guard.ts` `isBlockedUrl()` — covers session webhooks, registered webhooks, heartbeat URLs; `url-fetch.ts` also uses it
- Applies to: `fetch(userUrl, ...)`, `axios.get(userUrl)`, any outbound call where URL originates from user input or DB

### SQL / Queries
- **Table allowlist regex must handle `schema.table`** — capture both tokens and block `pg_catalog`, `information_schema`, `pg_toast` explicitly; a single-token regex passes `public.billing_usage`
- **`conditions.slice(0, -0)`** equals `conditions.slice(0, 0)` = empty — always yields the fallback, silently breaking filters; use `conditions.join(" AND ")` for count queries

### Tools
- **File path inputs**: always `resolve(filePath)` and verify it starts with `process.cwd() + "/"` before reading or writing — blocks `../../.env` traversal
- **Secret fields**: strip from GET single-item responses the same way list endpoints do — `const { secret: _s, ...safe } = record; res.json(safe)`
- **New route handlers**: validate `req.body` with a Zod schema before destructuring — raw `req.body as { ... }` casts bypass all validation

### Group / Workspace Isolation
- **Group session queries** must include `workspace_id` in WHERE — surface+surfaceId alone spans workspaces; omitting the workspace filter lets cross-workspace `surfaceId` guessing disrupt other teams' sessions

## Adding New Components

### New tool
1. Create `src/tools/my-tool.ts` — define Zod params, implement `execute()`, call `registerTool()`
2. Add `import "./my-tool.js"` to `src/tools/index.ts`

### New skill
1. Create `src/skills/definitions/my_skill/index.ts`
2. Export default a `SkillDefinition` with `manifest`, `init()`, and optional `getPromptContext()`
3. Auto-discovered at startup — no manual registration

### New inference provider
1. Create `src/inference/my-provider.ts` implementing `InferenceClient`
2. Add provider to the `AgentConfig.model.provider` Zod enum in `src/agents/types.ts`
3. Add case in `createPrimaryClient()` in `src/inference/factory.ts`

### New messaging channel
1. Create `src/channels/my-channel.ts` extending the channel base from `channels/base.ts`
2. Add env vars to `src/config/env.ts`
3. Register start/stop in `src/gateway/index.ts`

### New database migration
1. Create `src/db/migrations/NNN-description.sql` (next number is 031)
2. Runs automatically on startup in alphabetical order, tracked by **filename** in `schema_migrations`
3. Never reuse a number prefix — two `023-*.sql` files both run but the second's `IF NOT EXISTS` is a no-op, silently leaving schema differences unresolved

### New route
1. Create router factory in `src/gateway/routes/my-route.ts`
2. Mount in `src/gateway/index.ts` with appropriate middleware (`jwtAuth`, `workspaceResolver`, etc.)

## Configuration

### astra.yml (declarative agent teams + system config)

Single YAML file defining: `settings` (defaults), `quotas`, `approval`, `selfHealing`, `dream`, `research`, `evolution`, `localModels`, `hotReload`, `channels`, and `agents`. Gateway loads on startup, seeds agents into Postgres. Change and restart to update.

### Required env vars (server mode)
`JWT_SECRET`, `TYPESENSE_API_KEY`, `INTERNAL_API_KEY`, `PG_HOST/PORT/DATABASE/USER/PASSWORD`, plus at least one provider key (`GROK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `OLLAMA_BASE_URL`).

Notable optional vars: `JWT_SECRET_PREV` (key rotation), `BIND_JWT_TO_DEVICE` (device fingerprint), `GRPC_TLS_CERT/KEY/CA` (mTLS), `SECRET_BACKEND/VAULT_ADDR/VAULT_TOKEN` (secrets), `SEMANTIC_CACHE_ENABLED`, `COLD_STORE_BACKEND`, `SPLADE_ENDPOINT`, `TYPESENSE_NODES` (multi-node cluster), `MEMORY_TTL_DAYS`.

### Standalone CLI
Only needs one inference API key + PostgreSQL. See `.env.standalone`.

## Docker (local development)

```bash
docker compose up -d postgres typesense   # Backing services for npm run dev / cli
docker compose up -d                       # Full stack including gateway
```
