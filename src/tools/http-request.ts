import { z } from "zod";
import { registerTool } from "./registry.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

// ── http_request ──────────────────────────────────────────────────────
// Flexible HTTP client with auth support, SSRF protection, and full
// method coverage. More powerful than url_fetch.

const HttpRequestParams = z.object({
  url: z.string().url().describe("Target URL"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    .default("GET")
    .describe("HTTP method (default GET)"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom request headers"),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe("Request body — string or object (auto-serialized to JSON)"),
  auth: z
    .object({
      type: z.enum(["bearer", "basic"]).describe("Auth type"),
      token: z.string().optional().describe("Bearer token"),
      username: z.string().optional().describe("Basic auth username"),
      password: z.string().optional().describe("Basic auth password"),
    })
    .optional()
    .describe("Authentication configuration"),
  followRedirects: z
    .boolean()
    .default(true)
    .describe("Follow HTTP redirects (default true)"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(10_000)
    .describe("Request timeout in milliseconds (default 10s, max 60s)"),
});

const MAX_RESPONSE = 2_000_000; // 2MB cap

registerTool({
  name: "http_request",
  description:
    "Make HTTP requests with full control over method, headers, body, authentication, and redirects. Supports Bearer and Basic auth. More flexible than url_fetch — use for API integrations, webhooks, testing endpoints, etc. Blocks private/internal network addresses.",
  parameters: HttpRequestParams,
  async execute(params) {
    // Validate URL format
    try {
      new URL(params.url);
    } catch {
      return { error: `Invalid URL: ${params.url}` };
    }

    // SSRF protection — uses DNS resolution to defeat rebinding attacks
    if (await isBlockedUrl(params.url)) {
      return { error: "Requests to internal/private network addresses are blocked." };
    }

    // Build headers
    const headers: Record<string, string> = {
      "User-Agent": "Astra-Agent/1.0",
      ...(params.headers ?? {}),
    };

    // Handle auth
    if (params.auth) {
      if (params.auth.type === "bearer" && params.auth.token) {
        headers["Authorization"] = `Bearer ${params.auth.token}`;
      } else if (params.auth.type === "basic" && params.auth.username) {
        const credentials = Buffer.from(
          `${params.auth.username}:${params.auth.password ?? ""}`,
        ).toString("base64");
        headers["Authorization"] = `Basic ${credentials}`;
      }
    }

    // Handle body
    let bodyStr: string | undefined;
    if (params.body !== undefined) {
      if (typeof params.body === "object") {
        bodyStr = JSON.stringify(params.body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      } else {
        bodyStr = params.body;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);
    const startTime = Date.now();

    try {
      let currentUrl = params.url;
      let redirectCount = 0;
      const MAX_REDIRECTS = 10;
      let res: Response;

      // Always use redirect: "manual" and validate each hop against SSRF guard
      while (true) {
        res = await fetch(currentUrl, {
          method: params.method,
          headers,
          body: bodyStr,
          signal: controller.signal,
          redirect: "manual",
        });

        if (res.status >= 300 && res.status < 400 && params.followRedirects) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            return { error: "Too many redirects (max 10)" };
          }
          const location = res.headers.get("location");
          if (!location) {
            return { error: `Redirect (${res.status}) with no Location header` };
          }
          const nextUrl = new URL(location, currentUrl).href;
          if (await isBlockedUrl(nextUrl)) {
            return { error: "Redirect targets an internal/private network address." };
          }
          currentUrl = nextUrl;
          continue;
        }
        break;
      }

      const elapsed = Date.now() - startTime;

      // Read response body
      const buffer = await res.arrayBuffer();
      const bytes = buffer.byteLength;

      let responseBody: unknown;
      const contentType = res.headers.get("content-type") ?? "";

      if (bytes > MAX_RESPONSE) {
        const decoder = new TextDecoder();
        responseBody = decoder.decode(buffer.slice(0, MAX_RESPONSE)) + "\n... [truncated]";
      } else {
        const text = new TextDecoder().decode(buffer);

        // Try to parse as JSON
        if (contentType.includes("json")) {
          try {
            responseBody = JSON.parse(text);
          } catch {
            responseBody = text;
          }
        } else {
          responseBody = text;
        }
      }

      // Collect response headers
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: responseBody,
        bytes,
        elapsed,
        redirected: redirectCount > 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { error: `Request timed out after ${params.timeoutMs}ms` };
      }
      return { error: msg };
    } finally {
      clearTimeout(timer);
    }
  },
});
