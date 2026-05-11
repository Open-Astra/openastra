// ── Shared HTTP Helper for Skills ──────────────────────────────────
// Fetch with timeout, retry, and SSRF protection.
// Delegates SSRF validation to the centralized ssrf-guard (DNS resolution + IP pinning).

import { isBlockedUrl } from "../../utils/ssrf-guard.js";

export class SsrfError extends Error {
  constructor(url: string) {
    super(`SSRF protection: blocked request to ${url}`);
    this.name = "SsrfError";
  }
}

async function checkSsrf(url: string): Promise<void> {
  if (await isBlockedUrl(url)) {
    throw new SsrfError(url);
  }
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  ssrfProtection?: boolean;
}

export async function safeFetch(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10_000,
    maxRetries = 2,
    retryDelayMs = 1000,
    ssrfProtection = true,
  } = options;

  if (ssrfProtection) {
    await checkSsrf(url);
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });

      clearTimeout(timeout);

      // Don't retry on client errors (4xx)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // Retry on server errors (5xx)
      if (response.status >= 500 && attempt < maxRetries) {
        lastError = new Error(`HTTP ${response.status}`);
        await delay(retryDelayMs * (attempt + 1));
        continue;
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await delay(retryDelayMs * (attempt + 1));
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
