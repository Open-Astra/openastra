// Patch console.log/warn/error to scrub secrets — must be first import
import "../utils/console-scrub.js";

import express, { Router } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../config/env.js";
import { initTypesense, ensureMemoryCollection, getTypesense } from "../config/typesense.js";
import { initEmbeddings, getEmbeddingProvider } from "../memory/embeddings.js";
import { initPostgres, pingPostgres, closePool } from "../config/postgres.js";
import { ensureGraphSchema } from "../memory/graph.js";
import { initJwt } from "../auth/jwt.js";
import { runMigrations } from "../db/migrate.js";
import { jwtAuth } from "./middleware/auth.js";
import { requestLogger, errorHandler, correlationId } from "./middleware/observability.js";
import { requestTimeout } from "./middleware/timeout.js";
import { rateLimiter } from "./middleware/ratelimit.js";
import { tokenBudget } from "./middleware/token-budget.js";
import { workspaceResolver } from "./middleware/workspace.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { csrfProtection } from "./middleware/csrf.js";
import { rlsContext } from "./middleware/rls.js";
import { createAuthRouter } from "./routes/auth.js";
import { createChatRouter } from "./routes/chat.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createAutonomousRouter } from "./routes/autonomous.js";
import { createAdminRouter } from "./routes/admin.js";
import { createWebhookRouter } from "./routes/webhooks.js";
import { createWorkspaceRouter } from "./routes/workspaces.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createOnboardingRouter } from "./routes/onboarding.js";
import { createSessionRouter } from "./routes/sessions.js";
import { createSkillRouter } from "./routes/skills.js";
import { createMetricsRouter } from "./routes/metrics.js";
import { createDiagnosticsRouter } from "./routes/diagnostics.js";
import { createCostDashboardRouter } from "./routes/cost-dashboard.js";
import { createHeartbeatRouter } from "./routes/heartbeat.js";
import { createTracesRouter } from "./routes/traces.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createOpenApiRouter } from "./routes/openapi.js";
import { createMemoryProfilesRouter } from "./routes/memory-profiles.js";
import { createLinearMappingsRouter } from "./routes/linear-mappings.js";
import { registerMountedRouter } from "./route-meta.js";
import { startJobWorker, stopJobWorker } from "../jobs/index.js";
import { userRateLimit } from "./middleware/user-rate-limit.js";
import { startGitHubChannel, stopGitHubChannel } from "../channels/github.js";
import { startLinearChannel, stopLinearChannel } from "../channels/linear.js";
import { createToolHotReloader } from "../tools/hot-reload.js";
import { loadAgentConfigs } from "../agents/config-store.js";
import { getInferenceClientForAgent } from "../inference/factory.js";
import { initWebSocket } from "./ws.js";
import { startTelegramBot, stopTelegramBot } from "../channels/telegram.js";
import { startIMessageChannel, stopIMessageChannel } from "../channels/imessage.js";
import { startWhatsAppChannel, stopWhatsAppChannel } from "../channels/whatsapp.js";
import { startSignalChannel, stopSignalChannel } from "../channels/signal.js";
import { startDiscordBot, stopDiscordBot } from "../channels/discord.js";
import { startSlackBot, stopSlackBot } from "../channels/slack.js";
import { startGoogleChatChannel, stopGoogleChatChannel } from "../channels/google-chat.js";
import { startTeamsChannel, stopTeamsChannel } from "../channels/teams.js";
import { startLineChannel, stopLineChannel } from "../channels/line.js";
import { startViberChannel, stopViberChannel } from "../channels/viber.js";
import { startTwitterChannel, stopTwitterChannel } from "../channels/twitter.js";
import { startEmailChannel, stopEmailChannel } from "../channels/email.js";
import { setDefaultAgentId } from "../channels/router.js";
import { startScheduler, stopScheduler } from "../scheduler/cron.js";
import { createGdprRouter } from "./routes/gdpr.js";

// Wave 1: Agent Intelligence
import { createDebateRouter } from "./routes/debates.js";
import { createGoalsRouter } from "./routes/goals.js";
import { createSpawnTreeRouter } from "./routes/spawn-tree.js";
// Wave 2: Developer Experience
import { createToolGraphRouter } from "./routes/tool-graph.js";
import { createPromptSwapRouter } from "./routes/prompt-swap.js";
import { createCostAttributionRouter } from "./routes/cost-attribution.js";
import { createSkillMarketplaceRouter } from "./routes/skill-marketplace.js";
// Wave 3: Collaboration
import { createApprovalsRouter } from "./routes/approvals.js";
import { createRoomsRouter } from "./routes/rooms.js";
// Wave 4: Memory
import { createKbSyncRouter } from "./routes/kb-sync.js";
import { createMemoryNamespacesRouter } from "./routes/memory-namespaces.js";
import { createMemoryExpiryRouter } from "./routes/memory-expiry.js";
import { createMemoryConflictsRouter } from "./routes/memory-conflicts.js";
import { createMemoryPortableRouter } from "./routes/memory-portable.js";
// Wave 5: Observability
import { createTraceSpansRouter } from "./routes/trace-spans.js";
import { createSlosRouter } from "./routes/slos.js";
import { createBudgetForecastRouter } from "./routes/budget-forecast.js";
// Wave 6: Security & Compliance
import { createDataPoliciesRouter } from "./routes/data-policies.js";
import { createAuditExportRouter } from "./routes/audit-export.js";
import { createPermissionRequestsRouter } from "./routes/permission-requests.js";
import { createWatermarkRouter } from "./routes/watermark.js";
// Wave 7: Infrastructure
import { createWorkersRouter } from "./routes/workers.js";
import { createFailoverRouter } from "./routes/failover.js";
import { createWorkspaceCloneRouter } from "./routes/workspace-clone.js";

// Wave 1 (Batch 2)
import { createAbTestsRouter } from "./routes/ab-tests.js";
import { createPlannerRouter } from "./routes/planner.js";
import { createParamSweepsRouter } from "./routes/param-sweeps.js";
// Wave 2 (Batch 2)
import { createOtelConfigRouter } from "./routes/otel-config.js";
import { createPromptTemplatesRouter } from "./routes/prompt-templates.js";
import { createPlaygroundRouter } from "./routes/playground.js";
import { createAgentProfilesRouter } from "./routes/agent-profiles.js";
import { createWebhookInspectorRouter } from "./routes/webhook-inspector.js";
import { createWebhookTestingRouter } from "./routes/webhook-testing.js";
// Wave 3 (Batch 2)
import { createWorkflowsRouter } from "./routes/workflows.js";
import { createPipelinesRouter } from "./routes/pipelines.js";
import { createTournamentsRouter } from "./routes/tournaments.js";
// Wave 4 (Batch 2)
import { createMemoryGraphVizRouter } from "./routes/memory-graph-viz.js";
import { createMemorySnapshotsRouter } from "./routes/memory-snapshots.js";
import { createKnowledgeMergeRouter } from "./routes/knowledge-merge.js";
import { createMemorySearchApiRouter } from "./routes/memory-search-api.js";
// Wave 5 (Batch 2)
import { createZapierRouter } from "./channels/zapier.js";
import { createJiraRouter } from "./channels/jira.js";
// Wave 6 (Batch 2)
import { createIpAllowlistRouter } from "./routes/ip-allowlist.js";
import { createSessionReplayAuditRouter } from "./routes/session-replay-audit.js";
import { createDpBudgetRouter } from "./routes/dp-budget.js";
import { createConsentRouter } from "./routes/consent.js";
// Wave 7 (Batch 2)
import { createDashboardSseRouter } from "./routes/dashboard-sse.js";
import { createLatencyHeatmapRouter } from "./routes/latency-heatmap.js";
import { createDlqRouter } from "./routes/dlq.js";
import { createHealthDashboardRouter } from "./routes/health-dashboard.js";
import { initPlaygroundWebSocket } from "./routes/playground.js";

// Batch 3 (Wave 1): Agent Intelligence
import { createBranchesRouter } from "./routes/branches.js";
import { createCostEstimateRouter } from "./routes/cost-estimate.js";
import { createCapabilityMatchRouter } from "./routes/capability-match.js";
import { createPromptVersionsRouter } from "./routes/prompt-versions.js";
import { createCrossWorkspaceRouter } from "./routes/cross-workspace.js";
import { createLeaderboardRouter } from "./routes/leaderboard.js";
import { createSkillChainsRouter } from "./routes/skill-chains.js";
// Batch 3 (Wave 2): Memory
import { createMemoryPinRouter } from "./routes/memory-pin.js";
import { createMemoryDecayRouter } from "./routes/memory-decay.js";
import { createKnowledgeExportRouter } from "./routes/knowledge-export.js";
import { createSessionDedupRouter } from "./routes/session-dedup.js";
import { createMemoryDiffRouter } from "./routes/memory-diff.js";
import { createEphemeralMemoryRouter } from "./routes/ephemeral-memory.js";
// Batch 3 (Wave 3): Inference
import { createBenchmarkRouter } from "./routes/benchmark.js";
import { createToolStreamRouter } from "./routes/tool-stream.js";
import { createToolCacheRouter } from "./routes/tool-cache.js";
import { createReadinessRouter } from "./routes/readiness.js";
import { createFallbackTestRouter } from "./routes/fallback-test.js";
import { createRaceRouter } from "./routes/race.js";
// Batch 3 (Wave 4): Observability
import { createToolTimelineRouter } from "./routes/tool-timeline.js";
import { createAgentReplayRouter } from "./routes/agent-replay.js";
import { createWorkspaceFeedRouter } from "./routes/workspace-feed.js";
import { createAuditVerifyRouter } from "./routes/audit-verify.js";
import { createAlertRulesRouter } from "./routes/alert-rules.js";
// Batch 3 (Wave 5): Developer Experience
import { createToolPlaygroundRouter } from "./routes/tool-playground.js";
import { createWorkspaceTemplatesRouter } from "./routes/workspace-templates.js";
import { createAgentCloneRouter } from "./routes/agent-clone.js";
// Batch 4: Agent Intelligence
import { createStructuredOutputRouter } from "./routes/structured-output.js";
import { createReflexionRouter } from "./routes/reflexion.js";
import { createAgentCredentialsRouter } from "./routes/agent-credentials.js";
import { createFewShotRouter } from "./routes/few-shot.js";
import { createOutputProcessorsRouter } from "./routes/output-processors.js";
import { createCheckpointsRouter } from "./routes/checkpoints.js";
import { createToolRetryRouter } from "./routes/tool-retry.js";
import { createCliquesRouter } from "./routes/cliques.js";
import { createToolAnalyticsRouter } from "./routes/tool-analytics.js";
import { createWhisperChainRouter } from "./routes/whisper-chain.js";
// Batch 4: Memory & Knowledge
import { createMemoryAclRouter } from "./routes/memory-acl.js";
import { createMemoryProvenanceRouter } from "./routes/memory-provenance.js";
import { createMemoryVersionsRouter } from "./routes/memory-versions.js";
import { createMemoryTemporalRouter } from "./routes/memory-temporal.js";
import { createMemoryClustersRouter } from "./routes/memory-clusters.js";
import { createKnowledgeDistillationRouter } from "./routes/knowledge-distillation.js";
import { createMemoryFederationRouter } from "./routes/memory-federation.js";
import { createVectorExportRouter } from "./routes/vector-export.js";
import { createMemoryL1CacheRouter } from "./routes/memory-l1-cache.js";
import { createMemorySchemasRouter } from "./routes/memory-schemas.js";
// Batch 5: Scheduled Tasks, Batch Inference, HTTP Pool
import { createScheduledTasksRouter } from "./routes/scheduled-tasks.js";
import { createBatchInferenceRouter } from "./routes/batch-inference.js";
import { destroyPools as destroyHttpPools } from "../inference/http-pool.js";
// Batch 5: Agent Voting, Blackboard, Specialization Routing, Cross-Agent Memory, Pipeline Templates
import { createRouteMessageRouter } from "./routes/route-message.js";
import { createSharedMemoriesRouter } from "./routes/shared-memories.js";
import { createPipelineTemplatesRouter } from "./routes/pipeline-templates.js";
// Features 10–12: Workspace Audit, Reputation, Team Formation
import { createWorkspaceAuditRouter } from "./routes/workspace-audit.js";
import { createReputationRouter } from "./routes/reputation.js";
import { createTeamFormationRouter } from "./routes/team-formation.js";
// Batch 6: Conflict Resolution, Interrupts, Team Roles
import { createConflictsRouter } from "./routes/conflicts.js";
import { createInterruptsRouter } from "./routes/interrupts.js";
import { createTeamRolesRouter } from "./routes/team-roles.js";
// Batch 7: Budget Pools, SLAs, Approval Workflows
import { createBudgetRouter } from "./routes/budget.js";
import { createSlaRouter } from "./routes/sla.js";
import { createApprovalWorkflowsRouter, createApprovalRequestsRouter } from "./routes/approval-workflows.js";
// Batch 8: Shared Context, Peer Learning, Retrospectives
import { createSharedContextRouter } from "./routes/shared-context.js";
import { createPeerLearningRouter } from "./routes/peer-learning.js";
import { createRetrospectivesRouter } from "./routes/retrospectives.js";

// Feature: Agent Presence, Messaging, Activity Feed
import { createPresenceRouter } from "./routes/presence.js";
import { createAgentMessagesRouter } from "./routes/agent-messages.js";
import { createActivityFeedRouter } from "./routes/activity-feed.js";
import { initActivityFeed } from "../agents/activity-feed.js";

// Batch 10: Gateway Features (G1-G5)
import { createQueueStatusRouter } from "./routes/queue-status.js";
import { createTenantRoutingRouter } from "./routes/tenant-routing.js";
import { createApiVersionsRouter } from "./routes/api-versions.js";
// Batch 10: Team Features (T1-T11)
import { createStandupsRouter } from "./routes/standups.js";
import { createMentoringRouter } from "./routes/mentoring.js";
import { createCapacityPlanRouter } from "./routes/capacity-plan.js";
import { createConsensusRouter } from "./routes/consensus.js";
import { createDependencyGraphRouter } from "./routes/dependency-graph.js";
import { createTeamChannelsRouter } from "./routes/team-channels.js";
import { createPairSessionsRouter } from "./routes/pair-sessions.js";
import { createTeamKbRouter } from "./routes/team-kb.js";
import { createEscalationChainsRouter } from "./routes/escalation-chains.js";
import { createWorkQueuesRouter } from "./routes/work-queues.js";
import { createTeamHealthRouter } from "./routes/team-health.js";
// Features T12–T15: Agent Onboarding, Liaisons, Availability, Team Optimizer
import { createOnboardingProtocolRouter } from "./routes/onboarding-protocol.js";
import { createLiaisonsRouter } from "./routes/liaisons.js";
import { createAgentAvailabilityRouter } from "./routes/agent-availability.js";
import { createTeamOptimizerRouter } from "./routes/team-optimizer.js";

// OpenAI-compatible API (P0 — drop-in for any OpenAI SDK client)
import { createOpenAICompatRouter } from "./routes/openai-compat.js";

// Session steering (nudge active sessions mid-flight)
import { createSteeringRouter } from "./routes/steering.js";

// Caching & Heartbeat Features
import { createSyntheticTxRouter } from "./routes/synthetic-tx.js";
import { startHealthAggregator } from "../heartbeat/health-aggregator.js";
import { startLatencyPredictor } from "../heartbeat/latency-predictor.js";
import { startInvalidationListener } from "../cache/invalidation-bus.js";

// MCP client bridge (connect to external MCP servers, register their tools)
import { loadMcpServers, stopMcpServers } from "../mcp/bridge.js";

// Moat features: Memory Contracts, CRDT Merge, Audit Ledger, Deterministic Replay, Agent Debugger
import { createMemoryContractsRouter } from "./routes/memory-contracts.js";
import { createMemoryCrdtRouter } from "./routes/memory-crdt.js";
import { createAuditLedgerRouter } from "./routes/audit-ledger.js";
import { createReplayRouter } from "./routes/replay.js";
import { createAgentDebuggerRouter } from "./routes/agent-debugger.js";

// Cache statistics (unified view of all cache layers)
import { createCacheStatsRouter } from "./routes/cache-stats.js";
// Cache health (lightweight in-process stats, no DB — safe for k8s probes)
import { createCacheHealthRouter } from "./routes/cache-health.js";

// Import tools to trigger registration
import "../tools/index.js";

// Initialize event bus (singleton — triggers dev-mode logging)
import { getEventBus } from "../events/index.js";
getEventBus();

// Audit logger (wired to event bus)
import { initAuditLogger } from "../events/audit.js";

// Intrusion detection
import { initIntrusionDetection, stopIntrusionDetection } from "../security/intrusion-detection.js";

// Plugin system
import type { GatewayPlugin } from "../plugins/types.js";
import { discoverPlugins, initPlugins, startPlugins, stopPlugins } from "../plugins/loader.js";
import { registerAgentConfig } from "../config/agents.js";
import { registerTool } from "../tools/registry.js";
import { startAnomalyDetector, getAnomalyDetector } from "../observability/tool-anomaly-detector.js";

// Skills system
import type { SkillDefinition } from "../skills/types.js";
import { discoverSkills, initSkills, startSkills, stopSkills } from "../skills/loader.js";

// Licensing
import { initLicense, stopLicenseRevalidation } from "../licensing/index.js";
import { licenseGuard } from "../licensing/middleware.js";
import { createLicenseRouter } from "./routes/license.js";

// Styled logger
import { printBanner, createLogger, divider } from "../utils/logger.js";
const log = createLogger("gateway");

// ── Bootstrap ───────────────────────────────────────────────────────

const env = loadEnv();

// ── Local Dev Safety Overrides ─────────────────────────────────────
// When LOCAL_DEV=true, enforce minimum security posture and disable
// external integrations that shouldn't fire during local development.
if (env.localDev) {
  log.warn("Running in LOCAL_DEV mode — not suitable for production");
  // Force sandbox to at least "process" — never allow "none" in local dev
  if (env.codeExecSandbox === "none") {
    (env as unknown as Record<string, unknown>).codeExecSandbox = "process";
    log.warn("CODE_EXEC_SANDBOX forced to 'process' (LOCAL_DEV override)");
  }
}

// Initialize JWT auth
initJwt({
  jwtSecret: env.jwtSecret,
  jwtSecretPrev: env.jwtSecretPrev,
  accessExpires: env.jwtAccessExpires,
  refreshExpires: env.jwtRefreshExpires,
  bindToDevice: env.bindJwtToDevice,
});

initTypesense(env);
initEmbeddings(env.geminiApiKey);
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

// Initialize read replica pool if PG_REPLICA_HOST is configured
if (env.pgReplicaHost) {
  import("../config/postgres-replica.js").then(({ initReplicaPool }) => {
    initReplicaPool({
      host: env.pgReplicaHost!,
      port: env.pgReplicaPort,
      database: env.pgReplicaDatabase ?? env.pgDatabase,
      user: env.pgUser,
      password: env.pgPassword,
    });
  }).catch(() => {});
}

// Per-agent client resolver — each agent gets its own provider/model
const resolveClient = getInferenceClientForAgent;

// ── Express App ─────────────────────────────────────────────────────

const app = express();

const appUse = app.use.bind(app) as (...args: any[]) => typeof app;
app.use = ((...args: any[]) => {
  const basePath = typeof args[0] === "string" ? args[0] : "/";
  const routerCandidate = [...args].reverse().find(isRouterLike);
  if (routerCandidate) {
    registerMountedRouter(basePath, routerCandidate);
  }
  return appUse(...args);
}) as typeof app.use;

// Security headers — before everything else
app.use(securityHeaders());

// Correlation ID — stamps X-Request-ID on every request/response
app.use(correlationId());

// CORS lockdown — restrict to configured origins
app.use(
  cors({
    origin: env.nodeEnv === "production" ? env.allowedOrigins : true,
    credentials: true,
  }),
);

// Cookie parser — required for CSRF double-submit cookie pattern
app.use(cookieParser());

app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    (req as unknown as Record<string, unknown>).rawBody = buf;
  },
}));
app.use(express.urlencoded({ limit: "1mb", extended: false }));

// CSRF protection — after JSON parsing, before routes
app.use(csrfProtection());

// Request logging — before all routes
app.use(requestLogger());

function isRouterLike(value: unknown): value is { stack: unknown[] } {
  return typeof value === "function" && Array.isArray((value as { stack?: unknown[] }).stack);
}

// ── Deep Health Check ───────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const checks: Record<string, "ok" | "error"> = {};

  // Typesense ping
  try {
    await getTypesense().health.retrieve();
    checks.typesense = "ok";
  } catch {
    checks.typesense = "error";
  }

  // PostgreSQL ping
  try {
    checks.postgres = (await pingPostgres()) ? "ok" : "error";
  } catch {
    checks.postgres = "error";
  }

  const allHealthy = Object.values(checks).every((v) => v === "ok");

  // Return minimal health info — no internal details, connection counts,
  // hostnames, or version numbers (security hardening Phase 8.3)
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? "healthy" : "degraded",
    checks: {
      db: checks.postgres === "ok",
      search: checks.typesense === "ok",
    },
  });
});

// OpenAI-compatible API (own API key auth — no JWT needed)
app.use("/", createOpenAICompatRouter());

// Auth routes (public — no auth middleware)
app.use("/auth", createAuthRouter());

// Authenticated agent routes: auth → token budget → workspace → rate limit → timeout
const agentRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 30 });
const agentRouter = Router();
agentRouter.use(jwtAuth(), licenseGuard(), tokenBudget(), workspaceResolver(), agentRateLimiter, userRateLimit(), requestTimeout());
agentRouter.use(createChatRouter(resolveClient));
agentRouter.use(createMemoryRouter());
app.use("/agent", agentRouter);

// Workspace management routes (authenticated)
app.use("/workspaces", jwtAuth(), createWorkspaceRouter());

// Agent configuration routes (authenticated + workspace-aware)
app.use("/agents", jwtAuth(), workspaceResolver(), createAgentsRouter());

// Onboarding routes (authenticated)
app.use("/onboarding", jwtAuth(), createOnboardingRouter());

// Webhook management routes (authenticated + workspace-aware)
app.use("/webhooks", jwtAuth(), workspaceResolver(), createWebhookRouter());

// Webhook testing mode routes (authenticated)
app.use("/webhooks", jwtAuth(), createWebhookTestingRouter());

// Session history routes (authenticated + workspace-aware + RLS)
app.use("/sessions", jwtAuth(), workspaceResolver(), rlsContext(), createSessionRouter());

// Session steering — inject runtime nudges into active sessions
app.use("/sessions", jwtAuth(), workspaceResolver(), createSteeringRouter());

// Cost dashboard routes (authenticated + workspace-aware)
app.use("/costs", jwtAuth(), workspaceResolver(), createCostDashboardRouter());

// Heartbeat monitor routes (authenticated + workspace-aware)
app.use("/heartbeat", jwtAuth(), workspaceResolver(), createHeartbeatRouter());

// Skill catalog routes (authenticated — exposes prompt instructions and tool names)
app.use("/skills", jwtAuth(), createSkillRouter());

// OpenAPI spec (public — served before the catch-all metrics router)
app.use("/", createOpenApiRouter());

// Metrics & readiness (no auth — for monitoring/load balancers)
app.use("/", createMetricsRouter());

// Internal autonomous agent routes (API key auth + rate limit)
const autonomousRateLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 60 });
app.use("/autonomous", autonomousRateLimiter, createAutonomousRouter(resolveClient));

// Admin monitoring routes (API key auth)
app.use("/admin", createAdminRouter());
app.use("/admin", createLicenseRouter());

// Diagnostics routes (API key auth)
app.use("/diagnostics", createDiagnosticsRouter());

// Traces routes (authenticated + workspace-aware + RLS)
app.use("/traces", jwtAuth(), workspaceResolver(), rlsContext(), createTracesRouter());

// Job queue routes (authenticated + workspace-aware)
app.use("/jobs", jwtAuth(), workspaceResolver(), createJobsRouter());

// Memory profile routes (authenticated + workspace-aware + RLS)
app.use("/memory-profiles", jwtAuth(), workspaceResolver(), rlsContext(), createMemoryProfilesRouter());

// Linear label→agent mapping routes (authenticated + workspace-aware)
app.use("/linear-mappings", jwtAuth(), workspaceResolver(), createLinearMappingsRouter());

// GDPR data deletion routes (authenticated)
app.use("/", jwtAuth(), createGdprRouter());

// Wave 1: Agent Intelligence
app.use("/debates", jwtAuth(), workspaceResolver(), createDebateRouter());
app.use("/goals", jwtAuth(), workspaceResolver(), createGoalsRouter());
app.use("/spawn-tree", jwtAuth(), workspaceResolver(), createSpawnTreeRouter());

// Wave 2: Developer Experience
app.use("/tools", jwtAuth(), createToolGraphRouter());
app.use("/", jwtAuth(), workspaceResolver(), createPromptSwapRouter());
app.use("/cost-attribution", jwtAuth(), workspaceResolver(), createCostAttributionRouter());
app.use("/skill-marketplace", jwtAuth(), workspaceResolver(), createSkillMarketplaceRouter());

// Wave 3: Collaboration
app.use("/approvals", jwtAuth(), workspaceResolver(), createApprovalsRouter());
app.use("/rooms", jwtAuth(), workspaceResolver(), createRoomsRouter());

// Wave 4: Memory
app.use("/kb-sync", jwtAuth(), workspaceResolver(), createKbSyncRouter());
app.use("/memory/namespaces", jwtAuth(), workspaceResolver(), createMemoryNamespacesRouter());
app.use("/memory/expiry-policies", jwtAuth(), workspaceResolver(), createMemoryExpiryRouter());
app.use("/memory/conflicts", jwtAuth(), workspaceResolver(), createMemoryConflictsRouter());
app.use("/memory/portable", jwtAuth(), workspaceResolver(), createMemoryPortableRouter());

// Wave 5: Observability
app.use("/trace-spans", jwtAuth(), workspaceResolver(), createTraceSpansRouter());
app.use("/slos", jwtAuth(), workspaceResolver(), createSlosRouter());
app.use("/budget-forecast", jwtAuth(), workspaceResolver(), createBudgetForecastRouter());

// Wave 6: Security & Compliance
app.use("/data-policies", jwtAuth(), workspaceResolver(), createDataPoliciesRouter());
app.use("/audit-log", jwtAuth(), workspaceResolver(), createAuditExportRouter());
app.use("/permission-requests", jwtAuth(), workspaceResolver(), createPermissionRequestsRouter());
app.use("/security/watermark", createWatermarkRouter()); // no auth needed for watermark detection

// Wave 7: Infrastructure
app.use("/", createWorkersRouter()); // admin routes handle their own auth
app.use("/", createFailoverRouter()); // admin routes handle their own auth
app.use("/workspaces", jwtAuth(), workspaceResolver(), createWorkspaceCloneRouter());

// Wave 1 (Batch 2): Agent Intelligence
app.use("/ab-tests", jwtAuth(), workspaceResolver(), createAbTestsRouter());
app.use("/planner", jwtAuth(), workspaceResolver(), createPlannerRouter());
app.use("/param-sweeps", jwtAuth(), workspaceResolver(), createParamSweepsRouter());

// Wave 2 (Batch 2): Developer Tools
app.use("/otel-config", jwtAuth(), workspaceResolver(), createOtelConfigRouter());
app.use("/prompt-templates", jwtAuth(), workspaceResolver(), createPromptTemplatesRouter());
app.use("/playground", jwtAuth(), createPlaygroundRouter());
app.use("/agent-profiles", jwtAuth(), workspaceResolver(), createAgentProfilesRouter());
app.use("/webhook-inspector", jwtAuth(), workspaceResolver(), createWebhookInspectorRouter());

// Wave 3 (Batch 2): Orchestration
app.use("/workflows", jwtAuth(), workspaceResolver(), createWorkflowsRouter());
app.use("/pipelines", jwtAuth(), workspaceResolver(), createPipelinesRouter());
app.use("/tournaments", jwtAuth(), workspaceResolver(), createTournamentsRouter());

// Wave 4 (Batch 2): Memory
app.use("/memory/graph-viz", jwtAuth(), workspaceResolver(), createMemoryGraphVizRouter());
app.use("/memory/snapshots", jwtAuth(), workspaceResolver(), createMemorySnapshotsRouter());
app.use("/memory/knowledge-merge", jwtAuth(), workspaceResolver(), createKnowledgeMergeRouter());
app.use("/memory/search", jwtAuth(), workspaceResolver(), createMemorySearchApiRouter());

// Wave 5 (Batch 2): Channels
app.use("/zapier", jwtAuth(), workspaceResolver(), createZapierRouter());
app.use("/jira", createJiraRouter()); // Jira uses its own HMAC verification

// Wave 6 (Batch 2): Security & Compliance
app.use("/security/ip-allowlist", jwtAuth(), workspaceResolver(), createIpAllowlistRouter());
app.use("/security/session-replay", jwtAuth(), workspaceResolver(), createSessionReplayAuditRouter());
app.use("/security/dp-budget", jwtAuth(), workspaceResolver(), createDpBudgetRouter());
app.use("/security/consent", jwtAuth(), workspaceResolver(), createConsentRouter());

// Wave 7 (Batch 2): Observability
app.use("/dashboard", jwtAuth(), workspaceResolver(), createDashboardSseRouter());
app.use("/observability", jwtAuth(), workspaceResolver(), createLatencyHeatmapRouter());
app.use("/jobs/dlq", jwtAuth(), workspaceResolver(), createDlqRouter());

// Batch 3 (Wave 1): Agent Intelligence
app.use("/", jwtAuth(), workspaceResolver(), createBranchesRouter());
app.use("/", jwtAuth(), workspaceResolver(), createCostEstimateRouter());
app.use("/", jwtAuth(), workspaceResolver(), createCapabilityMatchRouter());
app.use("/", jwtAuth(), workspaceResolver(), createPromptVersionsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createCrossWorkspaceRouter());
app.use("/", jwtAuth(), workspaceResolver(), createLeaderboardRouter());
app.use("/", jwtAuth(), workspaceResolver(), createSkillChainsRouter());

// Batch 3 (Wave 2): Memory
app.use("/", jwtAuth(), workspaceResolver(), createMemoryPinRouter());
app.use("/", jwtAuth(), workspaceResolver(), createMemoryDecayRouter());
app.use("/", jwtAuth(), workspaceResolver(), createKnowledgeExportRouter());
app.use("/", jwtAuth(), workspaceResolver(), createSessionDedupRouter());
app.use("/", jwtAuth(), workspaceResolver(), createMemoryDiffRouter());
app.use("/", jwtAuth(), workspaceResolver(), createEphemeralMemoryRouter());

// Batch 3 (Wave 3): Inference
app.use("/", jwtAuth(), workspaceResolver(), createBenchmarkRouter());
app.use("/", jwtAuth(), workspaceResolver(), createToolStreamRouter());
app.use("/", jwtAuth(), workspaceResolver(), createToolCacheRouter());
app.use("/", createReadinessRouter()); // no auth — for load balancers
app.use("/health", createHealthDashboardRouter()); // no auth — for monitoring
app.use("/", jwtAuth(), workspaceResolver(), createFallbackTestRouter());
app.use("/", jwtAuth(), workspaceResolver(), createRaceRouter());

// Batch 3 (Wave 4): Observability
app.use("/", jwtAuth(), workspaceResolver(), createToolTimelineRouter());
app.use("/", jwtAuth(), workspaceResolver(), createAgentReplayRouter());
app.use("/", jwtAuth(), workspaceResolver(), createWorkspaceFeedRouter());
app.use("/", jwtAuth(), workspaceResolver(), createAuditVerifyRouter());
app.use("/", jwtAuth(), workspaceResolver(), createAlertRulesRouter());

// Batch 3 (Wave 5): Developer Experience
app.use("/", jwtAuth(), createToolPlaygroundRouter());
app.use("/", jwtAuth(), workspaceResolver(), createWorkspaceTemplatesRouter());
app.use("/", jwtAuth(), workspaceResolver(), createAgentCloneRouter());

// Batch 4: Agent Intelligence
app.use("/structured-output", jwtAuth(), workspaceResolver(), createStructuredOutputRouter());
app.use("/reflexion", jwtAuth(), workspaceResolver(), createReflexionRouter());
app.use("/agent-credentials", jwtAuth(), workspaceResolver(), createAgentCredentialsRouter());
app.use("/few-shot", jwtAuth(), workspaceResolver(), createFewShotRouter());
app.use("/output-processors", jwtAuth(), workspaceResolver(), createOutputProcessorsRouter());
app.use("/checkpoints", jwtAuth(), workspaceResolver(), createCheckpointsRouter());
app.use("/tool-retry", jwtAuth(), workspaceResolver(), createToolRetryRouter());
app.use("/cliques", jwtAuth(), workspaceResolver(), createCliquesRouter());
app.use("/tool-analytics", jwtAuth(), workspaceResolver(), createToolAnalyticsRouter());
app.use("/whisper-chain", jwtAuth(), workspaceResolver(), createWhisperChainRouter());
// Batch 4: Memory & Knowledge
app.use("/memory/acl", jwtAuth(), workspaceResolver(), createMemoryAclRouter());
app.use("/memory/provenance", jwtAuth(), workspaceResolver(), createMemoryProvenanceRouter());
app.use("/memory/versions", jwtAuth(), workspaceResolver(), createMemoryVersionsRouter());
app.use("/memory/temporal", jwtAuth(), workspaceResolver(), createMemoryTemporalRouter());
app.use("/memory/clusters", jwtAuth(), workspaceResolver(), createMemoryClustersRouter());
app.use("/knowledge-distillation", jwtAuth(), workspaceResolver(), createKnowledgeDistillationRouter());
app.use("/memory/federation", jwtAuth(), workspaceResolver(), createMemoryFederationRouter());
app.use("/vector-export", jwtAuth(), workspaceResolver(), createVectorExportRouter());
app.use("/memory/l1-cache", jwtAuth(), createMemoryL1CacheRouter());
app.use("/memory/schemas", jwtAuth(), workspaceResolver(), createMemorySchemasRouter());

// Batch 5: Scheduled Tasks + Batch Inference
app.use("/scheduled-tasks", jwtAuth(), workspaceResolver(), createScheduledTasksRouter());
app.use("/batch-inference", jwtAuth(), workspaceResolver(), createBatchInferenceRouter());

// Batch 5: Agent Voting, Specialization Routing, Cross-Agent Memory, Pipeline Templates
app.use("/", jwtAuth(), createRouteMessageRouter());
app.use("/", jwtAuth(), createSharedMemoriesRouter());
app.use("/", jwtAuth(), createPipelineTemplatesRouter());

// Batch 6: Conflict Resolution, Interrupts, Team Roles
app.use("/conflicts", jwtAuth(), workspaceResolver(), createConflictsRouter());
app.use("/interrupts", jwtAuth(), workspaceResolver(), createInterruptsRouter());
app.use("/team-roles", jwtAuth(), workspaceResolver(), createTeamRolesRouter());

// Features 10–12: Workspace Audit, Reputation, Team Formation
app.use("/workspace-audit", jwtAuth(), workspaceResolver(), createWorkspaceAuditRouter());
app.use("/reputation", jwtAuth(), workspaceResolver(), createReputationRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTeamFormationRouter());

// Batch 8: Shared Context, Peer Learning, Retrospectives
app.use("/", jwtAuth(), workspaceResolver(), createSharedContextRouter());
app.use("/", jwtAuth(), workspaceResolver(), createPeerLearningRouter());
app.use("/", jwtAuth(), workspaceResolver(), createRetrospectivesRouter());

// Batch 9: Budget Pools, SLAs, Approval Workflows
app.use("/budget", jwtAuth(), workspaceResolver(), createBudgetRouter());
app.use("/sla", jwtAuth(), workspaceResolver(), createSlaRouter());
app.use("/approval-workflows", jwtAuth(), workspaceResolver(), createApprovalWorkflowsRouter());
app.use("/approval-requests", jwtAuth(), workspaceResolver(), createApprovalRequestsRouter());

// Feature: Agent Presence, Messaging, Activity Feed
app.use("/presence", jwtAuth(), workspaceResolver(), createPresenceRouter());
app.use("/agent-messages", jwtAuth(), workspaceResolver(), createAgentMessagesRouter());
app.use("/activity-feed", jwtAuth(), workspaceResolver(), createActivityFeedRouter());

// Batch 10: Gateway Features (G1-G5)
app.use("/", jwtAuth(), createQueueStatusRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTenantRoutingRouter());
app.use("/", jwtAuth(), createApiVersionsRouter());

// Batch 10: Team Features (T1-T11)
app.use("/", jwtAuth(), workspaceResolver(), createStandupsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createMentoringRouter());
app.use("/", jwtAuth(), workspaceResolver(), createCapacityPlanRouter());
app.use("/", jwtAuth(), workspaceResolver(), createConsensusRouter());
app.use("/", jwtAuth(), workspaceResolver(), createDependencyGraphRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTeamChannelsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createPairSessionsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTeamKbRouter());
app.use("/", jwtAuth(), workspaceResolver(), createEscalationChainsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createWorkQueuesRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTeamHealthRouter());

// Features T12–T15: Agent Onboarding, Liaisons, Availability, Team Optimizer
app.use("/", jwtAuth(), workspaceResolver(), createOnboardingProtocolRouter());
app.use("/", jwtAuth(), workspaceResolver(), createLiaisonsRouter());
app.use("/", jwtAuth(), workspaceResolver(), createAgentAvailabilityRouter());
app.use("/", jwtAuth(), workspaceResolver(), createTeamOptimizerRouter());

// Moat features: Memory Contracts, CRDT Merge, Audit Ledger, Replay, Debugger
app.use("/memory/contracts", jwtAuth(), workspaceResolver(), createMemoryContractsRouter());
app.use("/memory/crdt", jwtAuth(), workspaceResolver(), createMemoryCrdtRouter());
app.use("/audit-ledger", jwtAuth(), workspaceResolver(), createAuditLedgerRouter());
app.use("/recordings", jwtAuth(), workspaceResolver(), createReplayRouter());
app.use("/debug", jwtAuth(), workspaceResolver(), createAgentDebuggerRouter());

// Cache health — no auth, lightweight in-process stats, safe for k8s readiness probes
app.use("/cache", createCacheHealthRouter());
// Cache statistics (unified view across semantic, provider, and embedding caches)
app.use("/cache", jwtAuth(), createCacheStatsRouter());

// Synthetic transactions (heartbeat feature)
app.use("/heartbeat", createSyntheticTxRouter());

// Error handler — must be last middleware
app.use(errorHandler());

// ── Start ───────────────────────────────────────────────────────────

let httpServer: http.Server;
let loadedPlugins: GatewayPlugin[] = [];
let loadedSkills: SkillDefinition[] = [];
let grpcServer: unknown;

async function start() {
  // Run database migrations
  await runMigrations();

  // Initialize audit logger (subscribes to event bus for compliance logging)
  initAuditLogger();

  // Initialize activity feed (subscribes to event bus for workspace feeds)
  initActivityFeed();

  // Initialize tool anomaly detector (subscribes to tool executions for alerts)
  startAnomalyDetector();

  // Initialize intrusion detection (threshold-based anomaly alerting)
  initIntrusionDetection();

  // Initialize skill metrics listener (records skill.executed events to skill_metrics table)
  const { startSkillMetricsListener } = await import("../skills/metrics.js");
  startSkillMetricsListener();

  // Initialize Odds API client if configured
  if (process.env.ODDS_API_KEY) {
    const { initOddsApi } = await import("../data/odds-api.js");
    initOddsApi(process.env.ODDS_API_KEY);
  }

  // Initialize cold store if configured
  if (env.coldStoreBackend && env.coldStoreBucket) {
    const { initColdStore, setColdStoreEncryptionKey } = await import("../memory/cold-store.js");
    initColdStore({
      backend: env.coldStoreBackend as "s3" | "gcs" | "local",
      bucket: env.coldStoreBucket,
      prefix: env.coldStorePrefix,
      region: env.coldStoreRegion,
    });
    // Initialize encryption for cold store snapshots (AES-256-GCM)
    setColdStoreEncryptionKey(env.coldStoreEncryptionKey);
  }

  // Load all agent configs from Postgres into runtime registry
  await loadAgentConfigs();

  // Register this node in the agent mesh if gossip is enabled
  if (env.meshGossipEnabled) {
    const { registerMeshNode } = await import("../agents/mesh-gossip.js");
    await registerMeshNode("default", [], "localhost", env.port).catch(() => {});
  }

  // Load YAML-defined agent teams (astra.yml) — Vagrant-style
  const { loadAstraConfig, seedAgentsFromConfig, seedWorkspaceFromConfig } = await import("../config/yaml-loader.js");
  const yamlConfig = await loadAstraConfig();

  // Validate license key (XenForo-style: startup + 24h re-validation)
  const yamlLicenseKey = (yamlConfig as any)?.license?.key as string | undefined;
  await initLicense(yamlLicenseKey);

  if (yamlConfig) {
    const seeded = seedAgentsFromConfig(yamlConfig);
    log.info(`Loaded ${seeded.length} agent(s) from astra.yml`);

    // Pre-warm workspace bootstrap cache + sync files to DB + start file watcher
    try {
      const { loadWorkspaceBootstrap, getLoadedWorkspaceFiles } = await import("../workspace/loader.js");
      const { syncWorkspaceFilesToDb, startWorkspaceWatcher } = await import("../workspace/watcher.js");
      await loadWorkspaceBootstrap();
      await syncWorkspaceFilesToDb();
      const wsFiles = getLoadedWorkspaceFiles();
      if (wsFiles.length > 0) {
        log.active("Workspace", wsFiles.join(", "));
      } else {
        log.dim("No workspace/ folder — create ./workspace/*.md to bootstrap agent context");
      }
      startWorkspaceWatcher();
    } catch (err) {
      log.dim(`Workspace: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Seed workspace from YAML config (idempotent)
    let seededWorkspaceId: string | null = null;
    try {
      seededWorkspaceId = await seedWorkspaceFromConfig(yamlConfig);
      if (seededWorkspaceId) {
        log.kv("Workspace", seededWorkspaceId);
      }
    } catch (err) {
      log.dim(`Workspace seeding skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Seed heartbeat configs from YAML (idempotent)
    if (yamlConfig.heartbeats?.length) {
      try {
        const { seedHeartbeatsFromConfig } = await import("../config/yaml-loader.js");
        await seedHeartbeatsFromConfig(yamlConfig, seededWorkspaceId);
      } catch (err) {
        log.dim(`Heartbeat seeding skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // YAML channel config can override env vars for channel activation.
    // enabled: true + token/creds → start channel (YAML values override env).
    // enabled: false → disable channel even if env vars are set.
    // enabled: unset → fall through to env var behavior.
    if (yamlConfig.channels?.telegram) {
      const tgCfg = yamlConfig.channels.telegram;
      if (tgCfg.token) env.telegramBotToken = tgCfg.token;
      if (tgCfg.enabled === false) env.telegramBotToken = undefined;
      if (tgCfg.userMap) {
        const { setChannelUserMap } = await import("../channels/base.js");
        setChannelUserMap("telegram", tgCfg.userMap);
      } else {
        console.log("[gateway] telegram.userMap is falsy:", tgCfg.userMap, "keys:", Object.keys(tgCfg));
      }
    }
    if (yamlConfig.channels?.imessage) {
      const imCfg = yamlConfig.channels.imessage;
      if (imCfg.blueBubblesUrl) env.blueBubblesUrl = imCfg.blueBubblesUrl;
      if (imCfg.blueBubblesPassword) env.blueBubblesPassword = imCfg.blueBubblesPassword;
      if (imCfg.enabled === false) {
        env.blueBubblesUrl = undefined;
        env.blueBubblesPassword = undefined;
      }
    }
    if (yamlConfig.channels?.whatsapp) {
      const waCfg = yamlConfig.channels.whatsapp;
      if (waCfg.phoneNumberId) env.whatsappPhoneNumberId = waCfg.phoneNumberId;
      if (waCfg.accessToken) env.whatsappAccessToken = waCfg.accessToken;
      if (waCfg.verifyToken) env.whatsappVerifyToken = waCfg.verifyToken;
      if (waCfg.enabled === false) {
        env.whatsappPhoneNumberId = undefined;
        env.whatsappAccessToken = undefined;
        env.whatsappVerifyToken = undefined;
      }
    }
    if (yamlConfig.channels?.signal) {
      const sigCfg = yamlConfig.channels.signal;
      if (sigCfg.apiUrl) env.signalApiUrl = sigCfg.apiUrl;
      if (sigCfg.phoneNumber) env.signalPhoneNumber = sigCfg.phoneNumber;
      if (sigCfg.enabled === false) {
        env.signalApiUrl = undefined;
        env.signalPhoneNumber = undefined;
      }
    }
    if (yamlConfig.channels?.discord) {
      const dcCfg = yamlConfig.channels.discord;
      if (dcCfg.token) env.discordBotToken = dcCfg.token;
      if (dcCfg.enabled === false) env.discordBotToken = undefined;
    }
    if (yamlConfig.channels?.slack) {
      const slkCfg = yamlConfig.channels.slack;
      if (slkCfg.botToken) env.slackBotToken = slkCfg.botToken;
      if (slkCfg.signingSecret) env.slackSigningSecret = slkCfg.signingSecret;
      if (slkCfg.enabled === false) {
        env.slackBotToken = undefined;
        env.slackSigningSecret = undefined;
      }
    }
    if (yamlConfig.channels?.googleChat) {
      const gcCfg = yamlConfig.channels.googleChat;
      if (gcCfg.serviceAccountKey) env.googleChatServiceAccountKey = gcCfg.serviceAccountKey;
      if (gcCfg.enabled !== undefined) env.googleChatEnabled = gcCfg.enabled;
    }
    if (yamlConfig.channels?.teams) {
      const tmCfg = yamlConfig.channels.teams;
      if (tmCfg.appId) env.teamsAppId = tmCfg.appId;
      if (tmCfg.appPassword) env.teamsAppPassword = tmCfg.appPassword;
      if (tmCfg.enabled === false) {
        env.teamsAppId = undefined;
        env.teamsAppPassword = undefined;
      }
    }
    if (yamlConfig.channels?.line) {
      const lnCfg = yamlConfig.channels.line;
      if (lnCfg.channelAccessToken) env.lineChannelAccessToken = lnCfg.channelAccessToken;
      if (lnCfg.channelSecret) env.lineChannelSecret = lnCfg.channelSecret;
      if (lnCfg.enabled === false) {
        env.lineChannelAccessToken = undefined;
        env.lineChannelSecret = undefined;
      }
    }
    if (yamlConfig.channels?.viber) {
      const vbCfg = yamlConfig.channels.viber;
      if (vbCfg.authToken) env.viberAuthToken = vbCfg.authToken;
      if (vbCfg.botName) env.viberBotName = vbCfg.botName;
      if (vbCfg.enabled === false) {
        env.viberAuthToken = undefined;
        env.viberBotName = undefined;
      }
    }
    if (yamlConfig.channels?.twitter) {
      const twCfg = yamlConfig.channels.twitter;
      if (twCfg.apiKey) env.xApiKey = twCfg.apiKey;
      if (twCfg.apiSecret) env.xApiSecret = twCfg.apiSecret;
      if (twCfg.accessToken) env.xAccessToken = twCfg.accessToken;
      if (twCfg.accessTokenSecret) env.xAccessTokenSecret = twCfg.accessTokenSecret;
      if (twCfg.webhookEnv) env.xWebhookEnv = twCfg.webhookEnv;
      if (twCfg.enabled === false) {
        env.xApiKey = undefined;
        env.xApiSecret = undefined;
        env.xAccessToken = undefined;
        env.xAccessTokenSecret = undefined;
      }
    }
    if ((yamlConfig.channels as Record<string, unknown>)?.linear) {
      const lnCfg = (yamlConfig.channels as Record<string, unknown>).linear as Record<string, unknown>;
      if (lnCfg.webhookSecret) env.linearWebhookSecret = lnCfg.webhookSecret as string;
      if (lnCfg.apiKey) env.linearApiKey = lnCfg.apiKey as string;
      if (lnCfg.enabled === false) {
        env.linearWebhookSecret = undefined;
        env.linearApiKey = undefined;
      }
    }
  }

  // Ensure data stores are ready before accepting traffic
  await ensureMemoryCollection();
  await ensureGraphSchema();

  // Shared context for plugins and skills
  const pluginLog = createLogger("plugin");
  const sharedCtx = {
    app,
    resolveClient,
    getEventBus,
    registerTool,
    registerAgentConfig,
    logger: {
      info: (...args: unknown[]) => pluginLog.info(...args),
      error: (...args: unknown[]) => pluginLog.error(...args),
    },
  };

  // Discover and initialize plugins
  const pluginDir = fileURLToPath(new URL("../plugins/core", import.meta.url));
  loadedPlugins = await discoverPlugins(pluginDir);
  await initPlugins(loadedPlugins, sharedCtx);
  await startPlugins(loadedPlugins);

  // Discover and initialize skills
  const skillDir = fileURLToPath(new URL("../skills/definitions", import.meta.url));
  loadedSkills = await discoverSkills(skillDir);
  await initSkills(loadedSkills, sharedCtx);
  await startSkills(loadedSkills);

  // Connect to MCP servers declared in astra.yml and register their tools
  if (yamlConfig && (yamlConfig as any).mcpServers?.length) {
    await loadMcpServers((yamlConfig as any).mcpServers);
  }

  httpServer = http.createServer(app);

  // Connection limits — Phase 5.4 of security audit
  httpServer.maxConnections = 1000;
  httpServer.headersTimeout = 20_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 65_000; // slightly longer than typical LB idle timeout of 60s

  // Initialize WebSocket on the same HTTP server (with bidirectional agent streaming)
  initWebSocket(httpServer, resolveClient);

  // Initialize Playground WebSocket for interactive agent testing
  initPlaygroundWebSocket(httpServer, resolveClient);

  // Set default agent for channel routing
  if (env.defaultAgentId) {
    setDefaultAgentId(env.defaultAgentId);
  }

  // Start Telegram bot if token is configured
  if (env.telegramBotToken) {
    startTelegramBot(env.telegramBotToken, resolveClient);
  }

  // Start iMessage (BlueBubbles) if configured
  if (env.blueBubblesUrl && env.blueBubblesPassword) {
    startIMessageChannel(env.blueBubblesUrl, env.blueBubblesPassword, resolveClient, app);
  }

  // Start WhatsApp if configured
  if (env.whatsappPhoneNumberId && env.whatsappAccessToken && env.whatsappVerifyToken) {
    startWhatsAppChannel(env.whatsappPhoneNumberId, env.whatsappAccessToken, env.whatsappVerifyToken, resolveClient, app);
  }

  // Start Signal if configured
  if (env.signalApiUrl && env.signalPhoneNumber) {
    startSignalChannel(env.signalApiUrl, env.signalPhoneNumber, resolveClient, app);
  }

  // Start Discord bot if configured
  if (env.discordBotToken) {
    startDiscordBot(env.discordBotToken, resolveClient);
  }

  // Start Slack bot if configured
  if (env.slackBotToken && env.slackSigningSecret) {
    startSlackBot(env.slackBotToken, env.slackSigningSecret, resolveClient, app);
  }

  // Start Google Chat if configured
  if (env.googleChatEnabled) {
    startGoogleChatChannel(resolveClient, env.googleChatServiceAccountKey, app);
  }

  // Start Microsoft Teams if configured
  if (env.teamsAppId && env.teamsAppPassword) {
    startTeamsChannel(env.teamsAppId, env.teamsAppPassword, resolveClient, app);
  }

  // Start LINE if configured
  if (env.lineChannelAccessToken && env.lineChannelSecret) {
    startLineChannel(env.lineChannelAccessToken, env.lineChannelSecret, resolveClient, app);
  }

  // Start Viber if configured
  if (env.viberAuthToken) {
    startViberChannel(env.viberAuthToken, env.viberBotName ?? "Astra", resolveClient, app);
  }

  // Start X/Twitter DMs if configured
  if (env.xApiKey && env.xApiSecret && env.xAccessToken && env.xAccessTokenSecret) {
    startTwitterChannel(
      env.xApiKey,
      env.xApiSecret,
      env.xAccessToken,
      env.xAccessTokenSecret,
      env.xBearerToken,
      env.xWebhookEnv ?? "dev",
      resolveClient,
      app,
    );
  }

  // Start Email channel if SMTP is configured
  if (env.smtpHost && env.smtpUser && env.smtpPassword && env.smtpFrom) {
    startEmailChannel(
      {
        host: env.smtpHost,
        port: env.smtpPort ?? 587,
        user: env.smtpUser,
        password: env.smtpPassword,
        from: env.smtpFrom,
        secure: env.smtpSecure,
      },
      resolveClient,
      app,
      env.emailWebhookSecret,
    );
  }

  // Start GitHub App channel if configured
  const githubAppId = process.env.GITHUB_APP_ID;
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (githubAppId && githubWebhookSecret) {
    startGitHubChannel(
      { appId: githubAppId, webhookSecret: githubWebhookSecret, installationId: process.env.GITHUB_INSTALLATION_ID },
      resolveClient,
      app,
    );
  }

  // Start Linear channel if configured
  if (env.linearWebhookSecret && env.linearApiKey) {
    startLinearChannel(
      { webhookSecret: env.linearWebhookSecret, apiKey: env.linearApiKey },
      resolveClient,
      app,
    );
  }

  // Start deadlock watchdog — expires stuck active sessions after 2 min of silence
  const { startDeadlockWatchdog } = await import("../sessions/store.js");
  startDeadlockWatchdog();

  // Start health aggregator (monitors provider health across requests)
  startHealthAggregator();

  // Start latency predictor (detects degradation trends)
  startLatencyPredictor();

  // Start cache invalidation listener (processes invalidation events)
  if ((env as any).cacheInvalidationBusEnabled ?? true) {
    try {
      await startInvalidationListener();
    } catch (err) {
      log.dim(`Cache invalidation listener init: ${err}`);
    }
  }

  // Initialize ML cache warmer (feature 4: cache warming from predictions)
  if (env.mlCacheWarmingEnabled) {
    log.dim("ML cache warmer enabled — predictions will be warmed hourly");
  }

  // Start cron scheduler for autonomous agents
  await startScheduler(resolveClient);

  // Start background job worker
  await startJobWorker();

  // Start self-healing system (auto-restart + auto-compaction)
  const { startSelfHealing } = await import("../agents/self-healing.js");
  const selfHealingCfg = (yamlConfig as any)?.selfHealing ?? {};
  startSelfHealing(selfHealingCfg);

  // Start plugin hot-reload (watches plugin/skill dirs for live changes)
  const { getHotReloader } = await import("../plugins/hot-reload.js");
  const hotReloadCfg = (yamlConfig as any)?.hotReload ?? {};
  if (hotReloadCfg.enabled !== false) {
    const reloader = getHotReloader({
      pluginDirs: [pluginDir, skillDir],
      debounceMs: hotReloadCfg.debounceMs,
    });
    reloader.start(sharedCtx, loadedPlugins);
  }

  // Start tool hot-reload in development
  if (env.nodeEnv !== "production") {
    createToolHotReloader().start();
  }

  // Initialize local model router if configured
  const localModelsCfg = (yamlConfig as any)?.localModels;
  if (localModelsCfg) {
    const { initLocalRouter } = await import("../inference/local-router.js");
    initLocalRouter(localModelsCfg).catch((err: unknown) => {
      log.dim(`Local model router init: ${err}`);
    });
  }

  httpServer.listen(env.port, () => {
    printBanner();
    divider();
    log.connection("HTTP", `http://localhost:${env.port}`);
    log.connection("WebSocket", `ws://localhost:${env.port}/ws`);
    log.connection("PostgreSQL", `${env.pgUseSocket ? "socket" : `${env.pgHost}:${env.pgPort}`}/${env.pgDatabase}`);
    log.connection("Typesense", `${env.typesenseHost}:${env.typesensePort}`);
    divider();

    // Channels
    if (env.telegramBotToken) log.active("Telegram");
    else log.inactive("Telegram", "no token");
    if (env.blueBubblesUrl) log.active("iMessage", "BlueBubbles");
    else log.inactive("iMessage", "not configured");
    if (env.whatsappPhoneNumberId) log.active("WhatsApp", "Cloud API");
    else log.inactive("WhatsApp", "not configured");
    if (env.signalApiUrl) log.active("Signal", "signal-cli");
    else log.inactive("Signal", "not configured");
    if (env.discordBotToken) log.active("Discord");
    else log.inactive("Discord", "no token");
    if (env.slackBotToken) log.active("Slack");
    else log.inactive("Slack", "no token");
    if (env.googleChatEnabled) log.active("Google Chat");
    else log.inactive("Google Chat", "not enabled");
    if (env.teamsAppId) log.active("Microsoft Teams");
    else log.inactive("Microsoft Teams", "not configured");
    if (env.lineChannelAccessToken) log.active("LINE");
    else log.inactive("LINE", "not configured");
    if (env.viberAuthToken) log.active("Viber");
    else log.inactive("Viber", "not configured");
    if (env.xApiKey) log.active("X/Twitter DMs");
    else log.inactive("X/Twitter DMs", "not configured");
    if (process.env.GITHUB_APP_ID) log.active("GitHub App");
    else log.inactive("GitHub App", "not configured");
    if (env.linearWebhookSecret) log.active("Linear");
    else log.inactive("Linear", "not configured");

    // Features
    if (env.openaiApiKey) log.active("OpenAI fallback");
    if (env.defaultAgentId) log.kv("Default agent", env.defaultAgentId);

    // Embedding provider
    const embProv = getEmbeddingProvider();
    log.kv("Embeddings", embProv === "gemini" ? "Gemini (cloud)" : "Local (n-gram)");
    log.dim("CORS", env.allowedOrigins.join(", "));
    log.kv("Environment", env.nodeEnv);
    divider();
    log.info(`Listening on port ${env.port}`);
  });

  // Start gRPC server if enabled
  if (env.grpcEnabled) {
    const { startGrpcServer } = await import("../grpc/server.js");
    grpcServer = startGrpcServer(env.grpcPort);
    log.active("gRPC", `port ${env.grpcPort}`);
  }
}

// ── Graceful Shutdown ───────────────────────────────────────────────

async function shutdown(signal: string) {
  log.warn(`${signal} received — shutting down gracefully...`);

  // Stop MCP server connections
  await stopMcpServers();

  // Stop skills
  await stopSkills(loadedSkills);

  // Stop plugins
  await stopPlugins(loadedPlugins);

  // Stop gRPC server
  if (grpcServer) {
    const { stopGrpcServer } = await import("../grpc/server.js");
    stopGrpcServer(grpcServer as Parameters<typeof stopGrpcServer>[0]);
  }

  // Stop license re-validation timer
  stopLicenseRevalidation();

  // Stop self-healing and hot-reload
  const { stopSelfHealing } = await import("../agents/self-healing.js");
  stopSelfHealing();
  const { getHotReloader } = await import("../plugins/hot-reload.js");
  getHotReloader().stop();

  // Stop workspace file watcher
  try {
    const { stopWorkspaceWatcher } = await import("../workspace/watcher.js");
    stopWorkspaceWatcher();
  } catch { /* ignore if not started */ }

  // Stop background job worker
  await stopJobWorker();

  // Stop accepting new cron jobs and channel messages
  stopScheduler();
  stopTelegramBot();
  stopIMessageChannel();
  stopWhatsAppChannel();
  stopSignalChannel();
  stopDiscordBot();
  stopSlackBot();
  stopGoogleChatChannel();
  stopTeamsChannel();
  stopLineChannel();
  stopViberChannel();
  stopTwitterChannel();
  stopEmailChannel();
  stopGitHubChannel();
  stopLinearChannel();
  stopIntrusionDetection();
  getAnomalyDetector()?.stop();

  // Close HTTP server (stops accepting new connections)
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  // Destroy HTTP connection pools
  destroyHttpPools();

  // Close PostgreSQL pool
  await closePool();

  log.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start().catch((err) => {
  log.error("Failed to start:", err);
  process.exit(1);
});
