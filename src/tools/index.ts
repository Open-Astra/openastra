// ── Tool Registration ───────────────────────────────────────────────
// Import all tool modules to trigger their registerTool() calls.
// Add new tools here as they're built.

import "./prop-lookup.js";
import "./line-compare.js";
import "./x-search.js";
import "./memory-write.js";
import "./memory-search.js";
import "./model-inference.js";
import "./kelly-criterion.js";
import "./portfolio-optimizer.js";
import "./push-notify.js";
import "./agent-spawn.js";

// General-purpose tools
import "./file-read.js";
import "./file-write.js";
import "./shell-execute.js";
import "./url-fetch.js";

// Graph exploration
import "./graph-query.js";

// Memory management
import "./memory-export.js";

// Advanced features
import "./approval-resolve.js";
import "./rag-search.js";
import "./research-manage.js";
import "./dream-manage.js";

// New tools
import "./web-search.js";
import "./code-execute.js";
import "./image-generate.js";
import "./database-query.js";
import "./calendar-event.js";
import "./email-send.js";
import "./http-request.js";
import "./pdf-read.js";
import "./clipboard.js";
import "./screenshot.js";

// Analytics
import "./ga4-query.js";
import "./ga4-realtime.js";

// Email
import "./gmail-read.js";
import "./gmail-reply.js";

// Workspace collaboration
import "./workspace-memory.js";
import "./workspace-knowledge.js";

// Engineering tools
import "./codebase-index.js";
import "./codebase-search.js";

// ── Feature Batch: Multi-Agent & Memory Management ──────────────────

// Swarm & orchestration
import "./code-review-swarm.js";
import "./swarm-observer.js";
import "./meta-controller.js";
import "./blackboard-topics.js";
import "./debate-witnesses.js";

// Memory management
import "./memory-compress.js";
import "./memory-propagation.js";
import "./memory-budget.js";
import "./consistency-check.js";
import "./memory-feedback.js";
import "./relation-decay.js";

// Session & scenario
import "./session-branch.js";
import "./scenario-engine.js";

// Multi-modal & routing
import "./multimodal-input.js";
import "./provider-router.js";

// Agent self-improvement
import "./ethical-check.js";
import "./agent-therapy.js";
import "./health-scorecard.js";
import "./evolution-feedback.js";

// Workspace
import "./prompt-templates.js";
import "./knowledge-inject.js";

// ── Multi-Person Workflow Extensions ────────────────────────────────
import "./conflict-free-merge.js";
import "./team-memory-propagate.js";
import "./agent-specialization-router.js";
import "./contextual-boost.js";

import "./tool-poll.js";

// Data & patching tools
import "./graphql-query.js";
import "./sql-query.js";
import "./patch-apply.js";

// Graph schema management
import "./graph-schema-evolution.js";

// Collaboration tools (Wave 3)
import "./delegate-task.js";
import "./gather-standup-data.js";

// ── Wave 5: Calendar, GitHub PR, Jira ───────────────────────────────

// Calendar tools (Feature 28)
import "./get-current-datetime.js";
import "./parse-date-expression.js";

// GitHub PR tools (Feature 29)
import "./get-github-pr.js";
import "./post-pr-comment.js";

// Jira tools (Feature 30)
import "./jira-create-issue.js";

// Agent clarification
import "./clarify.js";

// CMS publishing
import "./sanity-publish.js";

// Browser automation (Playwright)
import "./browser.js";

// File browser (list, read, write files within cwd)
import "./file-browser.js";

export { registerTool, getTool, getToolSchemas, executeTool, getRegisteredToolCount, getRegisteredToolNames, topoSortToolCalls, executeBatchIfPossible } from "./registry.js";
