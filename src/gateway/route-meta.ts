// ── Route Metadata Registry ─────────────────────────────────────────
// Central registry for OpenAPI generation, route inventory export, and
// lightweight SDK discovery. The gateway can register mounted routers
// once, and the spec builder derives method/path coverage from the
// Express router stacks without per-handler annotations.

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type RouteAuth = "jwt" | "apiKey" | "none";
export type RouteStability = "stable" | "beta" | "experimental";

export interface RouteMeta {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  requestBody?: unknown;
  responseBody?: unknown;
  auth?: RouteAuth;
  stability?: RouteStability;
  feature?: string;
  operationId?: string;
}

export interface MountedRouterMeta {
  basePath: string;
  router: RouterLike;
}

export interface RouteDescriptor {
  method: HttpMethod;
  path: string;
  summary: string;
  tags: string[];
  auth: RouteAuth;
  stability: RouteStability;
  feature: string;
  operationId: string;
  requestBody?: unknown;
  responseBody?: unknown;
  source: "mounted" | "registered";
}

interface RouterLike {
  stack?: unknown[];
}

interface RouteLayerLike {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
  };
  handle?: unknown;
}

const routeRegistry: RouteMeta[] = [];
const mountedRouters: MountedRouterMeta[] = [];

const ROUTE_RULES: Array<{
  prefix: string;
  tags: string[];
  auth: RouteAuth;
  stability: RouteStability;
  feature: string;
}> = [
  { prefix: "/openapi", tags: ["openapi"], auth: "none", stability: "stable", feature: "spec-discovery" },
  { prefix: "/auth", tags: ["auth"], auth: "none", stability: "stable", feature: "authentication" },
  { prefix: "/health", tags: ["health"], auth: "none", stability: "stable", feature: "health-checks" },
  { prefix: "/readiness", tags: ["health"], auth: "none", stability: "stable", feature: "health-checks" },
  { prefix: "/metrics", tags: ["metrics"], auth: "jwt", stability: "stable", feature: "metrics" },
  { prefix: "/dashboard", tags: ["metrics"], auth: "jwt", stability: "beta", feature: "dashboard-sse" },
  { prefix: "/agent", tags: ["chat", "memory"], auth: "jwt", stability: "stable", feature: "agent-runtime" },
  { prefix: "/agents", tags: ["agents"], auth: "jwt", stability: "stable", feature: "agent-management" },
  { prefix: "/sessions", tags: ["sessions"], auth: "jwt", stability: "stable", feature: "session-history" },
  { prefix: "/workspaces", tags: ["workspaces"], auth: "jwt", stability: "stable", feature: "workspace-management" },
  { prefix: "/skills", tags: ["skills"], auth: "jwt", stability: "stable", feature: "skill-catalog" },
  { prefix: "/costs", tags: ["costs"], auth: "jwt", stability: "stable", feature: "cost-dashboard" },
  { prefix: "/heartbeat", tags: ["heartbeat"], auth: "jwt", stability: "stable", feature: "heartbeat-monitoring" },
  { prefix: "/traces", tags: ["traces"], auth: "jwt", stability: "stable", feature: "trace-exploration" },
  { prefix: "/jobs", tags: ["jobs"], auth: "jwt", stability: "stable", feature: "job-queue" },
  { prefix: "/memory-profiles", tags: ["memory-profiles"], auth: "jwt", stability: "stable", feature: "memory-profiles" },
  { prefix: "/webhooks", tags: ["webhooks"], auth: "jwt", stability: "beta", feature: "webhook-management" },
  { prefix: "/linear-mappings", tags: ["integrations"], auth: "jwt", stability: "stable", feature: "linear-routing" },
  { prefix: "/admin", tags: ["admin"], auth: "apiKey", stability: "stable", feature: "admin-monitoring" },
  { prefix: "/diagnostics", tags: ["diagnostics"], auth: "apiKey", stability: "stable", feature: "diagnostics" },
  { prefix: "/autonomous", tags: ["autonomous"], auth: "jwt", stability: "experimental", feature: "autonomous-agents" },
  { prefix: "/debates", tags: ["debates"], auth: "jwt", stability: "beta", feature: "debate-protocols" },
  { prefix: "/goals", tags: ["goals"], auth: "jwt", stability: "beta", feature: "goals" },
  { prefix: "/spawn-tree", tags: ["spawn-tree"], auth: "jwt", stability: "beta", feature: "spawn-tree" },
  { prefix: "/tools", tags: ["tools"], auth: "jwt", stability: "beta", feature: "tool-graph" },
  { prefix: "/prompt-swap", tags: ["prompts"], auth: "jwt", stability: "beta", feature: "prompt-swap" },
  { prefix: "/cost-attribution", tags: ["costs"], auth: "jwt", stability: "beta", feature: "cost-attribution" },
  { prefix: "/skill-marketplace", tags: ["skills"], auth: "jwt", stability: "beta", feature: "skill-marketplace" },
  { prefix: "/approvals", tags: ["approvals"], auth: "jwt", stability: "beta", feature: "human-in-the-loop" },
  { prefix: "/rooms", tags: ["collaboration"], auth: "jwt", stability: "beta", feature: "rooms" },
  { prefix: "/kb-sync", tags: ["memory"], auth: "jwt", stability: "beta", feature: "knowledge-sync" },
  { prefix: "/memory/", tags: ["memory"], auth: "jwt", stability: "beta", feature: "memory-management" },
  { prefix: "/trace-spans", tags: ["observability"], auth: "jwt", stability: "beta", feature: "trace-spans" },
  { prefix: "/tool-analytics", tags: ["observability"], auth: "jwt", stability: "beta", feature: "tool-analytics" },
  { prefix: "/slos", tags: ["observability"], auth: "jwt", stability: "beta", feature: "slos" },
  { prefix: "/budget-forecast", tags: ["observability"], auth: "jwt", stability: "beta", feature: "budget-forecast" },
  { prefix: "/data-policies", tags: ["security"], auth: "jwt", stability: "beta", feature: "data-policies" },
  { prefix: "/audit-log", tags: ["security"], auth: "jwt", stability: "beta", feature: "audit-export" },
  { prefix: "/permission-requests", tags: ["security"], auth: "jwt", stability: "beta", feature: "permission-requests" },
  { prefix: "/security/watermark", tags: ["security"], auth: "none", stability: "stable", feature: "watermark" },
  { prefix: "/workspaces", tags: ["workspaces"], auth: "jwt", stability: "stable", feature: "workspace-management" },
  { prefix: "/ab-tests", tags: ["experiments"], auth: "jwt", stability: "experimental", feature: "ab-testing" },
  { prefix: "/planner", tags: ["experiments"], auth: "jwt", stability: "experimental", feature: "planning" },
  { prefix: "/param-sweeps", tags: ["experiments"], auth: "jwt", stability: "experimental", feature: "parameter-sweeps" },
  { prefix: "/otel-config", tags: ["observability"], auth: "jwt", stability: "beta", feature: "otel-config" },
  { prefix: "/prompt-templates", tags: ["prompts"], auth: "jwt", stability: "beta", feature: "prompt-templates" },
  { prefix: "/playground", tags: ["developer-experience"], auth: "jwt", stability: "beta", feature: "playground" },
  { prefix: "/agent-profiles", tags: ["agents"], auth: "jwt", stability: "beta", feature: "agent-profiles" },
  { prefix: "/webhook-inspector", tags: ["webhooks"], auth: "jwt", stability: "beta", feature: "webhook-inspector" },
  { prefix: "/workflows", tags: ["workflow"], auth: "jwt", stability: "beta", feature: "workflows" },
  { prefix: "/pipelines", tags: ["workflow"], auth: "jwt", stability: "beta", feature: "pipelines" },
  { prefix: "/tournaments", tags: ["experiments"], auth: "jwt", stability: "experimental", feature: "tournaments" },
  { prefix: "/memory/graph-viz", tags: ["memory"], auth: "jwt", stability: "beta", feature: "graph-visualization" },
  { prefix: "/memory/snapshots", tags: ["memory"], auth: "jwt", stability: "beta", feature: "snapshots" },
  { prefix: "/memory/knowledge-merge", tags: ["memory"], auth: "jwt", stability: "beta", feature: "knowledge-merge" },
  { prefix: "/memory/search", tags: ["memory"], auth: "jwt", stability: "beta", feature: "memory-search" },
  { prefix: "/zapier", tags: ["integrations"], auth: "jwt", stability: "beta", feature: "zapier" },
  { prefix: "/jira", tags: ["integrations"], auth: "none", stability: "beta", feature: "jira" },
  { prefix: "/security/ip-allowlist", tags: ["security"], auth: "jwt", stability: "beta", feature: "ip-allowlist" },
  { prefix: "/security/session-replay", tags: ["security"], auth: "jwt", stability: "beta", feature: "session-replay-audit" },
  { prefix: "/security/dp-budget", tags: ["security"], auth: "jwt", stability: "beta", feature: "dp-budget" },
  { prefix: "/security/consent", tags: ["security"], auth: "jwt", stability: "beta", feature: "consent" },
  { prefix: "/budget", tags: ["planning"], auth: "jwt", stability: "beta", feature: "budget" },
  { prefix: "/sla", tags: ["planning"], auth: "jwt", stability: "beta", feature: "sla" },
  { prefix: "/approval-workflows", tags: ["approvals"], auth: "jwt", stability: "beta", feature: "approval-workflows" },
  { prefix: "/approval-requests", tags: ["approvals"], auth: "jwt", stability: "beta", feature: "approval-requests" },
  { prefix: "/presence", tags: ["collaboration"], auth: "jwt", stability: "beta", feature: "presence" },
  { prefix: "/agent-messages", tags: ["collaboration"], auth: "jwt", stability: "beta", feature: "agent-messages" },
  { prefix: "/activity-feed", tags: ["collaboration"], auth: "jwt", stability: "beta", feature: "activity-feed" },
  { prefix: "/queue-status", tags: ["ops"], auth: "jwt", stability: "beta", feature: "queue-status" },
  { prefix: "/tenant-routing", tags: ["ops"], auth: "jwt", stability: "beta", feature: "tenant-routing" },
  { prefix: "/api-versions", tags: ["ops"], auth: "jwt", stability: "beta", feature: "api-versions" },
  { prefix: "/standups", tags: ["team"], auth: "jwt", stability: "beta", feature: "standups" },
  { prefix: "/mentoring", tags: ["team"], auth: "jwt", stability: "beta", feature: "mentoring" },
  { prefix: "/capacity-plan", tags: ["team"], auth: "jwt", stability: "beta", feature: "capacity-planning" },
  { prefix: "/consensus", tags: ["team"], auth: "jwt", stability: "beta", feature: "consensus" },
  { prefix: "/dependency-graph", tags: ["team"], auth: "jwt", stability: "beta", feature: "dependency-graph" },
  { prefix: "/team-channels", tags: ["team"], auth: "jwt", stability: "beta", feature: "team-channels" },
  { prefix: "/pair-sessions", tags: ["team"], auth: "jwt", stability: "beta", feature: "pair-sessions" },
  { prefix: "/team-kb", tags: ["team"], auth: "jwt", stability: "beta", feature: "team-kb" },
  { prefix: "/escalation-chains", tags: ["team"], auth: "jwt", stability: "beta", feature: "escalation-chains" },
  { prefix: "/work-queues", tags: ["team"], auth: "jwt", stability: "beta", feature: "work-queues" },
  { prefix: "/team-health", tags: ["team"], auth: "jwt", stability: "beta", feature: "team-health" },
  { prefix: "/onboarding-protocol", tags: ["team"], auth: "jwt", stability: "experimental", feature: "onboarding-protocol" },
  { prefix: "/liaisons", tags: ["team"], auth: "jwt", stability: "experimental", feature: "liaisons" },
  { prefix: "/agent-availability", tags: ["team"], auth: "jwt", stability: "experimental", feature: "agent-availability" },
  { prefix: "/team-optimizer", tags: ["team"], auth: "jwt", stability: "experimental", feature: "team-optimizer" },
];

export function registerRoute(meta: RouteMeta): void {
  routeRegistry.push(meta);
}

export function registerMountedRouter(basePath: string, router: unknown): void {
  if (!isRouterLike(router)) return;
  mountedRouters.push({
    basePath: normalizePath(basePath),
    router,
  });
}

export function getRegisteredRoutes(): RouteMeta[] {
  return [...routeRegistry];
}

export function getRegisteredMountedRouters(): MountedRouterMeta[] {
  return [...mountedRouters];
}

export function resetRouteRegistryForTests(): void {
  routeRegistry.length = 0;
  mountedRouters.length = 0;
}

export function getRouteInventory(): RouteDescriptor[] {
  return [...buildRouteIndex().values()].sort((a, b) => {
    if (a.path === b.path) return a.method.localeCompare(b.method);
    return a.path.localeCompare(b.path);
  });
}

export function getRouteDescriptor(path: string, method: HttpMethod): RouteDescriptor {
  const normalizedPath = normalizePath(path);
  const key = inventoryKey(method, normalizedPath);
  const match = buildRouteIndex().get(key);
  return match ?? createRouteDescriptor(method, normalizedPath);
}

export function decorateOpenApiPathItem(
  pathKey: string,
  pathItem: Record<string, unknown>,
  routeIndex = buildRouteIndex(),
): Record<string, unknown> {
  const decorated = { ...pathItem };

  for (const [method, value] of Object.entries(pathItem)) {
    if (!isHttpMethod(method) || !isPlainObject(value)) continue;

    const descriptor = routeIndex.get(inventoryKey(method, pathKey)) ?? getRouteDescriptor(pathKey, method);
    decorated[method] = decorateOpenApiOperation(descriptor, value);
  }

  return decorated;
}

function buildRouteIndex(): Map<string, RouteDescriptor> {
  const inventory = new Map<string, RouteDescriptor>();

  for (const mounted of mountedRouters) {
    for (const descriptor of collectMountedRoutes(mounted.basePath, mounted.router)) {
      inventory.set(inventoryKey(descriptor.method, descriptor.path), descriptor);
    }
  }

  for (const meta of routeRegistry) {
    const descriptor = routeMetaToDescriptor(meta);
    const key = inventoryKey(descriptor.method, descriptor.path);
    const existing = inventory.get(key);
    inventory.set(
      key,
      existing
        ? { ...existing, ...descriptor, source: "registered" }
      : descriptor,
    );
  }

  return inventory;
}

export function buildOpenApiPaths(
  existingPaths: Record<string, unknown>,
): Record<string, unknown> {
  const routeIndex = buildRouteIndex();
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [path, operations] of Object.entries(existingPaths)) {
    if (!isPlainObject(operations)) {
      paths[path] = {};
      continue;
    }
    paths[path] = decorateOpenApiPathItem(
      path,
      operations as Record<string, unknown>,
      routeIndex,
    );
  }

  for (const descriptor of routeIndex.values()) {
    const method = descriptor.method.toLowerCase();
    const existing = paths[descriptor.path];
    if (existing?.[method]) continue;

    const operation = decorateOpenApiOperation(descriptor, buildOperationSkeleton(descriptor));

    if (!paths[descriptor.path]) paths[descriptor.path] = {};
    paths[descriptor.path][method] = operation;
  }

  return paths;
}

// ── Mounted Router Discovery ────────────────────────────────────────

function collectMountedRoutes(basePath: string, router: RouterLike): RouteDescriptor[] {
  const stack = router.stack ?? [];
  const routes: RouteDescriptor[] = [];

  for (const layer of stack) {
    if (!isRouteLayer(layer)) {
      const nestedRouter = getNestedRouter(layer);
      if (nestedRouter) {
        routes.push(...collectMountedRoutes(basePath, nestedRouter));
      }
      continue;
    }

    const routePathValues = normalizeRoutePaths(layer.route?.path);
    for (const routePath of routePathValues) {
      const fullPath = joinPaths(basePath, routePath);
      const methods = layer.route?.methods ?? {};
      for (const methodName of Object.keys(methods)) {
        const method = toHttpMethod(methodName);
        if (!method || !methods[methodName]) continue;
        routes.push(createRouteDescriptor(method, fullPath, "mounted"));
      }
    }
  }

  return routes;
}

function createRouteDescriptor(
  method: HttpMethod,
  path: string,
  source: "mounted" | "registered" = "mounted",
  overrides: Partial<RouteDescriptor> = {},
): RouteDescriptor {
  const meta = resolveRouteMetadata(path);
  return {
    method,
    path,
    summary: overrides.summary ?? buildSummary(method, path),
    tags: overrides.tags ?? meta.tags,
    auth: overrides.auth ?? meta.auth,
    stability: overrides.stability ?? meta.stability,
    feature: overrides.feature ?? meta.feature,
    operationId: overrides.operationId ?? buildOperationId(method, path),
    requestBody: overrides.requestBody,
    responseBody: overrides.responseBody,
    source,
  };
}

function routeMetaToDescriptor(meta: RouteMeta): RouteDescriptor {
  return createRouteDescriptor(meta.method, normalizePath(meta.path), "registered", {
    summary: meta.summary,
    tags: meta.tags,
    requestBody: meta.requestBody,
    responseBody: meta.responseBody,
    auth: meta.auth,
    stability: meta.stability,
    feature: meta.feature,
    operationId: meta.operationId,
  });
}

function buildOperationSkeleton(descriptor: RouteDescriptor): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": { description: "Success" },
    "400": { description: "Bad Request" },
    "500": { description: "Internal Server Error" },
  };

  if (descriptor.auth === "jwt" || descriptor.auth === "apiKey") {
    responses["401"] = { description: "Unauthorized" };
  }

  const operation: Record<string, unknown> = {
    summary: descriptor.summary,
    tags: descriptor.tags,
    operationId: descriptor.operationId,
    responses,
    "x-auth": descriptor.auth,
    "x-stability": descriptor.stability,
    "x-feature": descriptor.feature,
  };

  if (descriptor.auth === "jwt") {
    operation.security = [{ bearerAuth: [] }];
  } else if (descriptor.auth === "apiKey") {
    operation.security = [{ apiKeyAuth: [] }];
  }

  if (descriptor.requestBody) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: descriptor.requestBody,
        },
      },
    };
  }

  if (descriptor.responseBody) {
    operation.responses = {
      ...responses,
      "200": {
        description: "Success",
        content: {
          "application/json": {
            schema: descriptor.responseBody,
          },
        },
      },
    };
  }

  return operation;
}

function decorateOpenApiOperation(
  descriptor: RouteDescriptor,
  operation: Record<string, unknown>,
): Record<string, unknown> {
  const decorated: Record<string, unknown> = {
    ...operation,
    operationId: operation.operationId ?? descriptor.operationId,
    tags: operation.tags ?? descriptor.tags,
    "x-auth": operation["x-auth"] ?? descriptor.auth,
    "x-stability": operation["x-stability"] ?? descriptor.stability,
    "x-feature": operation["x-feature"] ?? descriptor.feature,
  };

  if (!decorated.security) {
    if (descriptor.auth === "jwt") {
      decorated.security = [{ bearerAuth: [] }];
    } else if (descriptor.auth === "apiKey") {
      decorated.security = [{ apiKeyAuth: [] }];
    }
  }

  return decorated;
}

function resolveRouteMetadata(path: string): Pick<RouteDescriptor, "tags" | "auth" | "stability" | "feature"> {
  const normalized = normalizePath(path);
  const match = [...ROUTE_RULES]
    .filter((rule) => pathMatches(normalized, rule.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];

  if (match) {
    return {
      tags: match.tags,
      auth: match.auth,
      stability: match.stability,
      feature: match.feature,
    };
  }

  const rootSegment = normalized.split("/").filter(Boolean)[0] ?? "gateway";
  return {
    tags: [rootSegment.replace(/[:{}]/g, "")],
    auth: "none",
    stability: "experimental",
    feature: rootSegment.replace(/[:{}]/g, ""),
  };
}

function buildSummary(method: HttpMethod, path: string): string {
  const cleanedPath = normalizePath(path);
  const readable = humanizePath(cleanedPath);

  switch (method) {
    case "GET":
      return cleanedPath.includes(":") ? `Get ${readable}` : `List ${readable}`;
    case "POST":
      return cleanedPath.includes(":") ? `Run ${readable}` : `Create ${readable}`;
    case "PUT":
    case "PATCH":
      return `Update ${readable}`;
    case "DELETE":
      return `Delete ${readable}`;
    default:
      return `${method} ${readable}`;
  }
}

function buildOperationId(method: HttpMethod, path: string): string {
  const verb = method.toLowerCase();
  const tokens = normalizePath(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^:/, "by-"));
  return camelCase([verb, ...tokens].join("-"));
}

function humanizePath(path: string): string {
  const tokens = path.split("/").filter(Boolean);
  if (tokens.length === 0) return "gateway";

  return tokens
    .map((segment) => segment.replace(/^:/, "by ").replace(/[{}]/g, "").replace(/[-_]/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function camelCase(value: string): string {
  const parts = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());

  if (parts.length === 0) return "route";

  return parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  const trimmed = path.trim();
  if (trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function joinPaths(basePath: string, routePath: string): string {
  const base = normalizePath(basePath);
  const route = normalizePath(routePath);
  if (base === "/") return route;
  if (route === "/") return base;
  return `${base.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
}

function normalizeRoutePaths(path: unknown): string[] {
  if (Array.isArray(path)) return path.flatMap((value) => normalizeRoutePaths(value));
  if (typeof path === "string") return [path];
  return [];
}

function pathMatches(path: string, prefix: string): boolean {
  const normalizedPrefix = normalizePath(prefix);
  if (normalizedPrefix === "/") return true;
  if (path === normalizedPrefix) return true;
  return path.startsWith(`${normalizedPrefix}/`);
}

function isRouterLike(value: unknown): value is RouterLike {
  return (
    typeof value === "function" ||
    (value !== null && typeof value === "object")
  ) && Array.isArray((value as RouterLike).stack);
}

function isRouteLayer(value: unknown): value is RouteLayerLike {
  return isPlainObject(value) && isPlainObject((value as RouteLayerLike).route);
}

function getNestedRouter(value: unknown): RouterLike | null {
  if (!isPlainObject(value)) return null;
  const handle = (value as RouteLayerLike).handle;
  return isRouterLike(handle) ? handle : null;
}

function isHttpMethod(value: string): value is HttpMethod {
  return value === "GET" || value === "POST" || value === "PUT" || value === "DELETE" || value === "PATCH";
}

function toHttpMethod(value: string): HttpMethod | null {
  const normalized = value.toUpperCase();
  return isHttpMethod(normalized) ? normalized : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inventoryKey(method: HttpMethod, path: string): string {
  return `${method} ${normalizePath(path)}`;
}
