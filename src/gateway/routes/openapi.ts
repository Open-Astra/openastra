// Mount: app.use("/", createOpenApiRouter()); in gateway/index.ts

import { Router, type Request, type Response } from "express";
import { buildOpenApiPaths, getRouteInventory } from "../route-meta.js";

// ── OpenAPI 3.1 Spec ─────────────────────────────────────────────────
// Programmatically built spec covering all public API surface areas.
// js-yaml is not a dependency, so YAML is served as JSON fallback.

// Shared reusable schema fragments
const ErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string", description: "Human-readable error message" },
    details: { type: "object", description: "Structured validation details" },
  },
  required: ["error"],
} as const;

const PaginationParams = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    description: "Maximum number of items to return",
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
    description: "Number of items to skip",
  },
] as const;

const StandardErrors = {
  "400": { description: "Bad Request — invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "401": { description: "Unauthorized — missing or invalid JWT", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "403": { description: "Forbidden — insufficient permissions", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "404": { description: "Not Found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "500": { description: "Internal Server Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
} as const;

function buildSpec(): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "Astra Agent Gateway API",
      version: "0.1.0",
      description:
        "Multi-agent runtime platform API. Supports dynamic agent creation, 92 built-in skills, hierarchical swarm orchestration, and a plug-and-play inference layer.",
      contact: { name: "Astra Platform" },
      license: { name: "Private" },
    },
    servers: [{ url: "/", description: "Astra Gateway" }],

    // ── Security ────────────────────────────────────────────────────
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT access token obtained from POST /auth/login",
        },
        apiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Internal API key set via INTERNAL_API_KEY env var — required for admin and diagnostics endpoints",
        },
      },
      schemas: {
        Error: ErrorSchema,

        // Auth
        RegisterRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8, maxLength: 128 },
            displayName: { type: "string", maxLength: 100 },
          },
        },
        LoginRequest: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                email: { type: "string" },
                displayName: { type: "string" },
              },
            },
            accessToken: { type: "string" },
            refreshToken: { type: "string" },
          },
        },

        // Agent
        AgentModel: {
          type: "object",
          required: ["provider", "modelId", "maxContextTokens", "maxOutputTokens"],
          properties: {
            provider: { type: "string", enum: ["grok", "groq", "openai", "gemini", "claude", "ollama", "vllm"] },
            modelId: { type: "string" },
            endpoint: { type: "string", format: "uri" },
            maxContextTokens: { type: "integer", minimum: 1 },
            maxOutputTokens: { type: "integer", minimum: 1 },
            temperature: { type: "number", minimum: 0, maximum: 2, default: 0.7 },
          },
        },
        AgentConfig: {
          type: "object",
          required: ["id", "displayName", "model", "systemPromptTemplate", "tools"],
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
            tier: { type: "string", enum: ["free", "premium", "internal"] },
            model: { $ref: "#/components/schemas/AgentModel" },
            systemPromptTemplate: { type: "string" },
            tools: {
              type: "object",
              properties: {
                allow: { type: "array", items: { type: "string" } },
                deny: { type: "array", items: { type: "string" } },
              },
            },
            skills: { type: "array", items: { type: "string" } },
          },
        },

        // Chat
        ChatRequest: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", description: "User message text" },
            agentId: { type: "string", description: "Target agent ID (defaults to 'default')" },
            sessionId: { type: "string", description: "Existing session ID to resume" },
            surface: { type: "string", description: "Channel surface (web, telegram, discord, etc.)" },
            surfaceId: { type: "string" },
            stream: { type: "boolean", default: false, description: "Enable SSE streaming response" },
          },
        },
        ChatResponse: {
          type: "object",
          properties: {
            reply: { type: "string" },
            sessionId: { type: "string" },
            agentId: { type: "string" },
            usage: {
              type: "object",
              properties: {
                promptTokens: { type: "integer" },
                completionTokens: { type: "integer" },
                totalTokens: { type: "integer" },
              },
            },
          },
        },

        // Memory
        MemoryEntry: {
          type: "object",
          properties: {
            id: { type: "string" },
            uid: { type: "string" },
            type: { type: "string", enum: ["decision", "outcome", "strategy", "note", "interaction"] },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            createdAt: { type: "string", format: "date-time" },
            score: { type: "number", description: "Relevance score for search results" },
          },
        },

        // Session
        Session: {
          type: "object",
          properties: {
            id: { type: "string" },
            agentId: { type: "string" },
            surface: { type: "string" },
            surfaceId: { type: "string" },
            status: { type: "string", enum: ["active", "idle", "archived"] },
            messageCount: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },

        // Workspace
        Workspace: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            slug: { type: "string" },
            ownerId: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // Job
        Job: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            schedule: { type: "string", description: "Cron expression" },
            agentId: { type: "string" },
            status: { type: "string", enum: ["active", "paused", "failed"] },
            lastRunAt: { type: "string", format: "date-time", nullable: true },
            nextRunAt: { type: "string", format: "date-time", nullable: true },
          },
        },

        // Trace
        Trace: {
          type: "object",
          properties: {
            id: { type: "string" },
            sessionId: { type: "string" },
            agentId: { type: "string" },
            event: { type: "string" },
            payload: { type: "object" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // Skill
        Skill: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            category: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
          },
        },

        // Memory Profile
        MemoryProfile: {
          type: "object",
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            config: { type: "object", description: "Memory profile configuration" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },

        // Queued Job
        QueuedJob: {
          type: "object",
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            type: { type: "string" },
            payload: { type: "object" },
            status: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
            maxRetries: { type: "integer" },
            attempts: { type: "integer" },
            timeoutSeconds: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },

        // Heartbeat Config
        HeartbeatConfig: {
          type: "object",
          properties: {
            id: { type: "string" },
            uid: { type: "string" },
            workspaceId: { type: "string", nullable: true },
            name: { type: "string" },
            agentId: { type: "string" },
            type: { type: "string", enum: ["rss", "http", "github"] },
            url: { type: "string", format: "uri", nullable: true },
            config: { type: "object" },
            intervalMinutes: { type: "integer" },
            prompt: { type: "string", nullable: true },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },

        // Webhook
        Webhook: {
          type: "object",
          properties: {
            id: { type: "string" },
            uid: { type: "string" },
            url: { type: "string", format: "uri" },
            events: { type: "array", items: { type: "string" } },
            description: { type: "string", nullable: true },
            enabled: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },

    // ── Global security (all protected routes require JWT) ──────────
    security: [{ bearerAuth: [] }],

    // ── Paths ───────────────────────────────────────────────────────
    paths: {
      // ── Auth ────────────────────────────────────────────────────
      "/auth/register": {
        post: {
          tags: ["auth"],
          summary: "Register a new user account",
          security: [],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterRequest" } } },
          },
          responses: {
            "201": {
              description: "User registered successfully",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
            },
            "400": StandardErrors["400"],
            "409": { description: "Email already registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "500": StandardErrors["500"],
          },
        },
      },
      "/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Authenticate and obtain access + refresh tokens",
          security: [],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } },
          },
          responses: {
            "200": {
              description: "Authentication successful",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/auth/refresh": {
        post: {
          tags: ["auth"],
          summary: "Rotate refresh token and obtain new access token",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["refreshToken"],
                  properties: { refreshToken: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Token rotated successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      accessToken: { type: "string" },
                      refreshToken: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
          },
        },
      },
      "/auth/logout": {
        post: {
          tags: ["auth"],
          summary: "Revoke all tokens for the current user",
          responses: {
            "200": { description: "Logged out", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
            "401": StandardErrors["401"],
          },
        },
      },

      // ── Chat ────────────────────────────────────────────────────
      "/agent/chat": {
        post: {
          tags: ["chat"],
          summary: "Send a message to an agent (non-streaming)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ChatRequest" } } },
          },
          responses: {
            "200": {
              description: "Agent reply",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ChatResponse" } } },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/agent/chat/stream": {
        post: {
          tags: ["chat"],
          summary: "Send a message to an agent with SSE streaming",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ChatRequest" } } },
          },
          responses: {
            "200": {
              description: "SSE stream of agent reply deltas",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Memory ──────────────────────────────────────────────────
      "/agent/memory": {
        get: {
          tags: ["memory"],
          summary: "Search agent memory (all tiers)",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Semantic search query" },
            { name: "agentId", in: "query", schema: { type: "string" }, description: "Filter by agent ID" },
            { name: "type", in: "query", schema: { type: "string", enum: ["decision", "outcome", "strategy", "note", "interaction"] } },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "Memory search results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      results: { type: "array", items: { $ref: "#/components/schemas/MemoryEntry" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        post: {
          tags: ["memory"],
          summary: "Write a memory entry",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["content", "type"],
                  properties: {
                    content: { type: "string" },
                    type: { type: "string", enum: ["decision", "outcome", "strategy", "note", "interaction"] },
                    agentId: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Memory entry created", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryEntry" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/agent/memory/{id}": {
        delete: {
          tags: ["memory"],
          summary: "Delete a memory entry",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Memory entry deleted" },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Agents ──────────────────────────────────────────────────
      "/agents": {
        get: {
          tags: ["agents"],
          summary: "List all agents in the current workspace",
          parameters: [...PaginationParams],
          responses: {
            "200": {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      agents: { type: "array", items: { $ref: "#/components/schemas/AgentConfig" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        post: {
          tags: ["agents"],
          summary: "Create a new agent",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } },
          },
          responses: {
            "201": { description: "Agent created", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "409": { description: "Agent ID already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "500": StandardErrors["500"],
          },
        },
      },
      "/agents/{id}": {
        get: {
          tags: ["agents"],
          summary: "Get agent by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Agent config", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        patch: {
          tags: ["agents"],
          summary: "Update an agent",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } },
          },
          responses: {
            "200": { description: "Agent updated", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["agents"],
          summary: "Delete an agent",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Agent deleted" },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/agents/{id}/versions": {
        get: {
          tags: ["agents"],
          summary: "List agent configuration versions",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "List of versions",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        version: { type: "integer" },
                        label: { type: "string", nullable: true },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
          },
        },
      },

      // ── Sessions ─────────────────────────────────────────────────
      "/sessions": {
        get: {
          tags: ["sessions"],
          summary: "List sessions for the authenticated user",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["active", "idle", "archived", "all"] } },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "List of sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/sessions/{id}": {
        get: {
          tags: ["sessions"],
          summary: "Get a specific session",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Session details", content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["sessions"],
          summary: "Archive or delete a session",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Session archived" },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/sessions/{id}/messages": {
        get: {
          tags: ["sessions"],
          summary: "List messages in a session",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "Session messages",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      messages: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            role: { type: "string", enum: ["user", "assistant", "tool"] },
                            content: { type: "string" },
                            createdAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Workspaces ───────────────────────────────────────────────
      "/workspaces": {
        get: {
          tags: ["workspaces"],
          summary: "List workspaces the user is a member of",
          parameters: [...PaginationParams],
          responses: {
            "200": {
              description: "List of workspaces",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      workspaces: { type: "array", items: { $ref: "#/components/schemas/Workspace" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        post: {
          tags: ["workspaces"],
          summary: "Create a new workspace",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 64 },
                    slug: { type: "string", maxLength: 64 },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Workspace created", content: { "application/json": { schema: { $ref: "#/components/schemas/Workspace" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "409": { description: "Slug already taken", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "500": StandardErrors["500"],
          },
        },
      },
      "/workspaces/{id}": {
        get: {
          tags: ["workspaces"],
          summary: "Get workspace by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Workspace details", content: { "application/json": { schema: { $ref: "#/components/schemas/Workspace" } } } },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        patch: {
          tags: ["workspaces"],
          summary: "Update workspace",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string", maxLength: 64 } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Workspace updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Workspace" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["workspaces"],
          summary: "Delete workspace",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Workspace deleted" },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/workspaces/{id}/members": {
        get: {
          tags: ["workspaces"],
          summary: "List workspace members",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "List of members",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        userId: { type: "string" },
                        email: { type: "string" },
                        role: { type: "string", enum: ["owner", "editor", "tool_runner", "viewer"] },
                        joinedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        post: {
          tags: ["workspaces"],
          summary: "Invite a user to the workspace",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "role"],
                  properties: {
                    email: { type: "string", format: "email" },
                    role: { type: "string", enum: ["editor", "tool_runner", "viewer"] },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Member added" },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Jobs ─────────────────────────────────────────────────────
      "/jobs": {
        get: {
          tags: ["jobs"],
          summary: "List scheduled jobs",
          parameters: [...PaginationParams],
          responses: {
            "200": {
              description: "List of jobs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        post: {
          tags: ["jobs"],
          summary: "Create a scheduled job",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "schedule", "agentId", "message"],
                  properties: {
                    name: { type: "string", maxLength: 128 },
                    schedule: { type: "string", description: "Cron expression (e.g. '0 9 * * 1-5')" },
                    agentId: { type: "string" },
                    message: { type: "string", description: "Message to send to the agent on each run" },
                    enabled: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Job created", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/jobs/{id}": {
        get: {
          tags: ["jobs"],
          summary: "Get job by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Job details", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        patch: {
          tags: ["jobs"],
          summary: "Update a scheduled job",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    schedule: { type: "string" },
                    enabled: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Job updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["jobs"],
          summary: "Delete a scheduled job",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "Job deleted" },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Traces ───────────────────────────────────────────────────
      "/traces": {
        get: {
          tags: ["traces"],
          summary: "List agent execution traces",
          parameters: [
            { name: "sessionId", in: "query", schema: { type: "string" } },
            { name: "agentId", in: "query", schema: { type: "string" } },
            { name: "event", in: "query", schema: { type: "string" }, description: "Filter by event type" },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "List of traces",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      traces: { type: "array", items: { $ref: "#/components/schemas/Trace" } },
                      total: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/traces/{id}": {
        get: {
          tags: ["traces"],
          summary: "Get a specific trace entry",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Trace entry", content: { "application/json": { schema: { $ref: "#/components/schemas/Trace" } } } },
            "401": StandardErrors["401"],
            "403": StandardErrors["403"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Skills ───────────────────────────────────────────────────
      "/skills": {
        get: {
          tags: ["skills"],
          summary: "List all available skills",
          parameters: [
            { name: "category", in: "query", schema: { type: "string" }, description: "Filter by skill category" },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "List of skills",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      skills: { type: "array", items: { $ref: "#/components/schemas/Skill" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/skills/{id}": {
        get: {
          tags: ["skills"],
          summary: "Get skill by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Skill details", content: { "application/json": { schema: { $ref: "#/components/schemas/Skill" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Memory Profiles ───────────────────────────────────────────
      "/memory-profiles": {
        post: {
          tags: ["memory-profiles"],
          summary: "Create a new memory profile for the workspace",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 128 },
                    description: { type: "string", maxLength: 500, nullable: true },
                    config: { type: "object", description: "Memory profile configuration options" },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Memory profile created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryProfile" } } },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        get: {
          tags: ["memory-profiles"],
          summary: "List all memory profiles for the workspace",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of memory profiles",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      profiles: { type: "array", items: { $ref: "#/components/schemas/MemoryProfile" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/memory-profiles/{id}": {
        get: {
          tags: ["memory-profiles"],
          summary: "Get a single memory profile by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Memory profile", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryProfile" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        put: {
          tags: ["memory-profiles"],
          summary: "Update a memory profile",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 128 },
                    description: { type: "string", maxLength: 500, nullable: true },
                    config: { type: "object", description: "Memory profile configuration options" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Memory profile updated", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryProfile" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["memory-profiles"],
          summary: "Delete a memory profile",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Memory profile deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } } } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/memory-profiles/agents/{agentId}/memory-profile": {
        put: {
          tags: ["memory-profiles"],
          summary: "Assign a memory profile to an agent",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["profileId"],
                  properties: { profileId: { type: "string", minLength: 1 } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Profile assigned",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { agentId: { type: "string" }, profileId: { type: "string" } } },
                },
              },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        get: {
          tags: ["memory-profiles"],
          summary: "Get the memory profile currently assigned to an agent",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "agentId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Assigned memory profile", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryProfile" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Jobs (queue) ──────────────────────────────────────────────
      "/jobs/queue": {
        post: {
          tags: ["jobs"],
          summary: "Enqueue a new background job",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: { type: "string", minLength: 1, maxLength: 128, description: "Job type identifier" },
                    payload: { type: "object", description: "Arbitrary key-value payload passed to the job handler" },
                    maxRetries: { type: "integer", minimum: 0, maximum: 10 },
                    timeoutSeconds: { type: "integer", minimum: 10, maximum: 86400 },
                  },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Job accepted and queued",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
                },
              },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        get: {
          tags: ["jobs"],
          summary: "List background jobs for the workspace",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["pending", "running", "completed", "failed", "cancelled"] },
              description: "Filter by job status",
            },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
          ],
          responses: {
            "200": {
              description: "List of background jobs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jobs: { type: "array", items: { $ref: "#/components/schemas/QueuedJob" } },
                    },
                  },
                },
              },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/jobs/queue/{id}": {
        get: {
          tags: ["jobs"],
          summary: "Get a queued job by ID",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Job details",
              content: { "application/json": { schema: { type: "object", properties: { job: { $ref: "#/components/schemas/QueuedJob" } } } } },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["jobs"],
          summary: "Cancel a pending job",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Job cancelled", content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Heartbeat ─────────────────────────────────────────────────
      "/heartbeat": {
        post: {
          tags: ["heartbeat"],
          summary: "Create a new heartbeat monitor config",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "type"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 200 },
                    agentId: { type: "string", default: "default" },
                    type: { type: "string", enum: ["rss", "http", "github"] },
                    url: { type: "string", format: "uri" },
                    config: { type: "object", description: "Extra provider-specific config" },
                    intervalMinutes: { type: "integer", minimum: 5, maximum: 10080, default: 30 },
                    prompt: { type: "string", maxLength: 2000 },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Heartbeat config created",
              content: { "application/json": { schema: { type: "object", properties: { config: { $ref: "#/components/schemas/HeartbeatConfig" } } } } },
            },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        get: {
          tags: ["heartbeat"],
          summary: "List heartbeat monitor configs with their last run status",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of heartbeat configs",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      configs: { type: "array", items: { $ref: "#/components/schemas/HeartbeatConfig" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/heartbeat/{id}": {
        patch: {
          tags: ["heartbeat"],
          summary: "Enable or disable a heartbeat monitor",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["enabled"],
                  properties: { enabled: { type: "boolean" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Heartbeat config updated", content: { "application/json": { schema: { type: "object", properties: { config: { $ref: "#/components/schemas/HeartbeatConfig" } } } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["heartbeat"],
          summary: "Delete a heartbeat monitor config",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Heartbeat config deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } } } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/heartbeat/{id}/runs": {
        get: {
          tags: ["heartbeat"],
          summary: "List run history for a heartbeat monitor",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            ...PaginationParams,
          ],
          responses: {
            "200": {
              description: "Paginated run history",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      runs: { type: "array", items: { type: "object" } },
                      limit: { type: "integer" },
                      offset: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Webhooks ──────────────────────────────────────────────────
      "/webhooks": {
        post: {
          tags: ["webhooks"],
          summary: "Register a new webhook endpoint",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url", "events"],
                  properties: {
                    url: { type: "string", format: "uri", description: "Destination URL to receive webhook payloads" },
                    events: { type: "array", items: { type: "string" }, description: "Event types to subscribe to" },
                    description: { type: "string", description: "Optional human-readable label" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Webhook registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } },
            "400": StandardErrors["400"],
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
        get: {
          tags: ["webhooks"],
          summary: "List all registered webhooks (secret fields omitted)",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "List of webhooks",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      webhooks: { type: "array", items: { $ref: "#/components/schemas/Webhook" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/webhooks/{id}": {
        get: {
          tags: ["webhooks"],
          summary: "Get a single webhook by ID (secret field omitted)",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Webhook details", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
        delete: {
          tags: ["webhooks"],
          summary: "Delete a webhook",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Webhook deleted", content: { "application/json": { schema: { type: "object", properties: { deleted: { type: "boolean" } } } } } },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/webhooks/{id}/deliveries": {
        get: {
          tags: ["webhooks"],
          summary: "List recent delivery attempts for a webhook",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Delivery history",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      deliveries: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/webhooks/{id}/test": {
        post: {
          tags: ["webhooks"],
          summary: "Send a test event payload to a registered webhook",
          security: [{ bearerAuth: [] }],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Test delivery result",
              content: { "application/json": { schema: { type: "object", properties: { delivery: { type: "object" } } } } },
            },
            "401": StandardErrors["401"],
            "404": StandardErrors["404"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Admin ─────────────────────────────────────────────────────
      "/admin/health": {
        get: {
          tags: ["admin"],
          summary: "Extended health check with memory, uptime, session, and tool counts",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Health status",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      timestamp: { type: "string", format: "date-time" },
                      uptimeSeconds: { type: "integer" },
                      memory: {
                        type: "object",
                        properties: {
                          rssBytes: { type: "integer" },
                          heapUsedBytes: { type: "integer" },
                          heapTotalBytes: { type: "integer" },
                          externalBytes: { type: "integer" },
                        },
                      },
                      activeSessionCountEstimate: { type: "integer", nullable: true },
                      registeredToolCount: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/admin/agents": {
        get: {
          tags: ["admin"],
          summary: "List all registered agent configs (internal view)",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "All registered agents",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      agents: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/admin/usage/{uid}": {
        get: {
          tags: ["admin"],
          summary: "Token usage summary for a specific user in the current billing period",
          security: [{ apiKeyAuth: [] }],
          parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" }, description: "User ID" }],
          responses: {
            "200": {
              description: "Usage data",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      uid: { type: "string" },
                      period: { type: "string", description: "Billing period (YYYY-MM)" },
                      usage: { type: "object", nullable: true },
                      message: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/admin/sessions/{uid}": {
        get: {
          tags: ["admin"],
          summary: "List active sessions for a specific user",
          security: [{ apiKeyAuth: [] }],
          parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" }, description: "User ID" }],
          responses: {
            "200": {
              description: "Active sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      uid: { type: "string" },
                      count: { type: "integer" },
                      sessions: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/admin/audit/{uid}": {
        get: {
          tags: ["admin"],
          summary: "Recent audit log entries for a specific user (last 50)",
          security: [{ apiKeyAuth: [] }],
          parameters: [{ name: "uid", in: "path", required: true, schema: { type: "string" }, description: "User ID" }],
          responses: {
            "200": {
              description: "Audit log entries",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      uid: { type: "string" },
                      count: { type: "integer" },
                      entries: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Diagnostics ───────────────────────────────────────────────
      "/diagnostics": {
        get: {
          tags: ["diagnostics"],
          summary: "Run a full diagnostic check across all services",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Diagnostic result (healthy or degraded)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      overallStatus: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
                      timestamp: { type: "string", format: "date-time" },
                      checks: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "503": { description: "Service unhealthy", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "500": StandardErrors["500"],
          },
        },
      },
      "/diagnostics/quick": {
        get: {
          tags: ["diagnostics"],
          summary: "Run connectivity checks only (faster than full diagnostics)",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Connectivity check result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      overallStatus: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
                      timestamp: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "503": { description: "Service unhealthy", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "500": StandardErrors["500"],
          },
        },
      },
      "/diagnostics/history": {
        get: {
          tags: ["diagnostics"],
          summary: "Retrieve the last 10 diagnostic run results from the database",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Diagnostic run history",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      runs: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/diagnostics/circuit-breakers": {
        get: {
          tags: ["diagnostics"],
          summary: "Return current state of all per-provider circuit breakers",
          security: [{ apiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Circuit breaker states",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      providers: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            provider: { type: "string" },
                            state: { type: "string", enum: ["closed", "open", "half-open"] },
                            totalRequests: { type: "integer" },
                            totalSuccesses: { type: "integer" },
                            errorRate: { type: "string", description: "Error rate as percentage string" },
                            lastFailureAt: { type: "string", format: "date-time", nullable: true },
                          },
                        },
                      },
                      timestamp: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },

      // ── Costs ─────────────────────────────────────────────────────
      "/costs": {
        get: {
          tags: ["costs"],
          summary: "Workspace cost summary for the last N months (default 3)",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "months", in: "query", schema: { type: "integer", minimum: 1, default: 3 }, description: "Number of months to include" },
          ],
          responses: {
            "200": {
              description: "Cost summary",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
      "/costs/breakdown": {
        get: {
          tags: ["costs"],
          summary: "Detailed cost breakdown with optional date range filter",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "months", in: "query", schema: { type: "integer", minimum: 1, default: 3 } },
            { name: "startDate", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive start date (YYYY-MM-DD)" },
            { name: "endDate", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive end date (YYYY-MM-DD)" },
          ],
          responses: {
            "200": {
              description: "Detailed cost breakdown with metadata",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      meta: {
                        type: "object",
                        properties: {
                          workspaceId: { type: "string", nullable: true },
                          months: { type: "integer" },
                          startDate: { type: "string", nullable: true },
                          endDate: { type: "string", nullable: true },
                          generatedAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": StandardErrors["401"],
            "500": StandardErrors["500"],
          },
        },
      },
    },

    // ── Tags ─────────────────────────────────────────────────────────
    tags: [
      { name: "auth", description: "Authentication — register, login, token rotation, logout" },
      { name: "chat", description: "Agent chat — send messages and receive replies (streaming + non-streaming)" },
      { name: "memory", description: "Agent memory — search and write across all 5 memory tiers" },
      { name: "agents", description: "Agent management — CRUD for agent configurations and versions" },
      { name: "sessions", description: "Session management — browse conversation history" },
      { name: "workspaces", description: "Workspace management — teams, members, secrets" },
      { name: "jobs", description: "Scheduled jobs — cron-based agent automation and background job queue" },
      { name: "traces", description: "Execution traces — detailed per-turn token, timing, and tool call records" },
      { name: "skills", description: "Skills — discover and inspect built-in skill bundles" },
      { name: "memory-profiles", description: "Memory profiles — named memory configuration sets assignable to agents" },
      { name: "heartbeat", description: "Heartbeat monitors — RSS, HTTP, and GitHub change watchers with agent summaries" },
      { name: "webhooks", description: "Webhooks — register and manage outbound event delivery endpoints" },
      { name: "admin", description: "Admin — internal API key-protected health, usage, session, and audit endpoints" },
      { name: "diagnostics", description: "Diagnostics — full and quick service health checks, history, and circuit breaker states" },
      { name: "costs", description: "Costs — workspace inference cost summary and detailed breakdown" },
    ],
  };
}

function buildMergedSpec(): Record<string, unknown> {
  const spec = buildSpec() as Record<string, unknown>;
  const existingPaths = (spec.paths ?? {}) as Record<string, unknown>;
  spec.paths = buildOpenApiPaths(existingPaths);

  return spec;
}

// ── Router Factory ───────────────────────────────────────────────────

export function createOpenApiRouter(): Router {
  const router = Router();

  // Lazily build merged spec on first request (allows time for route registrations at startup)
  let cachedSpec: Record<string, unknown> | null = null;

  function getSpec(): Record<string, unknown> {
    if (!cachedSpec) {
      cachedSpec = buildMergedSpec();
    }
    return cachedSpec;
  }

  // GET /openapi.json
  router.get("/openapi.json", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(getSpec());
  });

  // GET /openapi.yaml — js-yaml is not a dependency; serve as JSON with yaml content-type fallback
  router.get("/openapi.yaml", (_req: Request, res: Response) => {
    const spec = getSpec();
    // Use a dynamic specifier computed at runtime so TypeScript does not attempt
    // to resolve the module at compile time (js-yaml is an optional peer dep).
    const pkg = "js-yaml";
    const tryYaml = new Function("m", "return import(m)")(pkg) as Promise<unknown>;
    tryYaml
      .then((yaml) => {
        const yamlStr = (yaml as { dump: (obj: unknown) => string }).dump(spec);
        res.setHeader("Content-Type", "application/yaml");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.send(yamlStr);
      })
      .catch(() => {
        // js-yaml not available — fall back to JSON with a note header
        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-Fallback", "js-yaml not installed; serving JSON");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.json(spec);
      });
  });

  // GET /openapi/routes — runtime route inventory for SDK discovery
  router.get("/openapi/routes", (_req: Request, res: Response) => {
    const routes = getRouteInventory();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      count: routes.length,
      routes,
    });
  });

  return router;
}
