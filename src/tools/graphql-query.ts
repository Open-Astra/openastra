import { z } from "zod";
import { registerTool } from "./registry.js";
import { createLogger } from "../utils/logger.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

const log = createLogger("graphql-query");

// ── graphql-query Tool ───────────────────────────────────────────────
// Execute GraphQL queries and mutations against any endpoint.
// Optional schema introspection before execution for validation.

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
      }
    }
  }
`.trim();

const Params = z.object({
  endpoint: z.string().url().describe("GraphQL endpoint URL"),
  query: z.string().describe("GraphQL query or mutation"),
  variables: z.record(z.string(), z.unknown()).optional().describe("Query variables as key-value pairs"),
  headers: z.record(z.string(), z.string()).optional().describe("Additional HTTP headers"),
  introspect: z.boolean().optional().default(false).describe("Fetch schema first to validate query"),
  timeoutMs: z.number().optional().default(30_000).describe("Request timeout in milliseconds"),
});

registerTool({
  name: "graphql-query",
  description:
    "Execute a GraphQL query or mutation against an endpoint. Supports variables, custom headers, and optional schema introspection before running the query. Returns data or errors from the response.",
  parameters: Params,
  async execute(params, _ctx) {
    const { endpoint, query, variables, headers: extraHeaders, introspect, timeoutMs } = params;

    // SSRF protection: block requests to internal/private hosts
    if (await isBlockedUrl(endpoint)) {
      return { error: "URL is blocked by SSRF policy — cannot make requests to internal/private hosts" };
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(extraHeaders ?? {}),
    };

    // Step 1: Optional introspection
    if (introspect) {
      try {
        const introRes = await fetch(endpoint, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify({ query: INTROSPECTION_QUERY }),
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        });

        if (introRes.status >= 300 && introRes.status < 400) {
          return { error: "Introspection endpoint returned a redirect, which is blocked for SSRF protection" };
        }

        if (!introRes.ok) {
          return {
            error: `Introspection failed: HTTP ${introRes.status}: ${introRes.statusText}`,
          };
        }

        const introData = await introRes.json() as {
          data?: unknown;
          errors?: Array<{ message: string; path?: unknown[] }>;
        };

        if (introData.errors?.length) {
          return {
            error: `Introspection returned errors: ${introData.errors.map((e) => e.message).join("; ")}`,
          };
        }

        log.dim("Introspection succeeded — proceeding with query");
      } catch (err) {
        return {
          error: `Introspection failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Step 2: Execute the actual query
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          query,
          ...(variables ? { variables } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });

      if (res.status >= 300 && res.status < 400) {
        return { error: "GraphQL endpoint returned a redirect, which is blocked for SSRF protection" };
      }

      if (!res.ok) {
        return { error: `HTTP ${res.status}: ${res.statusText}` };
      }

      const json = await res.json() as {
        data?: unknown;
        errors?: Array<{ message: string; path?: unknown[] }>;
      };

      if (json.errors?.length) {
        return { errors: json.errors, data: json.data };
      }

      return { data: json.data };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
