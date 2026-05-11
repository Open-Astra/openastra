// ── SSRF Guard ───────────────────────────────────────────────────────
// Blocks outbound HTTP requests to internal/private network addresses.
// Used anywhere the platform fires user-supplied URLs (session webhooks,
// registered webhooks, heartbeat URLs, etc.).
//
// Features:
//   - DNS resolution to defeat rebinding and non-standard IP formats
//   - DNS pinning via safeFetch() to prevent rebinding between check and use
//   - Outbound host allowlisting (ALLOWED_OUTBOUND_HOSTS env var)
//   - Blocks hex/octal/decimal IP encoding, IPv6-mapped IPv4, bind-all addresses

import { resolve4, resolve6 } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { recordThreat } from "../security/intrusion-detection.js";

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^0+$/,                                      // all-zeros
  /^::$/,                                      // IPv6 bind-all
  /^\[::\]$/,                                  // IPv6 bind-all bracketed
  /^169\.254\.\d+\.\d+$/,                      // link-local / AWS metadata
  /^\[::1\]$/,
  /^::1$/,
  /^::ffff:127\.\d+\.\d+\.\d+$/,              // IPv4-mapped IPv6 loopback
  /^::ffff:10\.\d+\.\d+\.\d+$/,               // IPv4-mapped IPv6 private
  /^::ffff:172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^::ffff:192\.168\.\d+\.\d+$/,
  /^::ffff:169\.254\.\d+\.\d+$/,
  /^::ffff:0\.0\.0\.0$/,
  /^fe80:/i,                                   // IPv6 link-local
  /^fc00:/i,                                   // IPv6 unique local
  /^fd[0-9a-f]{2}:/i,                          // IPv6 unique local
  /^metadata\.google\.internal$/i,
];

// LLM provider domains always allowed through outbound allowlist
const PROVIDER_DOMAINS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.x.ai",
  "api.mistral.ai",
  "openrouter.ai",
]);

function isIpBlocked(ip: string): boolean {
  return BLOCKED_HOSTS.some((p) => p.test(ip));
}

/**
 * Check outbound host allowlist. Returns true if the host is allowed.
 * When ALLOWED_OUTBOUND_HOSTS is not set, all non-blocked hosts are allowed.
 */
function isHostAllowed(hostname: string): boolean {
  const allowedHosts = process.env.ALLOWED_OUTBOUND_HOSTS;
  if (!allowedHosts) return true; // No allowlist = blocklist-only mode

  const allowed = new Set(
    allowedHosts.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  );

  const lower = hostname.toLowerCase();
  if (allowed.has(lower)) return true;
  if (PROVIDER_DOMAINS.has(lower)) return true;

  return false;
}

/**
 * Returns true if the URL targets a blocked internal/private host.
 * Resolves DNS to defeat rebinding and non-standard IP formats.
 * Unparseable URLs are treated as blocked.
 */
export async function isBlockedUrl(url: string): Promise<boolean> {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return true;

    // Check hostname string first (catches literal localhost, metadata, etc.)
    if (BLOCKED_HOSTS.some((p) => p.test(hostname))) return true;

    // Block non-standard IP formats that bypass string regex checks
    if (/^0x[0-9a-f]+$/i.test(hostname)) return true; // hex IP (0x7f000001)
    if (/^\d{8,}$/.test(hostname)) return true; // decimal IP (2130706433)
    if (/^0\d+/.test(hostname)) return true; // octal IP (017700000001)

    // Check outbound allowlist
    if (!isHostAllowed(hostname)) return true;

    // Resolve DNS and check ALL resolved IP addresses (A + AAAA)
    // Using resolveAllIps instead of lookup() — lookup returns only one IP,
    // which lets DNS round-robin with one safe + one internal IP bypass the check.
    const ips = await resolveAllIps(hostname);
    if (ips.length === 0) return true; // DNS failure → fail-closed
    for (const ip of ips) {
      if (isIpBlocked(ip)) return true;
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve a hostname and return all IPv4 addresses.
 * Returns empty array on failure.
 */
async function resolveAllIps(hostname: string): Promise<string[]> {
  const ips: string[] = [];
  try {
    const v4 = await resolve4(hostname);
    ips.push(...v4);
  } catch { /* no A records */ }
  try {
    const v6 = await resolve6(hostname);
    ips.push(...v6);
  } catch { /* no AAAA records */ }
  return ips;
}

/**
 * DNS-pinning safe fetch. Resolves DNS once, validates all IPs against
 * the blocklist, then forces the connection to use the pinned IP.
 * Prevents DNS rebinding attacks where the second lookup returns a
 * different (internal) IP.
 *
 * @throws Error if the URL is blocked, DNS fails, or all IPs are blocked
 */
export async function safeFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const parsed = new URL(url);
  const { hostname, protocol } = parsed;

  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("SSRF: only http/https protocols are allowed");
  }

  // Check hostname patterns
  if (BLOCKED_HOSTS.some((p) => p.test(hostname))) {
    recordThreat({ category: "ssrf", sourceIp: hostname, detail: `blocked hostname: ${hostname}`, timestamp: Date.now() });
    throw new Error("SSRF: hostname is blocked");
  }

  // Block non-standard IP encodings
  if (/^0x[0-9a-f]+$/i.test(hostname) || /^\d{8,}$/.test(hostname) || /^0\d+/.test(hostname)) {
    recordThreat({ category: "ssrf", sourceIp: hostname, detail: `non-standard IP: ${hostname}`, timestamp: Date.now() });
    throw new Error("SSRF: non-standard IP format blocked");
  }

  // Check outbound allowlist
  if (!isHostAllowed(hostname)) {
    recordThreat({ category: "ssrf", sourceIp: hostname, detail: `not in allowlist: ${hostname}`, timestamp: Date.now() });
    throw new Error(`SSRF: hostname "${hostname}" is not in the outbound allowlist`);
  }

  // Resolve DNS and validate ALL IPs
  const ips = await resolveAllIps(hostname);
  if (ips.length === 0) {
    throw new Error("SSRF: DNS resolution failed (no records)");
  }

  for (const ip of ips) {
    if (isIpBlocked(ip)) {
      recordThreat({ category: "ssrf", sourceIp: ip, detail: `resolved IP blocked: ${hostname} → ${ip}`, timestamp: Date.now() });
      throw new Error(`SSRF: resolved IP ${ip} is blocked`);
    }
  }

  // Pin to the first valid IP to prevent rebinding
  const pinnedIp = ips[0]!;

  // Create a custom agent that forces the connection to the pinned IP
  const isHttps = protocol === "https:";
  const AgentClass = isHttps ? https.Agent : http.Agent;
  const agent = new AgentClass({
    lookup: (_hostname, _options, callback) => {
      // Always return the pinned IP regardless of what DNS says now
      callback(null, pinnedIp, pinnedIp.includes(":") ? 6 : 4);
    },
  });

  // Node's fetch doesn't support custom agents directly,
  // so we use the dispatcher pattern when available.
  // Fall back to standard fetch with the URL rewritten to use the pinned IP.
  const pinnedUrl = new URL(url);
  // Keep original Host header but connect to pinned IP
  const headers = new Headers(options?.headers);
  if (!headers.has("Host")) {
    headers.set("Host", hostname);
  }

  // For standard Node.js fetch, we can't inject a custom agent,
  // so we modify the URL to use the IP directly (works for most cases)
  pinnedUrl.hostname = pinnedIp;

  try {
    return await fetch(pinnedUrl.toString(), {
      ...options,
      headers,
      // @ts-expect-error Node.js fetch supports agent in some versions
      agent,
    });
  } finally {
    agent.destroy();
  }
}
