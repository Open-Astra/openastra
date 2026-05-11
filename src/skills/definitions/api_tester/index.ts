import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── API Tester Skill ────────────────────────────────────────────────
// HTTP request builder with auth, headers, body, and response assertions.

const RequestParams = z.object({
  url: z.string().url().describe("Request URL"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional().describe("Custom headers"),
  body: z.string().optional().describe("Request body (JSON string)"),
  auth: z.object({
    type: z.enum(["bearer", "basic", "api_key"]),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    headerName: z.string().optional(),
  }).optional().describe("Authentication config"),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  expectStatus: z.number().int().optional().describe("Expected HTTP status code for assertion"),
});

const MultiRequestParams = z.object({
  requests: z.array(z.object({
    name: z.string(),
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  })).min(1).max(10).describe("List of requests to execute"),
  sequential: z.boolean().default(false).describe("Run sequentially instead of parallel"),
});

const apiTesterSkill: SkillDefinition = {
  name: "api_tester",
  version: "1.0.0",

  manifest: {
    id: "api_tester",
    name: "API Tester",
    description: "HTTP request builder with auth support, response analysis, and batch execution.",
    category: "execute",
    tools: ["api_request", "api_batch"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "api_request",
      description: "Make an HTTP request with custom method, headers, body, and auth. Returns status, headers, and body.",
      parameters: RequestParams,

      async execute(params, _toolCtx) {
        const headers: Record<string, string> = { ...(params.headers as Record<string, string>) };

        if (params.auth) {
          switch (params.auth.type) {
            case "bearer":
              headers["Authorization"] = `Bearer ${params.auth.token}`;
              break;
            case "basic":
              headers["Authorization"] = `Basic ${Buffer.from(`${params.auth.username}:${params.auth.password}`).toString("base64")}`;
              break;
            case "api_key":
              headers[params.auth.headerName ?? "X-API-Key"] = params.auth.token ?? "";
              break;
          }
        }

        if (params.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }

        const start = Date.now();
        const res = await safeFetch(params.url, {
          method: params.method,
          headers,
          body: params.body,
          timeoutMs: params.timeoutMs,
          maxRetries: 0,
        });
        const elapsed = Date.now() - start;

        const contentType = res.headers.get("content-type") ?? "";
        let body: string | object;
        if (contentType.includes("json")) {
          try { body = await res.json() as object; } catch { body = await res.text(); }
        } else {
          body = (await res.text()).slice(0, 5000);
        }

        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { responseHeaders[k] = v; });

        const result: Record<string, unknown> = {
          status: res.status,
          statusText: res.statusText,
          elapsed: `${elapsed}ms`,
          headers: responseHeaders,
          body,
        };

        if (params.expectStatus !== undefined) {
          result.assertion = res.status === params.expectStatus ? "PASS" : `FAIL (expected ${params.expectStatus}, got ${res.status})`;
        }

        return result;
      },
    });

    ctx.registerTool({
      name: "api_batch",
      description: "Execute multiple HTTP requests in parallel or sequentially. Returns results for each.",
      parameters: MultiRequestParams,

      async execute(params, _toolCtx) {
        const exec = async (req: { name: string; url: string; method: string; headers?: Record<string, string> | undefined; body?: string }) => {
          const start = Date.now();
          try {
            const res = await safeFetch(req.url, {
              method: req.method,
              headers: req.headers ?? {},
              body: req.body,
              maxRetries: 0,
            });
            const elapsed = Date.now() - start;
            const contentType = res.headers.get("content-type") ?? "";
            let body: string | object;
            if (contentType.includes("json")) {
              try { body = await res.json() as object; } catch { body = await res.text(); }
            } else {
              body = (await res.text()).slice(0, 2000);
            }
            return { name: req.name, status: res.status, elapsed: `${elapsed}ms`, body };
          } catch (err) {
            return { name: req.name, error: err instanceof Error ? err.message : String(err), elapsed: `${Date.now() - start}ms` };
          }
        };

        let results;
        if (params.sequential) {
          results = [];
          for (const req of params.requests) results.push(await exec(req as Parameters<typeof exec>[0]));
        } else {
          results = await Promise.all(params.requests.map((r) => exec(r as Parameters<typeof exec>[0])));
        }

        return { count: results.length, sequential: params.sequential, results };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "api_tester",
      instructions: "You can test APIs with `api_request` (single request with auth/headers/assertions) and `api_batch` (multiple requests in parallel or sequentially).",
    };
  },
};

export default apiTesterSkill;
