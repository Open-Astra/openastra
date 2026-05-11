import { z } from "zod";
import { registerTool } from "./registry.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";

// ── url_fetch Tool ──────────────────────────────────────────────────
// Fetches a URL and returns the response body. Supports JSON and text
// responses. Timeout-protected.

const UrlFetchParams = z.object({
  url: z.string().url().describe("URL to fetch"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .default("GET")
    .describe("HTTP method"),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom headers to send"),
  body: z
    .string()
    .optional()
    .describe("Request body (for POST/PUT/PATCH)"),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .default(10_000)
    .describe("Timeout in milliseconds (default 10s, max 30s)"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(2_000_000)
    .default(500_000)
    .describe("Maximum response bytes to return (default 500KB, max 2MB)"),
});

registerTool({
  name: "url_fetch",
  description:
    "Fetch a URL and return the response. Supports GET/POST/PUT/PATCH/DELETE with custom headers and body. Use for calling external APIs, scraping web pages, downloading data, etc. Blocks internal network addresses for security.",
  parameters: UrlFetchParams,
  async execute(params, _ctx) {
    if (await isBlockedUrl(params.url)) {
      return { error: "Fetching internal/private network addresses is not allowed." };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const res = await fetch(params.url, {
        method: params.method,
        headers: {
          "User-Agent": "Astra-Agent/1.0",
          ...(params.headers ?? {}),
        },
        body: params.body ?? undefined,
        signal: controller.signal,
        redirect: "manual",
      });

      // If the server redirected, validate the target before following
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return { error: `Redirect (${res.status}) with no Location header` };
        }
        const redirectUrl = new URL(location, params.url).href;
        if (await isBlockedUrl(redirectUrl)) {
          return { error: "Redirect targets an internal/private network address." };
        }
        return { error: `Redirected to ${redirectUrl} — re-issue the request with the new URL if desired.` };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const buffer = await res.arrayBuffer();
      const bytes = buffer.byteLength;

      let body: string;
      if (bytes > params.maxBytes) {
        const decoder = new TextDecoder();
        body = decoder.decode(buffer.slice(0, params.maxBytes)) + "\n... [truncated]";
      } else {
        const decoder = new TextDecoder();
        body = decoder.decode(buffer);
      }

      // Try to parse as JSON for cleaner output
      let parsed: unknown = undefined;
      if (contentType.includes("json")) {
        try {
          parsed = JSON.parse(body);
        } catch {
          // Not valid JSON, return as text
        }
      }

      // Strip HTML tags to reduce token waste when fetching web pages
      let finalBody: unknown = parsed ?? body;
      if (!parsed && contentType.includes("html")) {
        // Remove script/style blocks entirely, then strip remaining tags
        let stripped = body
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s{2,}/g, " ")
          .trim();
        // After stripping, re-truncate if needed (tags inflate byte count)
        if (stripped.length > params.maxBytes) {
          stripped = stripped.slice(0, params.maxBytes) + "\n... [truncated]";
        }
        finalBody = stripped;
      }

      return {
        status: res.status,
        statusText: res.statusText,
        contentType,
        bytes,
        truncated: bytes > params.maxBytes,
        body: finalBody,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { error: `Request timed out after ${params.timeoutMs}ms` };
      }
      return { error: msg };
    } finally {
      clearTimeout(timeout);
    }
  },
});
