# Open Astra — [openastra.net](https://openastra.net)

**The agent runtime built for engineers.**

Open Astra for teams who build on top of agents — 5-tier memory, hierarchical swarms, 10 inference providers, B2B operations platform, and a full REST API. Zero-config to start, production-ready when you need it.

125 skills · 81 tools · 10 LLM providers · 9 channels · 5-tier memory · B2B operations platform · outcome billing · durable execution

**Four ways to run:** zero-config `npx astra` (recommended), full-stack Docker Compose, standalone CLI, or multi-tenant API server.

**B2B Platform:** Durable execution engine, human-in-the-loop approval gates, tamper-evident audit trail, signed skill registry, SEO and cloud infrastructure skill packs, outcome-based billing, egress-only data plane with DLP, and multi-tenant RBAC governance.

**Built for teams:** Shared workspace memory, team knowledge base (ADRs, standards, runbooks), codebase indexing with symbol search, cost dashboard, real-time multi-user collaboration, and built-in diagnostics.

---

## Security by Default

Open Astra ships zero community plugins and zero external MCP servers. Every tool, skill, inference adapter, and memory operation in your deployment is code you can read, audit, and modify.

There are no marketplace extensions phoning home. There are no hosted MCP servers running proprietary code between your data and your agent. If something runs in your agent loop, it is in this repository.

Security hardening includes fail-closed JWT revocation, row-level security middleware, SSRF IP pinning with redirect blocking, brute-force login protection, and GDPR-complete user data erasure across all memory tiers.

---

## Why Open Astra

**What does a team of engineers or researchers actually need from an agent runtime?**

Not a chat assistant. An autonomous backend — one that can index a codebase, track decisions in a knowledge graph, spawn sub-agents for parallel research, enforce per-agent token budgets, survive a process crash, and integrate into a CI pipeline via REST API. Something you deploy once and build *on top of*, not a tool you run *alongside*.

- **Memory**: 5-tier graph — ephemeral session messages, daily notes (7-day lookback), long-term profile, typed entity relationships with multi-hop traversal and temporal decay, procedural workflows that fire before the LLM sees the prompt, and a team-scoped workspace graph for shared knowledge. Teams write ADRs, runbooks, and standards into a structured knowledge base with semantic search.
- **Context**: Assembled dynamically — embedding-aware message selection, content-aware token estimation, live skill context injection, cross-workspace memory sharing, and RRF fusion across Typesense and pgvector — so agents stay within token budgets without losing relevant history.
- **Orchestration**: Hierarchical swarms with dynamic role cards — a root agent decomposes tasks via a planner (using all available role types automatically), sub-agents write to a shared blackboard, conflicts trigger a debate protocol, and the root synthesizes. Each sub-agent's tool access is the intersection of parent and child allow lists — no privilege escalation.
- **Infrastructure**: Multi-tenant API server with JWT auth, billing tiers, per-agent quota enforcement, self-healing, 198 versioned database migrations, distributed trace IDs across all agent events, per-user sliding-window rate limiting, and ordered graceful shutdown.
- **B2B Operations**: Durable execution with checkpoint persistence, human-in-the-loop approval gates with risk scoring, SHA-256 hash-chained audit trail, signed skill registry with RSA verification, outcome-based billing (pay for results, not tokens), egress-only data plane with DLP, and tenant governance with RBAC and plan-based quotas.

---

## Quick Start — Zero Config (Recommended)

One command. No manual `.env` files, no `docker compose`, no configuration. Astra manages everything.

```bash
npx astra
```

On first run, an interactive wizard asks 2-3 questions (pick a provider, paste an API key), then:
1. Auto-generates secrets (JWT, Typesense key, Postgres password)
2. Pulls and starts Docker containers (Postgres + Typesense)
3. Waits for health checks to pass
4. Launches the gateway

Config is saved to `~/.astra/config.json` — subsequent runs skip the wizard and start instantly.

### CLI Commands

```bash
npx astra              # Start gateway (runs wizard on first use)
npx astra chat         # Interactive CLI agent instead of gateway
npx astra doctor       # Run diagnostics (check health of all services)
npx astra costs        # Show cost dashboard (token usage + spend)
npx astra setup        # Re-run the onboarding wizard
npx astra status       # Show service status
npx astra stop         # Stop Docker services
npx astra reset        # Wipe all config, containers, and volumes
```

**Requirements:** Node.js 20+ and Docker.

## Quick Start — Docker Compose

Deploy the full stack with docker-compose. More control over configuration.

```bash
# 1. Configure
cp .env.example .env
# Edit .env — set API keys (at minimum: ANTHROPIC_API_KEY or OPENAI_API_KEY)

# 2. Define your agent team (or use the default astra.yml)
# Edit astra.yml to customize agents, models, and channels

# 3. Deploy everything
docker compose up -d
```

This starts **PostgreSQL (pgvector)**, **Typesense**, and the **Astra Gateway** — all pre-configured. Agents are loaded from `astra.yml` on startup.

## Quick Start — TUI Setup Wizard

First-time setup with an interactive terminal wizard that walks you through every configuration option:

```bash
npm install
npm run setup
```

The wizard configures: deployment mode, inference providers, database, local models (Ollama), dream mode, deep research, channels, file access restrictions, quotas, and security. Generates `.env` and `astra.yml` automatically.

### Agent Team Configuration (`astra.yml`)

Define agent teams declaratively. Each agent gets its own model, system prompt, skills, tool access, and file restrictions:

```yaml
settings:
  defaultAgent: assistant
  defaultProvider: claude
  defaultModel: claude-sonnet-4-6

workspace:
  name: my-team
  owner: user-123
  members:
    - userId: user-456
      role: member

quotas:
  tokens:
    maxPerHour: 200000
    maxPerDay: 1000000
  cost:
    maxPerDay: 500        # $5.00
  spawn:
    maxDepth: 3
    maxConcurrent: 5

approval:
  requireApproval:
    - shell_execute
    - financial_action
  autoApprove:
    - memory_write

selfHealing:
  enabled: true
  maxConsecutiveFailures: 3
  compactionThreshold: 40

channels:
  telegram:
    enabled: true
  discord:
    enabled: true

agents:
  assistant:
    displayName: My Assistant
    model:
      provider: claude
      modelId: claude-sonnet-4-6
    skills: [brave_search, summarize, calculator]
    tools:
      allow: [memory-write, memory-search]
    fileAccess:
      restricted: true
      allowedPaths: [/data/workspace]

  researcher:
    displayName: Research Agent
    model:
      provider: claude
      temperature: 0.3
    skills: [brave_search, web_scrape, knowledge_retrieve]

  deep_researcher:
    displayName: DeepResearcher (Autonomous PhD Mode)
    model:
      provider: grok
      modelId: grok-4.1-fast
    skills: [brave_search, web_scrape, summarize, knowledge_retrieve]
    tools:
      deny: [file-read, file-write, shell-execute]
    spawn:
      enabled: true
      allowedTargets: [researcher]
      maxDepth: 3

  coder:
    displayName: Code Agent
    model:
      provider: claude
      temperature: 0.2
    skills: [code_execute]
    spawn:
      enabled: true
      allowedTargets: [researcher]
```

Change the file and restart the gateway — agents update automatically.

## Messaging Channels

Chat with your agents through 9 messaging platforms with Postgres-backed persistent memory, Typesense semantic search, and real cost tracking.

### Supported Channels

| Channel | Setup |
|---------|-------|
| **Telegram** | Bot token via @BotFather |
| **iMessage** | Mac + [BlueBubbles](https://bluebubbles.app) server |
| **WhatsApp** | Meta Cloud API (phone number ID + access token) |
| **Signal** | [signal-cli](https://github.com/AsamK/signal-cli) REST API |
| **Discord** | Bot token via Discord Developer Portal |
| **Slack** | Bot token + signing secret |
| **Google Chat** | Service account key |
| **GitHub App** | App ID + webhook secret (issues, PRs, comments — HMAC-verified) |
| **Linear** | Webhook secret + API key (issues/comments — label-based agent routing, bidirectional) |

```bash
# Example: Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
docker compose restart gateway

# Example: Discord
DISCORD_BOT_TOKEN=your-bot-token
docker compose restart gateway
```

### Channel Commands

All messaging channels support these commands:

| Command              | Description                                      |
|----------------------|--------------------------------------------------|
| `/start`             | Welcome message + agent info                     |
| `/reset`             | Clear conversation history                       |
| `/agent`             | Show current agent details                       |
| `/agents`            | List all available agents                        |
| `/switch <id>`       | Switch to a different agent (persisted)           |
| `/memory <query>`    | Semantic search across your conversation memory  |
| `/usage`             | Show token usage and costs this month            |
| `/help`              | Show available commands                          |

## Quick Start — Standalone CLI

Chat with an agent directly from your terminal. No frontend, no API server.

```bash
docker compose up -d postgres typesense   # services only
npm install
cp .env.standalone .env
npm run cli
```

### CLI Options

```bash
npm run cli -- --provider openai     # force a specific provider
npm run cli -- --model gpt-4o        # force a specific model
npm run cli -- --agent my-agent      # use a named agent from the database
npm run cli -- --reset               # start with a fresh session
npm run cli -- --help                # show all options
```

### CLI Commands

| Command   | Description                        |
|-----------|------------------------------------|
| `/reset`  | Clear conversation, start fresh    |
| `/config` | Show current agent configuration   |
| `/help`   | List available commands            |
| `/quit`   | Exit                               |

## Deploy to DigitalOcean

### Option A: One-Click Droplet ($24/mo — recommended)

Full stack on a single Droplet. Docker, Postgres, Typesense, and the gateway — pre-installed via cloud-init.

```bash
# Requires: doctl CLI authenticated (doctl auth init)
./deploy/deploy-droplet.sh

# Then SSH in and add your API keys:
ssh root@<droplet-ip>
cd /opt/astra
nano .env
docker compose up -d
```

Or create manually:

```bash
doctl compute droplet create astra \
  --image ubuntu-24-04-x64 \
  --size s-2vcpu-4gb \
  --region nyc1 \
  --user-data-file deploy/cloud-init.yml \
  --ssh-keys $(doctl compute ssh-key list --format ID --no-header | head -1)
```

| Droplet Size | Spec | Cost | Use Case |
|---|---|---|---|
| `s-1vcpu-2gb` | 1 vCPU, 2 GB | $12/mo | 1-2 agents, light use |
| `s-2vcpu-4gb` | 2 vCPU, 4 GB | $24/mo | Standard (recommended) |
| `s-4vcpu-8gb` | 4 vCPU, 8 GB | $48/mo | Many agents/channels |

### Option B: App Platform (managed)

Managed deployment with auto-scaling, managed Postgres, and deploy-on-push from GitHub.

```bash
doctl apps create --spec deploy/do-app-spec.yml
```

After deploy, set your API keys in the DigitalOcean dashboard under App > Settings > Environment Variables.

### What gets deployed

Both options provision the same stack:

```
Droplet / App Platform
  ├── PostgreSQL 17 (pgvector)  — sessions, memory, agent configs, audit
  ├── Typesense 27.1            — hybrid BM25 + vector semantic search
  └── Astra Gateway             — Express + WebSocket + all channels
```

Secrets (`JWT_SECRET`, `INTERNAL_API_KEY`) are auto-generated on the Droplet path. On App Platform, update them in the dashboard after first deploy.

## Architecture

```
Gateway (Express + WebSocket)
  ├── /auth/*             → Register, login, refresh, logout (JWT)
  ├── /agent/chat         → Agent Loop → Inference (per-agent provider)
  ├── /agent/chat/stream  → SSE streaming
  ├── /agents/*           → CRUD agent configs (dynamic creation + versioning)
  ├── /traces/*           → Agent execution traces (tool calls, token usage, circuit breakers)
  ├── /jobs/*             → Background job queue (enqueue, status, cancel)
  ├── /memory-profiles/*  → Workspace-scoped memory tier config
  ├── /workspaces/*       → Workspace management
  ├── /webhooks/*         → Webhook management
  ├── /onboarding/setup   → First-run workspace + agent creation
  ├── /autonomous/*       → Autonomous agent execution
  ├── /admin/*            → Monitoring
  ├── /diagnostics/*      → Health diagnostics (astra doctor) + circuit breaker states
  ├── /costs/*            → Cost dashboard (astra costs)
  ├── /openapi.json       → OpenAPI 3.1 spec (machine-readable, all endpoints)
  └── WebSocket /ws       → Real-time push (bidirectional streaming)

Channels (9 platforms — shared abstraction)
  ├── Telegram Bot    (long polling, @mention detection, group support)
  ├── iMessage        (BlueBubbles webhooks, attachment support)
  ├── WhatsApp        (Meta Cloud API, webhook verification)
  ├── Signal          (signal-cli REST, phone number routing)
  ├── Discord         (bot gateway, slash commands)
  ├── Slack           (bot events, signing secret verification)
  ├── Google Chat     (service account, space events)
  ├── GitHub App      (webhook events: issues, PRs, comments — HMAC-verified)
  ├── Linear          (webhook events, label→agent routing, bidirectional GraphQL comments)
  └── Standalone CLI  (readline REPL with streaming)

Agent Runtime
  ├── Agent Loop       (resolve session → context → inference → tools → respond)
  ├── Agent Spawning   (sub-agent delegation with permission sandboxing)
  ├── Swarm Mode       (dynamic hierarchical multi-agent coordination)
  ├── Orchestrator     (multi-agent task routing)
  ├── Meta-Controller  (multi-swarm dashboard, resource allocation, rebalancing)
  ├── Blackboard       (shared state for inter-agent communication)
  │   └── Topic Channels  (named pub/sub for selective swarm communication)
  ├── Self-Healing     (auto-restart crashed agents + context compaction)
  ├── Approval System  (human-in-the-loop for sensitive actions)
  ├── Quota Enforcer   (per-agent token/cost/request limits)
  ├── Rate Limiting    (per-user sliding-window RPM/burst via X-RateLimit-* headers)
  ├── Agent Traces     (execution traces: tool calls, circuit breaker events, token counts)
  ├── Job Queue        (Postgres-backed background jobs with retry, progress, worker pool)
  ├── Agent Versioning (auto-snapshot on update, rollback, custom labels)
  ├── Circuit Breaker  (per-provider open/closed/half-open states + dashboard)
  ├── PII Detection    (7 pattern types: email, phone, SSN, CC, IP, passport — block/redact/allow)
  ├── Code Sandbox     (Docker / process / none isolation modes with timeout + memory limits)
  ├── Memory Profiles  (workspace-scoped tier enables, topK, score thresholds, prompt suffix)
  ├── Tool Hot-Reload  (fs.watch-based auto-reload with 200ms debounce, non-production only)
  ├── Diagnostics      (astra doctor — 12 checks across 6 categories)
  ├── Cost Dashboard   (astra costs — by agent, user, model + trend)
  ├── Deep Research    (autonomous PhD-style multi-day research)
  ├── Dream Mode       (overnight local-model scenario simulation)
  ├── Persona Evolution(feedback-driven prompt optimization)
  ├── Debate Protocol  (conflict resolution with evidence witnesses)
  ├── Ethical Check    (post-generation ethical validation with configurable guidelines)
  ├── Agent Therapy    (self-reflection journal, mood tracking, failure analysis)
  ├── Health Scorecard (agent reliability, efficiency, memory hygiene scoring)
  ├── Evolution Engine (goal-driven quality/relevance feedback collection)
  ├── Agent Cloning    (versioning + lineage tracking)
  ├── Agent Specialization Router (automatic work domain division for 10-15+ agent teams)
  └── Optimizer        (A/B testing + prompt tuning)

Inference Layer (10 providers)
  ├── Grok        (x.ai API, cluster-pinned caching via x-grok-conv-id)
  ├── OpenAI      (automatic prefix caching, 1024+ tokens)
  ├── Gemini      (implicit auto + explicit CachedContent for large prompts)
  ├── Claude      (explicit cache_control breakpoints on system + tools)
  ├── Groq        (LPU hardware, ultra-fast open model inference)
  ├── Ollama      (local models, privacy-first)
  ├── vLLM        (self-hosted, OpenAI-compatible)
  ├── Bedrock     (AWS-hosted models via native SDK)
  ├── Mistral     (Mistral AI API)
  ├── OpenRouter  (unified gateway to 200+ models)
  └── Local Router  (complexity-based routing: local vs. cloud)
  ├── Circuit Breaker → per-provider failure detection (closed/open/half-open)
  ├── Warm Pool       → connection pre-warming for low-latency first calls
  ├── Race Mode       → parallel provider racing for lowest latency
  ├── Benchmarker     → model performance comparison and scoring
  ├── Tool Cache      → cache tool call results to avoid redundant execution
  └── Semantic Cache  → pgvector response cache at 0.97 similarity threshold

Memory Layer (5-tier + team)
  ├── Tier 1: Ephemeral   → session messages (PostgreSQL, HNSW m=8/ef=32)
  ├── Tier 2: Daily       → categorized daily notes (decision, outcome, strategy)
  ├── Tier 3: Long-term   → user profile + strategic notes
  ├── Tier 4: Graph       → entity relationships + reinforcement scoring (HNSW m=24/ef=128)
  ├── Tier 5: Procedural  → learned workflows with fast-path matching
  ├── Workspace Memory    → team-scoped entries (decisions, ADRs, standups, notes)
  ├── Team Propagation    → cross-user learning promotion with dedup + relevance scoring
  ├── Knowledge Base      → structured knowledge (ADRs, standards, runbooks, FAQs, glossary)
  ├── Knowledge Inject    → external data injection with MD5 dedup + relevance scoring
  ├── RAG Pipeline        → document upload, chunking, pgvector search (wired into tiered search)
  ├── Tiered Search       → RRF fusion across Typesense + pgvector + RAG documents, profile-controlled
  ├── Memory Profiles     → workspace-scoped tier config (enable/disable, topK, score thresholds)
  ├── Embedding Cache     → LRU(2048) + Postgres SHA-256 keyed cache (wraps all providers)
  ├── Near-Dedup          → cosine self-join consolidation at 0.92 threshold
  ├── Cold Store          → S3/GCS/local snapshot of all memory tiers (configurable backend)
  ├── Semantic Cache      → pgvector response cache at 0.97 similarity (opt-in)
  ├── Contextual Boost    → dynamic per-tier RRF weights based on task/phase/debate context
  ├── Memory Feedback     → post-synthesis utility ratings to fine-tune RRF weights
  ├── Memory Compression  → on-demand tier compression with configurable strategies
  ├── Memory Budget       → per-agent memory tier limits with enforcement + pruning
  ├── Memory Propagation  → cross-tier promotion (daily→profile, daily→graph, graph→profile)
  ├── Consistency Check   → cross-tier contradiction detection with auto-fix
  ├── Relation Decay      → time-based graph edge weight decay with configurable half-life
  ├── Session Branching   → git-style fork/diff/merge for memory state
  ├── Conflict-Free Merge → CRDT-inspired merge protocol for parallel branches
  ├── Scenario Engine     → what-if comparison engine via memory branch forking
  ├── Auto-Extract        → knowledge-graph extraction from conversations
  ├── Graph Schema Evolve → proposal/approve/reject workflow for graph entity/edge types
  ├── Summarizer          → daily/weekly memory rollups
  ├── Smart Context       → embedding-aware message selection (relevance over recency)
  ├── Cross-Workspace     → memory sharing with permission controls
  ├── Context Bridge      → cross-session context carry-over (resume context across sessions)
  └── Memory Lifecycle    → automated cleanup cron jobs (expiry, dedup, compaction)

Ethics & Bootstrap Layer
  ├── SOUL.md             → ethical framework cached as system prompt prefix
  └── workspace/          → drop .md files here: auto-loaded, DB-synced, hot-reloaded

Security
  ├── SOUL.md             → ethical framework cached as system prompt prefix
  ├── THREAT_MODEL.md     → STRIDE analysis, trust boundaries, mitigations
  ├── PII Scanner         → block/redact/allow policy before memory writes
  ├── Secrets Backend     → Vault KV v2 / AWS ASM / env fallback with TTL cache
  ├── HMAC Verification   → timingSafeEqual webhook signature checks
  ├── RBAC               → owner > editor > tool_runner > viewer role hierarchy
  ├── Fail-Closed Revoke  → JWT revocation defaults to deny on backend failure
  ├── RLS Middleware       → row-level security enforcement at the gateway layer
  ├── SSRF Hardening      → IP pinning + redirect following blocked for internal ranges
  ├── Brute-Force Guard   → login attempt throttling with lockout
  ├── GDPR Erasure        → complete user data deletion across all memory tiers
  ├── Prompt Injection  → detection and blocking of injection attempts
  ├── Intrusion Detect  → anomaly-based intrusion detection
  ├── Data Residency    → geographic data storage compliance
  ├── Content Watermark → authenticity watermarking for agent output
  ├── Consent Tracking  → user consent management and enforcement
  └── Diff Privacy      → differential privacy noise injection with budget tracking

B2B Operations Platform
  ├── Durable Execution  → checkpoint persistence, exponential backoff, dead-letter queue, heartbeat liveness
  ├── Approval Gates     → structured proposals, risk scoring (low/medium/high/critical), auto-approve policies, escalation chains
  ├── Audit Trail        → SHA-256 hash-chained log, HMAC signing, JSONL/CSV export, tamper detection
  ├── Signed Skill Registry → RSA-SHA256 package signatures, publisher trust levels, version pinning
  ├── SEO Ops Skills     → site audit, keyword rank tracker, content gap analyzer, schema markup validator, link health checker
  ├── Cloud Health Skills→ resource scanner, cost anomaly detector, drift detector, cert monitor, scaling advisor
  ├── Outcome Billing    → metered by results (rankings, cost saved, drift remediated), not tokens
  ├── Data Plane         → egress-only with DLP (SSN, credit card, API key, PII detection), destination allowlists
  └── Tenant Governance  → workspace isolation, RBAC (owner/admin/operator/viewer), 30 permissions, plan-based quotas

Data Layer
  ├── PostgreSQL  (sessions, users, billing, agents, memory, audit — 198 migrations)
  ├── Typesense   (semantic memory search, embeddings via Gemini)
  └── gRPC        (optional inter-service communication)

Scheduler
  ├── Cost snapshot       (1 AM daily — aggregate billing into cost_snapshots)
  ├── Token cleanup       (3 AM daily)
  ├── Memory consolidation(4 AM daily)
  ├── Memory summarization(5 AM daily)
  ├── Graph decay         (Sunday 4:30 AM weekly)
  ├── Dream mode          (user-configured, checked every 30 min)
  ├── Research iterations (checked every 30 min for active tasks)
  ├── Memory expiry       (3 AM daily — remove entries past TTL)
  ├── Memory dedup        (4:30 AM daily — near-duplicate consolidation)
  └── SLO check           (every 5 min — service-level objective monitoring)

Engineering Tools
  ├── Codebase Index      → file tree walker, symbol extraction (TS/JS/Python/Go/Rust/Java)
  ├── Codebase Search     → pgvector similarity search with language/symbol filters
  ├── Code Review Swarm   → autonomous multi-agent code review (security, perf, style, logic)
  ├── Git Operations      → commit, checkout, push, stash
  ├── GitHub Operations   → create PR, list checks, merge PR, list branches
  └── Test Runner         → auto-detect framework, parse results, generate test skeletons

Observability
  ├── Agent Traces     → per-run tool calls, token counts, circuit breaker events
  ├── Agent Replay     → execution replay/debugging from stored traces
  ├── Alert Rules      → custom alert conditions with severity levels
  ├── Tool Timeline    → detailed per-tool execution timeline visualization
  ├── Cost Anomaly     → spending spike detection and alerting
  ├── Latency Heatmap  → request latency visualization by endpoint/provider
  ├── SLO Monitor      → service-level objective tracking (every 5 min)
  ├── Dashboard SSE    → server-sent events for live dashboard push updates
  └── OpenTelemetry    → OTLP export for external observability platforms

Multi-Person Workflow
  ├── Real-Time Collab    → multi-user sessions with role-based permissions (owner/editor/viewer/agent)
  ├── Conflict-Free Merge → CRDT-inspired parallel branch merging with set-union semantics
  ├── Team Memory         → cross-user learning propagation with auto-scan + dedup
  ├── Agent Specialization→ domain registry preventing duplicate effort across 10-15+ agents
  └── Provider Router     → cross-provider routing with cost/latency/quality scoring

Skills (125 built-in, auto-discovered)
  └── src/skills/definitions/  → one directory per skill

Tools (81 built-in)
  ├── memory-write, memory-search, memory-export
  ├── agent-spawn, model-inference
  ├── file-read, file-write, shell-execute, url-fetch
  ├── graph-query, rag-search
  ├── approval-resolve, research-manage, dream-manage
  ├── web-search, code-execute, image-generate, http-request
  ├── database-query, calendar-event, email-send, pdf-read
  ├── clipboard, screenshot
  ├── prop-lookup, line-compare, kelly-criterion
  ├── portfolio-optimizer, x-search, push-notify
  ├── workspace-memory, workspace-knowledge
  ├── codebase-index, codebase-search
  │
  │  Swarm & orchestration
  ├── code-review-swarm, swarm-observer, meta-controller
  ├── blackboard-topics, debate-witnesses
  │
  │  Memory management
  ├── memory-compress, memory-propagation, memory-budget
  ├── consistency-check, memory-feedback, relation-decay
  ├── contextual-boost, knowledge-inject
  │
  │  Session & scenario
  ├── session-branch, scenario-engine, conflict-free-merge
  │
  │  Multi-modal & routing
  ├── multimodal-input, provider-router
  │
  │  Agent self-improvement
  ├── ethical-check, agent-therapy, health-scorecard, evolution-feedback
  │
  │  Multi-person workflow
  ├── team-memory-propagate, agent-specialization-router
  │
  │  Workspace
  ├── prompt-templates, graph-schema-evolution
  └── ...

Plugins
  ├── Auto-discovered from plugins/ directory
  ├── Real-Time Collaboration (WebSocket sessions, presence, role-based permissions)
  └── Hot-reload (filesystem watcher with debounce)
```

## Project Structure

```
astra.yml              # Declarative agent team + system configuration
astra.mjs              # npx entry point (ESM shim → dist/bin/astra.js)
SOUL.md                # Ethical framework (cached in system prompts)
workspace/             # Drop .md files here to bootstrap agent context (auto-loaded, hot-reloaded)
dashboard/             # OpenAstra Dashboard v2 — web-based real-time control UI
docker-compose.yml     # Full-stack deployment
deploy/                # DigitalOcean deployment (cloud-init, doctl, App Platform)

src/
├── bin/              # Zero-config CLI (npx astra)
│   ├── astra.ts      # Main entry point + subcommand routing
│   ├── config.ts     # Config persistence (~/.astra/config.json)
│   ├── docker.ts     # Docker container lifecycle management
│   ├── onboard.ts    # First-run onboarding wizard
│   └── tui.ts        # Shared TUI helpers (readline prompts, ANSI)
├── agents/           # Agent loop, streaming, spawning, swarms, orchestration
│   ├── loop.ts       # Core agent execution cycle
│   ├── loop-stream.ts# Streaming variant (AsyncGenerator-based SSE)
│   ├── spawn.ts      # Sub-agent delegation with permission sandboxing
│   ├── swarm.ts      # Dynamic hierarchical multi-agent coordination
│   ├── types.ts      # AgentConfig (Zod schema), AgentTurn, ToolCallRecord
│   ├── orchestrator.ts # Multi-agent task routing
│   ├── blackboard.ts # Shared state for inter-agent communication
│   ├── self-healing.ts # Auto-restart + context compaction
│   ├── approval.ts   # Human-in-the-loop approval workflows
│   ├── quotas.ts     # Token/cost/request quota enforcement
│   ├── tracer.ts     # Execution trace accumulation → agent_traces table
│   ├── config-store.ts # Agent CRUD + auto-version snapshots on update
│   ├── deep-research.ts # Autonomous multi-day research
│   ├── dream-mode.ts # Overnight local-model scenario simulation
│   ├── persona-evolution.ts # Feedback-driven prompt variants
│   ├── debate.ts     # Multi-agent conflict resolution
│   ├── cloning.ts    # Agent versioning + lineage tracking
│   ├── optimizer.ts  # A/B testing + prompt tuning
│   ├── planner.ts    # Auto-swarm task decomposition
│   └── ... (60+ modules: conversation-branch, cost-estimator, capability-negotiator,
│            persona-swap, skill-chain, whisper, adaptive-compressor, federation,
│            load-balancer, delegation, handoff, budget-forecast, and more)
├── auth/             # JWT auth (jose), password hashing (bcrypt), user store
├── billing/          # Token budget checks, tier definitions, usage tracking, cost dashboard, outcome billing
├── channels/         # Messaging channel adapters (9 platforms)
│   ├── base.ts       # Channel interface, shared utilities
│   ├── router.ts     # Agent-per-channel routing
│   ├── telegram.ts   # Telegram bot (long polling)
│   ├── imessage.ts   # iMessage via BlueBubbles
│   ├── whatsapp.ts   # WhatsApp via Meta Cloud API
│   ├── signal.ts     # Signal via signal-cli REST
│   ├── discord.ts    # Discord bot
│   ├── slack.ts      # Slack bot
│   ├── google-chat.ts# Google Chat
│   ├── github.ts     # GitHub App (issues/PRs/comments, HMAC-verified)
│   ├── linear.ts     # Linear (issues/comments, label-based routing, bidirectional)
│   └── threading.ts  # Thread surface ID utilities (Slack/Discord/Telegram)
├── config/           # Environment config, Postgres pool, Typesense, agent registry, YAML loader
├── context/          # Context assembly (system prompt + memory + SOUL.md + history)
├── data/             # External data sources
├── db/               # Database migrations (198 files, auto-run on startup)
│   └── migrations/   # 001–198 numbered SQL files + platform migrations
├── diagnostics/      # Health diagnostics engine (astra doctor)
├── events/           # Typed event bus (Zod-validated, system-wide pub/sub)
├── gateway/          # Express app, routes, WebSocket, middleware
│   ├── routes/       # auth, chat, agents, traces, jobs, memory-profiles, openapi, etc.
│   └── middleware/   # JWT auth, rate limiting (per-user + token budget), workspace, HMAC
├── grpc/             # Optional gRPC server/client
├── inference/        # Multi-provider LLM abstraction (10 providers)
│   ├── factory.ts    # Provider factory + lazy client caching
│   ├── local-router.ts # Complexity-based local vs. cloud routing
│   ├── grok.ts       # Grok/x.ai client
│   ├── groq.ts       # Groq LPU client (ultra-fast)
│   ├── openai.ts     # OpenAI client
│   ├── gemini.ts     # Google Gemini client
│   ├── claude.ts     # Anthropic Claude client
│   ├── ollama.ts     # Ollama client (local models)
│   ├── bedrock.ts    # AWS Bedrock client
│   ├── mistral.ts    # Mistral AI client
│   ├── openrouter.ts # OpenRouter gateway client
│   ├── resilient.ts  # Retry + fallback wrapper
│   ├── circuit-breaker.ts # Per-provider open/closed/half-open circuit breaker
│   ├── warm-pool.ts  # Connection pool pre-warming
│   └── ... (25+ modules: benchmarker, race, tool-output-cache, warm-pool-probe,
│            semantic-cache-layer, cache-metrics, http-pool, payload-audit, and more)
├── jobs/             # Background job queue
│   ├── queue.ts      # Enqueue/claim/complete/fail (FOR UPDATE SKIP LOCKED)
│   ├── worker.ts     # JobWorker with handler registry + polling
│   ├── index.ts      # Singleton worker + start/stop lifecycle
│   └── handlers/     # Built-in job types (agent_run)
├── memory/           # 5-tier memory system
│   ├── store.ts      # Postgres-backed memory read/write
│   ├── graph.ts      # Graph memory (entities + relationships)
│   ├── tiered-search.ts # RRF fusion across search backends (profile-aware)
│   ├── profiles.ts   # Memory profile CRUD (tier enables, topK, score thresholds)
│   ├── embedding-cache.ts # LRU(2048) + Postgres SHA-256 embedding cache
│   ├── dedup.ts      # Near-duplicate consolidation (cosine 0.92 threshold)
│   ├── cold-store.ts # S3/GCS/local snapshot of all memory tiers
│   ├── rag.ts        # Document upload, chunking, vector search
│   ├── auto-extract.ts # Knowledge-graph extraction from text
│   ├── summarizer.ts # Daily/weekly memory rollups
│   ├── cross-workspace.ts # Memory sharing with permissions
│   ├── procedural.ts # Learned workflows
│   ├── pg-search.ts  # pgvector-based search
│   ├── search.ts     # Typesense semantic search
│   └── ... (50+ modules: pinning, decay, knowledge-graph-export, session-dedup,
│            diff, ephemeral, branches, clustering, acl, conflict-detector,
│            distillation, expiry, fact-extractor, federation, portable, and more)
├── plugins/          # Plugin system with hot-reload (+ real-time collaboration plugin)
├── scheduler/        # Cron-based task scheduling (10 jobs)
├── sessions/         # Session management, compaction, pruning
├── skills/           # 125 built-in skills (auto-discovered)
│   ├── definitions/  # One directory per skill (incl. SEO ops + cloud health packs)
│   └── signed-registry.ts # RSA-SHA256 skill package verification + supply-chain security
├── standalone/       # Standalone CLI mode + subcommand implementations
│   ├── cli.ts        # Interactive REPL with streaming
│   ├── costs.ts      # Cost dashboard CLI (astra costs)
│   ├── doctor.ts     # Diagnostics CLI (astra doctor)
│   ├── bench.ts      # Agent benchmarking (astra bench)
│   ├── replay.ts     # Deterministic session replay
│   ├── scaffold.ts   # Project scaffolding
│   ├── migrate-cli.ts# Database migration CLI
│   ├── dev-server.ts # Development server
│   └── setup.ts      # TUI onboarding wizard
├── security/         # 13 modules: GDPR erasure, differential privacy, prompt injection
│   │                 #   detection, intrusion detection, consent tracking, data residency,
│   │                 #   content watermarking, IP allowlisting, workspace templates,
│   │                 #   audit trail (hash-chained), data plane (DLP), tenant governance (RBAC)
├── observability/    # 10 modules: agent replay, alert rules, tool timeline, cost anomaly,
│   │                 #   latency heatmap, OpenTelemetry export, SLO monitor, dashboard SSE
├── tools/            # 81 built-in tools
├── utils/            # Shared utilities (logger)
├── webhooks/         # Webhook management and event dispatching
├── workflows/        # Durable execution engine + approval gate system
│   ├── durable-execution.ts  # Checkpoint persistence, retries, dead-letter queue, heartbeat
│   └── approval-gate.ts      # Structured proposals, risk scoring, auto-approve policies
├── workspace/        # Workspace file loader (cache + hot-reload watcher)
└── workspaces/       # Multi-workspace/multi-tenant support
```

## Agent Creation

Agents are created three ways:

1. **YAML** — Define in `astra.yml`, loaded on gateway startup
2. **REST API** — `POST /agents` with full config
3. **Database** — Loaded from Postgres `agent_configs` table

```bash
POST /agents
{
  "id": "my-agent",
  "displayName": "Research Assistant",
  "tier": "pro",
  "model": {
    "provider": "claude",
    "modelId": "claude-sonnet-4-6",
    "maxContextTokens": 200000,
    "maxOutputTokens": 8192,
    "temperature": 0.7
  },
  "systemPrompt": "You are a research assistant...",
  "skills": ["brave_search", "summarize", "calculator"],
  "tools": { "allow": [], "deny": [] },
  "spawn": {
    "enabled": true,
    "allowedTargets": ["data-analyst"],
    "maxDepth": 2
  },
  "fileAccess": {
    "restricted": true,
    "allowedPaths": ["/data/workspace"]
  }
}
```

Listing a skill auto-allows its tools. The `deny` list always takes precedence. Agents with `spawn.enabled` can delegate sub-tasks to other agents, with tool permissions restricted to the intersection of parent and target allow lists.

## Agent Loop

The core execution cycle (`src/agents/loop.ts`):

1. **Resolve session** — find or create based on `{uid, surface, surfaceId}`
2. **Persist user message** — stored in PostgreSQL
3. **Compaction check** — if context too large, pre-flush durable memories then summarize older messages via LLM (archived to `message_archive` before deletion)
4. **Assemble context** — SOUL.md prefix (5-min TTL hot-reload) + workspace files + system prompt + memory + live skill context + cross-workspace shared knowledge + history + tool schemas
5. **Call inference** — provider-agnostic `InferenceClient.chat()` or `.chatStream()`
6. **Tool loop** — partition calls into parallel reads + sequential writes, per-turn dedup cache (sha256 arg hash), long results (>500 chars) stored in `tool_outputs` table; max 5 rounds
7. **Reflection pass** — on complex/error-heavy turns, a self-evaluation pass optionally triggers a revision inference call
8. **Persist response** — store assistant message, emit events (all tagged with distributed `traceId`), fire webhooks

The streaming variant (`loop-stream.ts`) uses `AsyncGenerator<AgentStreamEvent>` for real-time SSE/WebSocket delivery.

## Agent Spawning & Swarms

Agents can delegate tasks to sub-agents with sandboxed permissions:

- Parent must have `spawn.enabled = true`
- Target must be in `spawn.allowedTargets`
- Sub-agent tools = intersection of parent and target allow lists (no privilege escalation)
- Max spawn depth enforced (default 2)

For complex tasks, the **swarm system** auto-spawns a tree of specialized sub-agents:

1. **Plan** — root agent decomposes task into sub-tasks using a dynamically generated role menu (all registered `ROLE_CARDS` are listed automatically — adding a new role card makes it available to the planner without any prompt changes)
2. **Spawn** — sub-agents instantiated from role cards with inherited budgets
3. **Execute** — sub-agents write to a shared blackboard (with named topic channels)
4. **Mediate** — conflicts trigger a debate protocol with evidence witnesses
5. **Synthesize** — root agent assembles final output

The **meta-controller** manages multiple concurrent swarms — monitoring resource allocation, rebalancing overloaded agents, and delegating overflow. The **agent specialization router** prevents duplicate effort across 10-15+ agent teams by maintaining a domain registry where agents claim non-overlapping work areas.

## Advanced Features

### Self-Healing

Auto-restart crashed agents with exponential backoff, auto-compact sessions approaching context limits, and clean up dead sessions. Configurable via `astra.yml`:

```yaml
selfHealing:
  enabled: true
  maxConsecutiveFailures: 3
  compactionThreshold: 40
```

### Human-in-the-Loop Approvals

Actions like `shell_execute`, `financial_action`, and `agent_spawn` can require approval before execution. Configurable timeout with deny-by-default:

```yaml
approval:
  requireApproval: [shell_execute, financial_action]
  timeoutMs: 300000
  defaultOnTimeout: deny
```

### Quota Enforcement

Per-agent token, cost, and request limits with real-time tracking:

```yaml
quotas:
  tokens:
    maxPerHour: 200000
    maxPerDay: 1000000
  cost:
    maxPerDay: 500          # $5.00
  spawn:
    maxConcurrent: 5
```

### Deep Research (Autonomous PhD Mode)

Long-running autonomous research agent that searches the web, synthesizes findings, and delivers structured reports. Spawns sub-agent swarms for parallel research. No local file access without explicit permission.

### Dream Mode

Overnight offline simulation using local models (Ollama). Privacy-first — all dream inference stays 100% on-device. Generates "What I Dreamed About" morning reports.

```yaml
dream:
  enabled: true
  intensity: medium       # light | medium | deep
  scheduleHour: 23
  useLocalOnly: true
  promptUser: true
```

### Persona Evolution

Self-evolving agent prompts based on user feedback. Generates prompt variants, A/B tests them, and optionally auto-adopts better-performing versions.

### Real-Time Collaborative Sessions

Multi-user workspaces where humans and agents co-edit tasks and memory simultaneously. Role-based permissions (owner/editor/viewer/agent), presence tracking, and message history. REST API at `/api/collab/sessions`.

### Memory Branching & Conflict-Free Merge

Git-style fork/diff/merge for the entire memory state. Users or agents fork memory into parallel branches for experimentation, then merge back. The **conflict-free merge** protocol uses CRDT-inspired set-union semantics — non-conflicting changes merge automatically, and true conflicts are flagged for interactive resolution (keep A, keep B, union, or custom).

### Team Memory Propagation

Cross-user learning propagation within workspaces. When one user's agent discovers something valuable, `team_memory_propagate` promotes it to shared workspace memory so all team members benefit. Supports auto-scan (finds promotable entries in personal memory), pull (retrieve relevant team learnings for a task), and retract (remove a previous promotion). Content-hash dedup prevents duplicates.

### Agent Specialization Routing

Automatic work domain division for multi-agent teams. When 10-15+ agents work on the same project, the specialization router maintains a domain registry — a live map of which agent owns which knowledge domain (e.g., "data-layer", "auth", "testing"). Agents check in before starting work, claim domains, and the router ensures non-overlapping assignments. Supports rebalancing across agents and task-based domain suggestions.

### Contextual Boosting for Memory Retrieval

Dynamic per-tier RRF weight adjustment based on context. During research tasks, graph memory is boosted; during debugging, session and daily memory are boosted; during later debate rounds, graph memory precision increases. Configurable boost profiles per swarm, with an evaluation loop that compares feedback-implied weights against current boosts.

### Scenario Engine

What-if comparison engine that forks memory into parallel branches, runs different scenarios, and returns side-by-side comparisons. Useful for testing how different decisions would affect the agent's knowledge state.

### Workspace Files

Drop `.md` files into a `./workspace/` directory (next to `astra.yml`) to bootstrap agent context without editing config:

```
workspace/
  AGENTS.md     ← operating instructions & behavioral rules
  USER.md       ← user profile and preferences
  IDENTITY.md   ← agent persona / tone / name
  anything.md   ← any other .md files are auto-loaded
```

At startup, all files are read and upserted into the `workspace_files` DB table. A filesystem watcher then monitors for changes — edits are detected with a 500ms debounce, checksummed (SHA-256 to skip no-op saves), synced to the DB, and the in-memory cache is invalidated so the next agent request picks up the fresh content.

Context injection order per agent turn: `SOUL.md → workspace files → agent system prompt → memory → conversation history`

### SOUL.md — Ethical Framework

`SOUL.md` defines ethical constraints for all agents. It's prepended to every system prompt as a stable prefix — enabling provider-side prompt caching (Claude, OpenAI, Gemini all cache stable prefixes). The file is hot-reloaded with a 5-minute TTL, so changes propagate without a server restart.

Principles: Do No Harm, Truth-Seeking, User Sovereignty, Transparency, Proportionality, Non-Manipulation, Confidentiality, Accountability.

### File Access Restrictions

Per-agent file access controls. By default, agents can only access explicitly allowed paths:

```yaml
agents:
  my-agent:
    fileAccess:
      restricted: true
      allowedPaths:
        - /data/workspace
        - /tmp/agent-scratch
```

## Agent Intelligence

### Structured Output Enforcement

Per-agent JSON Schema enforcement for all responses. Invalid output is automatically repaired via LLM with up to 5 retry attempts before rejection. Configure via REST:

```bash
PUT /structured-output  { agentId, name, schema, maxRepairAttempts?, description? }
GET /structured-output/:agentId
```

### Reflexion Loop

Self-critique and revision cycle — the agent drafts a response, critiques it, and revises up to 3 passes before returning the final answer. All passes logged for inspection:

```bash
GET /reflexion?workspaceId=ws-123&sessionId=...
```

### Agent Credential Vault

AES-256-GCM encrypted per-agent credentials (API keys, tokens, passwords). Credentials are injected at runtime, never logged or stored in plaintext:

```bash
PUT    /agent-credentials   { agentId, key, value }
GET    /agent-credentials/:agentId          # list key names only
DELETE /agent-credentials/:agentId/:key
```

### Few-Shot Example Library

Store curated prompt examples per agent, classified by task type (summarize, translate, code, analyze, search, plan). Examples are automatically injected before inference:

```bash
POST /few-shot   { agentId, taskType, userInput, expectedOutput, score? }
GET  /few-shot?agentId=...&taskType=...
```

### Output Post-Processor Pipeline

Chainable transforms applied to every agent response: `redact-pii`, `reformat-json`, `truncate`, `translate`, `uppercase`, `lowercase`. Processors run in order by position:

```bash
POST /output-processors  { agentId, processorType, position?, config? }
GET  /output-processors/:agentId
```

### Conversation Checkpointing

Full conversation state snapshots with token estimates. Restore any prior turn:

```bash
POST /checkpoints   { sessionId, snapshot, label? }
GET  /checkpoints?sessionId=...
GET  /checkpoints/:id                   # includes full snapshot for restore
```

### Adaptive Tool Retry

Per-tool exponential backoff with jitter. Exhausted calls go to a dead-letter table for inspection and requeue:

```bash
PUT  /tool-retry/budgets   { toolName, maxAttempts, baseDelayMs, maxDelayMs, jitter }
GET  /tool-retry/budgets
DELETE /tool-retry/dead-letter/:id
```

### Agent Clique Formation

Dynamically assemble ad-hoc agent teams that together cover all required tools/skills. Greedy set-cover algorithm selects the minimum agents needed:

```bash
POST /cliques/form   { requiredTools, requiredSkills, maxSize? }
POST /cliques        { name, agentIds, coordinatorAgentId, description? }
POST /cliques/:id/runs   { task }
```

### Tool Usage Analytics

Per-tool call counts, success rates, p50/p99 durations, and error histograms:

```bash
GET /tool-analytics?toolName=...&windowHours=24
GET /tool-analytics/histogram/:toolName?windowHours=24
```

### Whisper-Chain Propagation

Carry `X-Agent-Whisper` hints across the full agent spawn tree. Each child agent receives and extends the parent's whisper context, capped at depth 3:

```bash
GET /whisper-chain/:rootSessionId
GET /whisper-chain/session/:sessionId/whisper
```

## Memory & Knowledge

### Memory ACLs

Per-entry visibility controls: `private`, `workspace`, or `cross-workspace` with explicit UID allowlists:

```bash
PUT    /memory/acl   { memoryId, memoryTable, visibility, allowedUids? }
GET    /memory/acl/:table/:memoryId
DELETE /memory/acl/:table/:memoryId
```

### Memory Provenance

Track the origin of every memory entry — which session, agent, tool, or document created it:

```bash
POST /memory/provenance   { memoryId, memoryTable, source, sessionId?, agentId?, toolName? }
GET  /memory/provenance/:table/:memoryId
GET  /memory/provenance/session/:sessionId
GET  /memory/provenance/summary?windowDays=7
```

### Memory Versioning

Immutable content snapshots for any memory entry. Roll back to any prior version:

```bash
POST   /memory/versions        { memoryId, memoryTable, content }
GET    /memory/versions/:table/:memoryId
GET    /memory/versions/:table/:memoryId/:version
DELETE /memory/versions/:table/:memoryId/purge?keepLatest=10
```

### Temporal Memory Queries

Query memories by time range, bucket by day/week/month, and build timelines for entities:

```bash
GET /memory/temporal?uid=...&from=2025-01-01&to=2025-12-31&category=decision
GET /memory/temporal/timeline?uid=...&bucket=week
GET /memory/temporal/entities/:name/timeline
```

### Semantic Memory Clustering

Group related memories via k-means centroid vectors. Clusters maintain member counts and similarity scores:

```bash
POST /memory/clusters          { label, centroidVector, description? }
POST /memory/clusters/:id/members   { memoryId, memoryTable, similarity }
GET  /memory/clusters/:id/members
```

### Knowledge Distillation

Compress repeated memory patterns into compact distilled facts with confidence scores and optional TTL expiry:

```bash
POST /knowledge-distillation   { uid, fact, category, confidence?, sourceCount?, expiresAt? }
GET  /knowledge-distillation?uid=...&category=...&minConfidence=0.8
GET  /knowledge-distillation/stats
```

### Memory Federation

Sync memory facts across trusted workspace peers. Supports `read` and `read-write` trust levels with full sync logs:

```bash
POST  /memory/federation   { peerWorkspaceId, peerEndpoint, trustLevel? }
GET   /memory/federation/:id/history
PATCH /memory/federation/:id/status   { status: active|paused|revoked }
```

### Vector DB Export

Export memory embeddings to external vector databases. Tracks job status and record counts:

```bash
POST  /vector-export   { target: "pinecone"|"weaviate"|"qdrant", targetConfig }
GET   /vector-export
PATCH /vector-export/:id   { status, recordsExported? }
```

### Memory L1 Cache

In-process LRU read-through cache for hot memory lookups. Separate caches for daily memory, graph entities, and user profiles — all TTL-backed:

```bash
GET    /memory/l1-cache/stats
DELETE /memory/l1-cache/invalidate   { prefix?, cache?: "daily"|"graph"|"profile"|"all" }
```

### Structured Memory Schemas

Per-category JSON Schema validation for memory writes. `strict: true` rejects violations; `strict: false` logs and passes through:

```bash
PUT  /memory/schemas   { category, schema, strict? }
POST /memory/schemas/validate   { category, content }
GET  /memory/schemas
```

## Skills System

125 built-in skills auto-discovered from `src/skills/definitions/`. Skills register tools and inject prompt context into agents. Add a new skill by creating a directory with an `index.ts` exporting a `SkillDefinition`.

**`SkillDefinition` hooks:**
- `getPromptContext()` — static instructions injected into the agent's system prompt
- `getContextData(uid, query)` — runtime hook called per-turn to inject live data (e.g., current market odds, live team stats); results appear as `{{liveSkillContext}}` in the prompt
- `manifest.requires[]` — dependency list (tool names or skill IDs) validated at startup; missing deps emit a `WARNING` log

**Telemetry:** Every tool execution that belongs to a skill emits a `skill.executed` event with `skillId`, `toolName`, `durationMs`, and `uid`. Failures are isolated — telemetry errors never block tool execution.

Engineering skills: `codebase` (indexing + semantic search), `test_runner` (auto-detect + run + generate), `team_knowledge` (workspace memory + knowledge base).

Multi-agent skills: `code_review_swarm`, `swarm_management` (meta-controller + observer + topics + debate), `memory_management` (compress + propagate + budget + consistency + feedback + decay), `scenario_engine`, `ethical_alignment`, `agent_therapy`, `knowledge_injection`, `graph_evolution`, `health_scorecard`, `realtime_collab`, `evolution_engine`.

SEO Ops skills: `seo_site_audit` (crawl + meta/heading/image/link/structured data checks), `seo_keyword_rank` (SERP tracking with trends), `seo_content_gap` (competitor keyword analysis), `seo_schema_markup` (JSON-LD validation + generation), `seo_link_health` (broken link detection + backlink profiling).

Cloud Health skills: `cloud_resource_scan` (multi-cloud inventory + security posture), `cloud_cost_anomaly` (statistical spending analysis + forecasting), `cloud_drift_detect` (IaC drift comparison + remediation), `cloud_cert_monitor` (SSL/TLS validation + compliance), `cloud_scaling_advisor` (rightsizing + autoscaling config).

Integration skills: `ga4` (Google Analytics 4 queries + realtime), `gmail` (email read/reply/task automation), `google_search_console` (sitemap submission, search analytics, indexing).

## Tool System

81 built-in tools registered at import time via `registerTool()`:

| Tool | Purpose |
|------|---------|
| `memory-write` / `memory-search` / `memory-export` | User memory operations |
| `workspace_memory_write` / `workspace_memory_search` | Team-scoped memory (decisions, ADRs, standups) |
| `workspace_knowledge_write` / `workspace_knowledge_search` | Knowledge base (standards, runbooks, FAQs) |
| `codebase_index` / `codebase_search` | Codebase indexing + semantic code search |
| `agent-spawn` | Sub-agent spawning |
| `model-inference` | Cross-agent inference delegation |
| `file-read` / `file-write` | File operations (with per-agent access control) |
| `shell-execute` | Shell command execution |
| `url-fetch` | HTTP fetching |
| `graph-query` | Knowledge graph exploration |
| `rag-search` | Document vector search |
| `approval-resolve` | Approval queue management |
| `research-manage` | Deep research task control |
| `dream-manage` | Dream mode configuration |
| `prop-lookup` / `line-compare` | Market data |
| `kelly-criterion` / `portfolio-optimizer` | Financial tools |
| `x-search` | X/Twitter search |
| `push-notify` | FCM push notifications |
| `web-search` | Generic web search (Brave + DuckDuckGo fallback) |
| `code-execute` | Sandboxed JavaScript/Python execution |
| `image-generate` | DALL-E 3 image generation |
| `database-query` | Read-only SQL queries against Postgres (table allowlist, forbidden pattern guards) |
| `graphql-query` | GraphQL queries with optional introspection |
| `patch-apply` | Apply unified diff patches (dry-run supported) |
| `calendar-event` | Calendar event CRUD (Postgres-backed) |
| `email-send` | Send emails via Resend API |
| `http-request` | Full HTTP client with auth + SSRF protection |
| `pdf-read` | PDF text extraction (pdf-parse) |
| `clipboard` | System clipboard read/write |
| `screenshot` | Platform-native screen capture |
| `sports_data` | Live sports scores, standings, transactions, odds via ESPN + Odds API |
| `sanity_publish` | Publish articles to Sanity.io CMS (markdown to Portable Text, content sanitization) |

**Swarm & orchestration tools:**

| Tool | Purpose |
|------|---------|
| `code_review_swarm` | Autonomous multi-agent code review (security, perf, style, logic reviewers) |
| `swarm_observe` | Read-only swarm monitoring (status, summary, alerts, timeline) |
| `meta_controller` | Multi-swarm dashboard, resource allocation, rebalancing, overflow |
| `blackboard_topic` | Named topic/channel pub/sub for selective swarm communication |
| `debate_witness` | Evidence retrieval from memory tiers with citation formatting |

**Memory management tools:**

| Tool | Purpose |
|------|---------|
| `memory_compress` | On-demand tier compression with configurable strategy |
| `memory_propagate` | Cross-tier promotion (daily→profile, daily→graph, graph→profile) |
| `memory_budget` | Per-agent memory tier limits with enforcement + pruning |
| `consistency_check` | Cross-tier contradiction detection with auto-fix |
| `memory_feedback` | Post-synthesis utility ratings to fine-tune RRF weights |
| `relation_decay` | Time-based graph edge weight decay with configurable half-life |
| `contextual_boost` | Dynamic per-tier RRF weights based on task type, swarm phase, debate round |
| `knowledge_inject` | External data injection with MD5 dedup + relevance scoring |
| `graph_schema_evolution` | Proposal/approve/reject workflow for graph entity/edge types |

**Session & scenario tools:**

| Tool | Purpose |
|------|---------|
| `session_branch` | Git-style session forking with memory diff/merge/abandon |
| `scenario_engine` | What-if comparison engine via memory branch forking |
| `conflict_free_merge` | CRDT-inspired merge for parallel branches (set-union + interactive resolution) |

**Multi-person workflow tools:**

| Tool | Purpose |
|------|---------|
| `team_memory_propagate` | Cross-user learning propagation with auto-scan, dedup, relevance scoring |
| `agent_specialization_router` | Automatic work domain division (claim/release/rebalance/suggest) |
| `prompt_templates` | Workspace-scoped template CRUD with {{variable}} interpolation |

**Multi-modal, routing & agent self-improvement tools:**

| Tool | Purpose |
|------|---------|
| `multimodal_input` | Unified multi-modal input handler (image/audio/pdf/video routing) |
| `provider_router` | Cross-provider routing with cost/latency/quality scoring matrix |
| `ethical_check` | Post-generation ethical validation with configurable guidelines |
| `agent_therapy` | Self-reflection journal, mood tracking, failure pattern analysis |
| `health_scorecard` | Agent reliability, efficiency, memory hygiene scoring |
| `evolution_feedback` | Goal-driven quality/relevance/helpfulness feedback collection |

**Tool hot-reload:** In non-production environments, `createToolHotReloader()` watches the `src/tools/` directory and re-imports changed files on save (200ms debounce, `?v=` cache-busting). Stale registrations are unregistered first via `unregisterTool()`.

**Tool reliability:** Tools tagged `retryable: true` (e.g., `x_search`, `push_notify`) automatically retry up to 2 times with exponential backoff (200ms base + jitter) before returning an error.

Tool parameters use Zod schemas auto-converted to JSON Schema for LLM tool-use.

## Observability & Operations

### Agent Traces

Every agent run is recorded as a trace in the `agent_traces` table — tool calls, token counts, circuit breaker events, and final status. Query via REST:

```bash
GET /traces?workspaceId=ws-123&limit=20   # paginated trace list
GET /traces/:id                           # full trace detail
```

### Circuit Breaker Dashboard

Per-provider circuit breaker states are exposed at `GET /diagnostics/circuit-breakers`. States: `closed` (healthy), `open` (failing fast), `half-open` (testing recovery). Automatically wired into the resilient inference layer.

### Background Job Queue

Enqueue long-running tasks as background jobs backed by Postgres (`FOR UPDATE SKIP LOCKED`):

```bash
POST /jobs          # enqueue a job { type, payload, workspaceId? }
GET  /jobs          # list jobs (filterable by status, type)
GET  /jobs/:id      # get job detail + progress
DELETE /jobs/:id    # cancel a pending job
```

Built-in job type: `agent_run` — runs an agent loop asynchronously with `{ agentId, uid, message, sessionId? }`. Results are stored on the job record.

### Agent Versioning

Agent configs are auto-snapshotted on every update. Roll back to any prior version:

```bash
GET  /agents/:id/versions              # list version history
GET  /agents/:id/versions/:v           # get a specific version config
POST /agents/:id/versions/:v/rollback  # restore a prior version
PATCH /agents/:id/versions/:v          # set a custom label (e.g., "stable")
```

### Memory Profiles

Workspace-scoped memory tier configuration. Override tier enables, topK, score thresholds, and inject a system prompt suffix per agent:

```bash
POST /memory-profiles                     # create profile
GET  /memory-profiles                     # list workspace profiles
PUT  /memory-profiles/:id/agents/:agentId # assign profile to agent
```

When assigned, an agent's memory search respects the profile's `tiersEnabled`, `maxContextChunks`, and `minRelevanceScore` — without changing any code.

### OpenAPI Spec

Machine-readable OpenAPI 3.1 spec covering all endpoints:

```bash
GET /openapi.json   # JSON format
GET /openapi.yaml   # YAML format
```

Covers: auth, agents, chat, traces, jobs, memory-profiles, webhooks, admin, diagnostics, costs, and more.

### OpenAstra Dashboard

Full-featured web dashboard for managing and monitoring agents in real-time. Built with React 19, TypeScript, Vite, Tailwind CSS, Radix UI, React Query, Recharts, and Zustand. Located in `dashboard/`. 28 pages with lazy loading, dark zinc theme, mobile-responsive bottom nav.

| Page | Features |
|------|----------|
| **Overview** | Real-time system dashboard — agent status, token usage, cost trends, system health |
| **Chat** | Interactive chat interface for testing and conversing with any registered agent |
| **Agents** | Full agent CRUD — create, configure, version, and monitor all agents |
| **Agent Compare** | Side-by-side agent comparison on cost, latency, success rate |
| **Sessions** | Session management — browse conversation history, inspect memory state, conversation log viewer |
| **Activity Timeline** | Chronological agent activity feed with filtering |
| **Steering** | Live agent steering — redirect, inject context, override model mid-session |
| **Skills Graph** | Skill dependency topology, graph validation, tool coverage |
| **Spawns** | Subagent spawn tree visualization with depth tracking |
| **Model Router** | Provider routing rules, cost/latency/quality scoring |
| **Playground** | Prompt playground for rapid prototyping and A/B testing |
| **Memory Graph** | Interactive entity relationship visualization |
| **Token Heatmap** | Per-agent token consumption heatmap |
| **Audit Log** | Searchable agent execution audit log |
| **Live Feed** | Real-time event stream (SSE) for all agent activity |
| **Guardrails** | PII detection, content filtering, safety rule management |
| **Agent Wizard** | Step-by-step agent creation wizard |
| **Ops Console** | Durable workflow run monitoring — status, progress, pause/resume/cancel |
| **Approval Queue** | Human-in-the-loop proposal review — risk badges, approve/reject, escalation |
| **Audit Trail** | Hash-chained tamper-evident audit log with chain verification |
| **Billing & Outcomes** | Outcome-based billing dashboard — usage bars, ROI, invoices |
| **Skill Marketplace** | Browse, install, and manage signed skill packages with trust badges |
| **Approvals** | Approval workflow management |
| **Tool Pipelines** | Multi-step tool pipeline configuration |
| **Prompt Versions** | Prompt version history and diffing |
| **Anomaly Alerts** | Cost and performance anomaly detection |
| **Memory** | Memory tier visualization — search across all 5 tiers, inspect entries |
| **Costs** | Cost analytics — breakdown by agent, model, provider with trends |
| **Schedules** | Scheduled task management — create, run, pause, and delete cron-driven tasks |
| **Webhooks** | Webhook management and delivery log inspection |
| **User Profile** | User settings, API keys, preferences |
| **System** | Infrastructure monitoring — service health, database metrics, event logs |
| **Settings** | Workspace and user configuration — team management |

**Command palette** (Cmd+K / Ctrl+K) for quick navigation across all pages. WebSocket streaming for real-time updates. Mobile-responsive with bottom tab bar and expandable "More" menu. Connects to the gateway REST API and `/ws` endpoint.

```bash
cd dashboard && npm install && npm run dev   # Development server
cd dashboard && npm run build                # Production build
```

## Authentication

JWT-based auth (jose + bcrypt):

```bash
POST /auth/register   { email, password, displayName? }
POST /auth/login      { email, password }
POST /auth/refresh    { refreshToken }
POST /auth/logout     { refreshToken }
```

Access tokens expire in 15 minutes, refresh tokens in 7 days.

## Multi-Provider Inference

Switching an agent's provider is a single config change. Ten providers supported:

| Provider | Caching | Discount |
|----------|---------|----------|
| Grok | Auto prefix + cluster pin (`x-grok-conv-id`) | 75% |
| Groq | LPU hardware — ultra-fast inference | N/A (speed) |
| OpenAI | Auto prefix (1024+ tokens) | 50-90% |
| Gemini | Implicit auto + explicit CachedContent | 90% |
| Claude | Explicit `cache_control` breakpoints | 90% |
| Ollama | Local inference (no API cost) | 100% |
| vLLM | Self-hosted (OpenAI-compatible) | 100% |
| Bedrock | AWS-hosted models (Claude, Titan, Llama, etc.) | Via AWS savings plans |
| Mistral | Mistral AI API | Via provider |
| OpenRouter | 200+ models via unified gateway | Varies by model |

The **local model router** automatically routes simple queries to Ollama and complex ones to cloud providers, based on configurable complexity and context-length thresholds.

## 5-Tier Memory System

| Tier | Storage | HNSW Config | Purpose |
|------|---------|-------------|---------|
| 1: Ephemeral | PostgreSQL | m=8, ef=32 | Session messages (high write frequency) |
| 2: Daily | PostgreSQL | — | Categorized daily notes — **7-day lookback window** |
| 3: Long-term | PostgreSQL | — | User profile + domains |
| 4: Graph | PostgreSQL | m=24, ef=128 | Entity relationships (maximum recall) |
| 5: Procedural | PostgreSQL | — | Learned workflows |
| Team: Workspace Graph | PostgreSQL | m=16, ef=64 | Shared team knowledge graph (workspace-scoped entities) |

**LLM extraction:** `auto-extract.ts` now extracts entities, relationships, *and* daily memory entries from conversations in a single LLM call. Extracted memories are written to Tier 2; extracted entities go to Tier 4 and optionally the workspace graph.

**Search fusion**: Tiered search runs queries in parallel across Typesense (BM25 + vector) and pgvector (cosine similarity), then merges results via Reciprocal Rank Fusion (RRF, k=60). Graph-vector hybrid search expands 2 hops from seed entities. Procedural fast-path returns learned workflows before LLM processing.

## Billing & Token Budgets

Three usage tiers with soft-cap degradation:

| Tier | Monthly Token Limit | Soft Cap | Degradation |
|------|-------------------|----------|-------------|
| Free | 100K | 80% | Downgrade to `gpt-4o-mini` |
| Pro | 2M | 90% | Downgrade to `grok-4-1-fast-non-reasoning` |
| Enterprise | 20M | 95% | No downgrade |

Token usage is tracked per-request and enforced via middleware.

## Event System

Typed event bus with Zod-validated payloads. All agent lifecycle events carry an optional `traceId` field for end-to-end distributed tracing across tool calls, inference rounds, and sub-agent spawns.

- `agent.started` / `agent.completed` — agent lifecycle (`traceId`)
- `agent.stream.delta` — real-time streaming tokens (`traceId`)
- `agent.spawn.started` / `agent.spawn.completed` — sub-agent delegation
- `tool.executed` — tool execution tracking (`traceId`)
- `skill.executed` — per-skill telemetry (`skillId`, `toolName`, `durationMs`)
- `memory.written` — memory writes
- `session.created` / `session.archived` — session lifecycle
- `ws.connected` / `ws.disconnected` — WebSocket presence
- `webhook.dispatched` — outgoing webhook tracking
- `dream.scheduled` / `dream.completed` — dream mode lifecycle
- `job.started` / `job.completed` / `job.failed` — background job lifecycle

## Setup

### Standalone Mode (personal use)

Only requires **one inference API key** and **PostgreSQL**. JWT secrets are auto-generated, Typesense is optional.

```bash
docker compose up -d          # start Postgres + Typesense
npm install
cp .env.standalone .env
# Set at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GROK_API_KEY
npm run cli
```

See `.env.standalone` for all available options.

### Server Mode (multi-tenant API)

Full gateway with JWT auth, REST API, WebSocket, all channels, and all middleware.

```bash
npm install
cp .env.example .env
# Fill in ALL required API keys + PostgreSQL connection
npm run dev
```

#### Required Environment Variables (Server Mode)

- `JWT_SECRET` — Secret for signing JWTs
- At least one inference provider key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROK_API_KEY`, `GEMINI_API_KEY`, or `OLLAMA_BASE_URL`
- `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` — PostgreSQL connection
- `TYPESENSE_API_KEY` — Typesense search
- `INTERNAL_API_KEY` — Secures autonomous agent endpoints

#### Optional

- `GROK_API_KEY` — Grok/x.ai provider
- `GROQ_API_KEY` — Groq LPU inference (ultra-fast open models)
- `OPENAI_API_KEY` — OpenAI provider + fallback
- `ANTHROPIC_API_KEY` — Claude provider
- `GEMINI_API_KEY` — Google AI (used for embeddings + optional inference)
- `OLLAMA_BASE_URL` — Ollama endpoint (default: `http://localhost:11434`)
- `BRAVE_API_KEY` — Brave Search skill
- `RESEND_API_KEY` — Email sending skill
- `TELEGRAM_BOT_TOKEN` — Enables Telegram channel
- `DISCORD_BOT_TOKEN` — Enables Discord channel
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` — Enables Slack channel
- `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` — Enables WhatsApp channel
- `SIGNAL_API_URL` / `SIGNAL_PHONE_NUMBER` — Enables Signal channel
- `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY` — Enables Google Chat channel
- `BLUEBUBBLES_URL` / `BLUEBUBBLES_PASSWORD` — BlueBubbles (iMessage)
- `GATEWAY_URL` — Public URL for webhook registration
- `DEFAULT_AGENT_ID` — Default agent for messaging channels
- `GRPC_ENABLED` / `GRPC_PORT` — Enable gRPC inter-service transport
- `GRPC_TLS_CERT` / `GRPC_TLS_KEY` / `GRPC_TLS_CA` — mTLS for gRPC (optional)
- `ALLOWED_ORIGINS` — CORS origins (comma-separated, default: `http://localhost:3000`)
- `EMBEDDING_PROVIDER` — `"gemini"` or `"local"` (auto-detected)
- `BIND_JWT_TO_DEVICE` — Bind JWT tokens to device fingerprint (default: `false`)
- `JWT_SECRET_PREV` — Previous JWT secret for key rotation (dual-key validation)
- `SECRET_BACKEND` — Secrets backend: `vault` | `asm` | `env` (default: `env`)
- `VAULT_ADDR` / `VAULT_TOKEN` — HashiCorp Vault address + token (if `SECRET_BACKEND=vault`)
- `SECRET_TTL_SECONDS` — TTL for cached secrets (default: `300`)
- `SEMANTIC_CACHE_ENABLED` — Enable pgvector semantic response cache (default: `false`)
- `MEMORY_TTL_DAYS` — Memory entry TTL in days (default: `90`)
- `MEMORY_BACKEND_TIMEOUT_MS` — Per-backend search timeout (default: `500`)
- `COLD_STORE_BACKEND` — Memory snapshot backend: `s3` | `gcs` | `local`
- `COLD_STORE_BUCKET` / `COLD_STORE_REGION` — S3/GCS bucket config
- `SPLADE_ENDPOINT` — Optional SPLADE sparse encoder endpoint
- `TYPESENSE_NODES` — Multi-node cluster: comma-separated `host:port` list
- `PII_DETECTION_POLICY` — PII handling: `block` | `redact` | `allow` (default: `redact`)
- `CODE_EXEC_SANDBOX` — Code execution isolation: `docker` | `process` | `none` (default: `process`)
- `CODE_EXEC_TIMEOUT_MS` — Code execution timeout (default: `10000`)
- `CODE_EXEC_MEMORY_LIMIT_MB` — Memory limit for sandbox (default: `128`)
- `CODE_EXEC_DOCKER_IMAGE` — Docker image for sandbox mode (default: `node:20-alpine`)
- `USER_RATE_LIMIT_RPM` — Per-user requests per minute (default: `60`)
- `USER_RATE_LIMIT_BURST` — Per-user burst allowance (default: `10`)
- `GITHUB_APP_ID` — GitHub App ID (enables GitHub channel)
- `GITHUB_WEBHOOK_SECRET` — GitHub webhook HMAC secret

## Development

```bash
npx astra            # zero-config: auto-manage Docker + start gateway
npx astra chat       # zero-config: auto-manage Docker + start CLI
npm run dev          # server: tsx watch mode (requires manual .env)
npm run cli          # standalone: interactive terminal agent
npm run cli:dev      # standalone: tsx watch mode (auto-restart on changes)
npm run setup        # TUI onboarding wizard (full config)
npm run doctor       # run diagnostics (alias for npx astra doctor)
npm run costs        # show cost dashboard (alias for npx astra costs)
npm run astra        # local dev: tsx src/bin/astra.ts
npm run astra:dev    # local dev: tsx watch mode for CLI
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
npm start            # run production server build
```

TypeScript with strict mode, ESM (`"type": "module"`), and all imports use `.js` extensions per Node16 module resolution.

## Testing

60 test suites in `src/__tests__/` covering gateway routes, memory operations, agent lifecycle, inference providers, context assembly, sessions, tools, skills, observability, and infrastructure. Includes 10 end-to-end tests for the core agent loop.

```bash
npm run typecheck    # Type-check without emitting (primary correctness check)
npm test             # Run test suites
```

## Database Migrations

198 migration files in `src/db/migrations/` run automatically on startup:

| Migration | Tables |
|-----------|--------|
| 001 | Schema tracking |
| 002 | Core tables (users, workspaces) |
| 003 | Sessions |
| 004 | Memory (chunks, daily docs, profiles) |
| 005 | Billing |
| 006 | Webhooks |
| 007 | Agent infrastructure (spawns, blackboard) |
| 008 | Auth (refresh tokens) |
| 009 | Agent configs |
| 010 | Memory extensions (graph entities, edges, procedural) |
| 011 | Channel routing |
| 012 | Knowledge store |
| 013 | Advanced features (swarm plans, approvals, quotas, debates, versions, lineage, documents, summaries, shares, personas, dreams, research + HNSW index tuning) |
| 014 | Team features (workspace_memory, workspace_knowledge, codebase_index, diagnostic_runs, cost_snapshots, message embeddings) |
| 015 | Heartbeat (liveness/readiness tracking) |
| 016 | Workspace files (filename, content, checksum, loaded_at, updated_at) |
| 017 | `tool_outputs` — full content of truncated tool results (session_id indexed) |
| 018 | `message_archive` — compacted messages archived before deletion (session_id + user_id indexed) |
| 019 | `workspace_graph_entities` — team-scoped knowledge graph with HNSW vector index (m=16, ef=64) |
| 023 | Security: `audit_log`, `secret_audit_log`, `workspace_secrets`, `rbac_members` |
| 024 | Memory infra: `embedding_cache`, `semantic_cache`, `expires_at` on sessions/daily |
| 025 | Vector indexes: IVFFlat indexes, halfvec quantization (conditional on pgvector ≥0.7) |
| 031 | `agent_traces` — execution traces with JSONB tool_calls/circuit_breaker_events |
| 032 | `job_queue` — background jobs with retry tracking and status state machine |
| 033 | `agent_config_versions` — auto-snapshotted agent config history |
| 034 | `memory_profiles`, `agent_memory_profiles` — workspace-scoped memory tier config |
| 041–077 | Debate protocol, agent goals, spawn tree, federation, agent tests, cost attribution, skill registry, approvals, session rooms, async delegation, KB sync, memory namespaces/expiry/conflicts/weights, distributed traces, SLOs, circuit-breaker history, data residency, permission requests, load balancing, A/B testing, param sweep, mood state, OTEL config, prompt templates, webhook inspector, workflows, tournaments, memory snapshots, knowledge merge, Zapier bridge, IP allowlist, session replay, DP consent, DLQ, mesh gossip |
| 093 | `structured_output_schemas` — per-agent JSON Schema + max repair attempts |
| 094 | `reflexion_logs` — draft/critique/final passes per session |
| 095 | `agent_credentials` — AES-256-GCM encrypted per-agent secrets |
| 096 | `few_shot_examples` — task-classified prompt examples with scoring |
| 097 | `output_processor_chains` — ordered per-agent output transforms |
| 098 | `conversation_checkpoints` — full snapshot + token estimate |
| 099 | `tool_retry_budgets` + `tool_dead_letter` — adaptive retry with DLQ |
| 100 | `agent_cliques` + `clique_runs` — capability-covering agent teams |
| 101 | `tool_usage_stats` — p50/p99 durations, success rates, error types |
| 102 | `whisper_chain_log` — X-Agent-Whisper propagation tree |
| 103 | `memory_acl` — private/workspace/cross-workspace visibility controls |
| 104 | `memory_provenance_log` — source/session/agent/tool per memory entry |
| 105 | `memory_versions` — immutable content snapshots with rollback |
| 106 | Temporal indexes on `daily_memory`, `graph_entities`, `graph_edges` |
| 107 | `memory_clusters` + `memory_cluster_members` — semantic k-means clusters |
| 108 | `distilled_facts` — compressed knowledge with confidence + TTL |
| 109 | `federation_nodes` + `federation_sync_log` — cross-workspace memory sync |
| 110 | `vector_export_jobs` — Pinecone/Weaviate/Qdrant export tracking |
| 111 | `memory_schemas` — per-category JSON Schema validation |
| 112–140 | Gateway infrastructure (prompt versions, cross-workspace routes, leaderboard), team coordination (branches, capability matching, skill chains), memory management (pinning, decay, knowledge-graph export, session dedup, diff, ephemeral), inference optimization (benchmarker, race mode, tool output cache, warm pool), observability (tool timeline, agent replay, alert rules), security (GDPR erasure, differential privacy, workspace templates) |
| 141–166 | Memory evolution (swarm memory, context bridge), agent evolution tracking, memory lifecycle cron support, and additional infrastructure |
| 169–198 | Memory contracts, CRDT merge, audit ledger, deterministic replay, agent debugger, session steers, supervisor routing, daily notes, cache performance, provider metrics, embedding dedup, hierarchical cache, ML cache warming, schema dedup, self-critique, skill learning, tool composition |
| 010 (platform) | B2B operations: `durable_runs`, `workflow_checkpoints`, `dead_letter_queue`, `approval_proposals`, `approval_policies`, `audit_trail`, `skill_packages`, `skill_publishers`, `skill_installations`, `tenant_skill_policies`, `outcome_events`, `invoices`, `tenant_billing`, `egress_policies`, `data_flow_logs`, `tenants`, `roles`, `user_roles` |

## Docker

```bash
# Full stack: Postgres (pgvector) + Typesense + Gateway
docker compose up -d

# Services only (for npm run dev or npm run cli)
docker compose up -d postgres typesense

# Build and run standalone
docker build -t astra .
docker run -p 8080:8080 --env-file .env astra
```

Multi-stage build: builder stage compiles TypeScript, production stage runs with only production dependencies.
