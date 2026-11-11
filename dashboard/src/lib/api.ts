import type {
  Agent,
  Swarm,
  Session,
  Message,
  MemoryEntry,
  MemoryProfile,
  DashboardStats,
  InferenceProvider,
  Channel,
  HealthResponse,
  ScheduledTask,
  SystemMetrics,
  SkillGraph,
  SkillGraphValidation,
  ApprovalRequest,
  PipelineRunResult,
  PromptVersion,
  AnomalyAlert,
} from "@/types/api";

// Base URL of the gateway REST API.
//
// The gateway mounts its routes at the root (/auth, /agents, /sessions, …) —
// there is no "/api" prefix on the server. The default "/api" is a
// same-origin prefix that your reverse proxy (or the Vite dev proxy, see
// vite.config.ts) must strip before forwarding to the gateway. To call the
// gateway directly, set VITE_API_URL to its origin, e.g. https://astra.example.com
export const API_BASE = (import.meta.env.VITE_API_URL ?? "/api").replace(/\/+$/, "");

const TOKEN_KEY = "astra_token";
const USER_KEY = "astra_user";
const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "X-CSRF-Token";

function readCookie(name: string): string | undefined {
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

// The gateway uses double-submit-cookie CSRF protection for state-changing
// requests that carry no Bearer token (i.e. login). A safe GET makes it issue
// the cookie; we then echo it in the X-CSRF-Token header.
async function csrfToken(): Promise<string | undefined> {
  let token = readCookie(CSRF_COOKIE);
  if (!token) {
    await fetch(`${API_BASE}/health`, { credentials: "include" }).catch(() => undefined);
    token = readCookie(CSRF_COOKIE);
  }
  return token;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (!token && method !== "GET" && method !== "HEAD") {
    const csrf = await csrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (res.status === 401 && path !== "/auth/login") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error");
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

// Auth
export const auth = {
  login: (credentials: { email: string; password: string }) =>
    request<{
      user: { id: string; email: string; displayName?: string | null };
      accessToken: string;
      refreshToken: string;
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials),
    }),
  // The gateway has no /auth/verify route. A stored token is checked by
  // calling a cheap authenticated endpoint: it resolves when the gateway
  // accepts the token and rejects (401 → ApiError) when it does not.
  checkSession: () => request<unknown>("/agents").then(() => undefined),
};

export { ApiError };

// Dashboard
export const dashboard = {
  stats: () => request<DashboardStats>("/dashboard/stats"),
  health: () => request<HealthResponse>("/health"),
  metrics: () => request<SystemMetrics>("/metrics"),
};

// Agents
export const agents = {
  list: () => request<Agent[]>("/agents"),
  get: (id: string) => request<Agent>(`/agents/${id}`),
  create: (data: Partial<Agent>) =>
    request<Agent>("/agents", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Agent>) =>
    request<Agent>(`/agents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<void>(`/agents/${id}`, { method: "DELETE" }),
};

// Swarms
export const swarms = {
  list: () => request<Swarm[]>("/swarms"),
  get: (id: string) => request<Swarm>(`/swarms/${id}`),
};

// Sessions
export const sessions = {
  list: (params?: { status?: string; agentId?: string; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.agentId) searchParams.set("agentId", params.agentId);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return request<Session[]>(`/sessions${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => request<Session>(`/sessions/${id}`),
  messages: (id: string) => request<Message[]>(`/sessions/${id}/messages`),
};

// Chat
export const chat = {
  send: (agentId: string, message: string) =>
    request<Message>("/chat", {
      method: "POST",
      body: JSON.stringify({ agentId, message }),
    }),
  sendStream: async function* (agentId: string, message: string) {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(`${API_BASE}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ agentId, message }),
    });

    if (!res.ok || !res.body) throw new ApiError(res.status, "Stream failed");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as { type: string; content?: string; toolCall?: ToolCallDelta };
          } catch {
            // skip malformed lines
          }
        }
      }
    }
  },
};

interface ToolCallDelta {
  id: string;
  name: string;
  arguments: string;
}

// Memory
export const memory = {
  list: (params: { agentId?: string; tier?: string; query?: string }) => {
    const searchParams = new URLSearchParams();
    if (params.agentId) searchParams.set("agentId", params.agentId);
    if (params.tier) searchParams.set("tier", params.tier);
    if (params.query) searchParams.set("q", params.query);
    return request<MemoryEntry[]>(`/memory?${searchParams.toString()}`);
  },
  search: (query: string) =>
    request<MemoryEntry[]>(`/memory-search?q=${encodeURIComponent(query)}`),
  profile: (agentId: string) =>
    request<MemoryProfile>(`/memory-profiles/${agentId}`),
};

// Inference Providers
export const providers = {
  list: () => request<InferenceProvider[]>("/providers"),
  status: (id: string) => request<InferenceProvider>(`/providers/${id}/status`),
};

// Channels
export const channels = {
  list: () => request<Channel[]>("/channels"),
};

// Skills
export const skills = {
  list: () => request<{ skillCount: number; toolCount: number; skills: Array<{ id: string; name: string; description: string; category: string; version: string; tools: string[]; configFields?: unknown[] }> }>("/skills"),
  graph: () => request<SkillGraph>("/skills/graph"),
  graphValidation: () => request<SkillGraphValidation>("/skills/graph/validate"),
};

// Approvals
export const approvals = {
  list: (status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    return request<{ approvals: ApprovalRequest[] }>(`/approvals${qs}`);
  },
  approve: (id: string) =>
    request<{ message: string }>(`/approvals/${id}/approve`, { method: "POST" }),
  reject: (id: string) =>
    request<{ message: string }>(`/approvals/${id}/reject`, { method: "POST" }),
};

// Pipelines
export const pipelines = {
  run: (input: string, stages: Array<{ agentId: string; systemPromptSuffix?: string }>) =>
    request<{ pipeline: PipelineRunResult }>("/pipelines/run", {
      method: "POST",
      body: JSON.stringify({ input, stages }),
    }),
};

// Prompt versions
export const promptVersions = {
  list: (agentId: string) =>
    request<{ versions: PromptVersion[] }>(`/agents/${agentId}/prompt-versions`),
  create: (agentId: string, body: { systemPrompt: string; label?: string }) =>
    request<PromptVersion>(`/agents/${agentId}/prompt-versions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  get: (agentId: string, version: number) =>
    request<PromptVersion>(`/agents/${agentId}/prompt-versions/${version}`),
  restore: (agentId: string, version: number) =>
    request<{ restored: true; version: number }>(`/agents/${agentId}/prompt-versions/${version}/restore`, {
      method: "POST",
    }),
};

// Alerts
export const alerts = {
  list: (limit?: number) => {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return request<{ alerts: AnomalyAlert[] }>(`/tool-analytics/anomalies${qs}`);
  },
};

// Scheduled Tasks
export const scheduledTasks = {
  list: () => request<{ tasks: ScheduledTask[] }>("/scheduled-tasks").then((r) => r.tasks),
  create: (data: {
    agentId: string;
    prompt: string;
    cronExpression?: string;
    runAt?: string;
    maxRuns?: number;
  }) =>
    request<ScheduledTask>("/scheduled-tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<{ deleted: boolean }>(`/scheduled-tasks/${id}`, { method: "DELETE" }),
  run: (id: string) =>
    request<{ content: string; sessionId: string }>(`/scheduled-tasks/${id}/run`, {
      method: "POST",
    }),
};

export const api = {
  auth,
  dashboard,
  agents,
  swarms,
  sessions,
  chat,
  memory,
  scheduledTasks,
  providers,
  channels,
  skills,
  approvals,
  pipelines,
  promptVersions,
  alerts,
};
