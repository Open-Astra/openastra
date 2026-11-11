// ── SSRF Guard ───────────────────────────────────────────────────────
// Blocks outbound HTTP requests to internal/private network addresses.
// Used anywhere the platform fires user-supplied URLs (session webhooks,
// registered webhooks, heartbeat URLs, agent HTTP tools, etc.).
//
//   isBlockedUrl(url)   — check only. Resolves DNS and rejects if ANY address
//                         is internal. NOTE: a caller that then does a plain
//                         fetch() re-resolves DNS, which leaves a rebinding
//                         window. Prefer safeFetch().
//   safeFetch(url, …)   — check AND fetch. The connection is pinned to the
//                         exact IP that was validated (custom socket lookup,
//                         TLS SNI/cert still verified against the hostname),
//                         and redirects are followed manually with every hop
//                         re-validated the same way.
//
// Also: outbound host allowlisting (ALLOWED_OUTBOUND_HOSTS), rejection of
// hex/octal/decimal IP encodings, IPv4-mapped / NAT64 / 6to4 IPv6 forms.

import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { recordThreat } from "../security/intrusion-detection.js";

// Hostnames that are internal regardless of what they resolve to.
const BLOCKED_HOSTNAMES = [
  /^localhost\.?$/i,
  /\.localhost\.?$/i,
  /^metadata\.google\.internal\.?$/i,
  /^metadata\.?$/i,
  /\.internal\.?$/i,
  /\.local\.?$/i,
  /^instance-data\.?$/i,
  /^kubernetes(\.default(\.svc(\.cluster\.local)?)?)?\.?$/i,
  /^0+$/, // all-zeros
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

// ── IP classification ───────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inRange(n: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((b & mask) >>> 0);
}

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],        // "this" network / bind-all
  ["10.0.0.0", 8],       // RFC 1918
  ["100.64.0.0", 10],    // RFC 6598 carrier-grade NAT (also Tailscale, cloud internal LBs)
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local / cloud metadata
  ["172.16.0.0", 12],    // RFC 1918
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // RFC 1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // not a clean dotted quad → fail closed
  return BLOCKED_V4_RANGES.some(([base, bits]) => inRange(n, base, bits));
}

/** Expand an IPv6 literal into 8 hextets (numbers). Returns null if invalid. */
function expandV6(input: string): number[] | null {
  let ip = input.replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (isIP(ip) !== 6) return null;

  // Embedded dotted-quad tail (::ffff:1.2.3.4)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const n = ipv4ToInt(tail);
    if (n === null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }

  const [head, rest] = ip.split("::") as [string, string | undefined];
  const headParts = head ? head.split(":") : [];
  const restParts = rest !== undefined ? (rest ? rest.split(":") : []) : [];
  if (rest === undefined && headParts.length !== 8) return null;
  const fill = 8 - headParts.length - restParts.length;
  if (fill < 0) return null;
  const all = [...headParts, ...Array<string>(rest !== undefined ? fill : 0).fill("0"), ...restParts];
  if (all.length !== 8) return null;
  const out = all.map((h) => parseInt(h, 16));
  return out.some((v) => Number.isNaN(v) || v < 0 || v > 0xffff) ? null : out;
}

function v4FromHextets(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h) return true; // unparseable → fail closed

  // :: (unspecified) and ::1 (loopback)
  if (h.slice(0, 7).every((v) => v === 0) && (h[7] === 0 || h[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (h.slice(0, 5).every((v) => v === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return isBlockedV4(v4FromHextets(h[6]!, h[7]!));
  }
  // IPv4-translated ::ffff:0:a.b.c.d
  if (h.slice(0, 4).every((v) => v === 0) && h[4] === 0xffff && h[5] === 0) {
    return isBlockedV4(v4FromHextets(h[6]!, h[7]!));
  }
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (h[0] === 0x64 && h[1] === 0xff9b) {
    if (h[2] === 1) return true;
    return isBlockedV4(v4FromHextets(h[6]!, h[7]!));
  }
  // 6to4 2002::/16 embeds an IPv4 address in hextets 1-2
  if (h[0] === 0x2002) return isBlockedV4(v4FromHextets(h[1]!, h[2]!));
  // Teredo 2001:0000::/32
  if (h[0] === 0x2001 && h[1] === 0) return true;
  // Unique local fc00::/7 (fc.. and fd..)
  if ((h[0]! & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (fe80..febf)
  if ((h[0]! & 0xffc0) === 0xfe80) return true;
  // Site-local fec0::/10 (deprecated, still routed internally)
  if ((h[0]! & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((h[0]! & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  return false;
}

/** True when the literal IP address is loopback, private, link-local, etc. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0]!);
  if (family === 4) return isBlockedV4(bare);
  if (family === 6) return isBlockedV6(bare);
  return true; // not an IP at all → fail closed
}

function isNonStandardIpEncoding(hostname: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true; // hex IP (0x7f000001)
  if (/^\d+$/.test(hostname)) return true; // decimal IP (2130706433) or bare number
  if (/^0\d+/.test(hostname)) return true; // octal IP (017700000001)
  // (The WHATWG URL parser already canonicalises forms such as 127.1 or
  // 0x7f.0.0.1 into a dotted quad, which is then range-checked.)
  return false;
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
 * Resolve a hostname and return all A + AAAA addresses.
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

interface ValidatedTarget {
  url: URL;
  hostname: string;
  /** Addresses that were validated; the connection is pinned to ips[0]. */
  ips: string[];
}

/**
 * Validate a URL and return the addresses it may connect to.
 * Throws with a message starting "SSRF:" when the target is not allowed.
 */
async function validateTarget(rawUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SSRF: unparseable URL");
  }
  const { protocol } = url;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("SSRF: only http/https protocols are allowed");
  }
  if (url.username || url.password) {
    throw new Error("SSRF: credentials in URLs are not allowed");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) throw new Error("SSRF: missing hostname");

  if (BLOCKED_HOSTNAMES.some((p) => p.test(hostname))) {
    throw new Error("SSRF: hostname is blocked");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily === 0 && isNonStandardIpEncoding(hostname)) {
    throw new Error("SSRF: non-standard IP format blocked");
  }

  if (!isHostAllowed(hostname)) {
    throw new Error(`SSRF: hostname "${hostname}" is not in the outbound allowlist`);
  }

  if (literalFamily !== 0) {
    if (isBlockedIp(hostname)) throw new Error(`SSRF: IP ${hostname} is blocked`);
    return { url, hostname, ips: [hostname] };
  }

  // Resolve DNS and check ALL resolved IP addresses (A + AAAA) — a single
  // lookup() result would let round-robin DNS mix one public and one
  // internal address.
  const ips = await resolveAllIps(hostname);
  if (ips.length === 0) throw new Error("SSRF: DNS resolution failed (no records)");
  for (const ip of ips) {
    if (isBlockedIp(ip)) throw new Error(`SSRF: resolved IP ${ip} is blocked`);
  }
  return { url, hostname, ips };
}

/**
 * Returns true if the URL targets a blocked internal/private host.
 * Resolves DNS to defeat non-standard IP formats and internal records.
 * Unparseable URLs are treated as blocked.
 *
 * Checking and then calling fetch() separately re-resolves DNS; use
 * safeFetch() wherever the URL is attacker-influenced.
 */
export async function isBlockedUrl(url: string): Promise<boolean> {
  try {
    await validateTarget(url);
    return false;
  } catch {
    return true;
  }
}

// ── Pinned fetch ────────────────────────────────────────────────────

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  /** Maximum redirects to follow (each hop is re-validated). Default 5; 0 disables. */
  maxRedirects?: number;
  /** "follow" (default, manual + re-validated), "manual" (return the 3xx) or "error". */
  redirect?: "follow" | "manual" | "error";
  /** Abort after this many ms (in addition to any signal). Default 30s. */
  timeoutMs?: number;
  /** Maximum response body bytes buffered. Default 25 MB. */
  maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function toBodyBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("safeFetch: unsupported request body type (use string, Buffer or URLSearchParams)");
}

function requestOnce(
  target: ValidatedTarget,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<Response> {
  const pinnedIp = target.ips[0]!;
  const family = isIP(pinnedIp) === 6 ? 6 : 4;
  const isHttps = target.url.protocol === "https:";
  const lib = isHttps ? https : http;

  const headerObj: Record<string, string> = {};
  headers.forEach((value, key) => { headerObj[key] = value; });
  if (body && !headers.has("content-length")) headerObj["content-length"] = String(body.byteLength);

  return new Promise<Response>((resolvePromise, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const req = lib.request(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.url.port || (isHttps ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        method,
        headers: headerObj,
        agent: false,
        // Pin the socket to the address that was validated. The hostname is
        // still used for the Host header, SNI and certificate verification.
        lookup: (_host: string, opts: unknown, cb: unknown) => {
          const callback = (typeof opts === "function" ? opts : cb) as (
            err: Error | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void;
          const wantsAll = typeof opts === "object" && opts !== null && (opts as { all?: boolean }).all === true;
          if (wantsAll) callback(null, [{ address: pinnedIp, family }]);
          else callback(null, pinnedIp, family);
        },
        ...(isHttps ? { servername: isIP(target.hostname) ? undefined : target.hostname } : {}),
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            req.destroy(new Error(`safeFetch: response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", (err) => finish(() => reject(err)));
        res.on("end", () => {
          const outHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) value.forEach((v) => outHeaders.append(key, v));
            else outHeaders.set(key, value);
          }
          const status = res.statusCode ?? 502;
          const nullBody = status === 204 || status === 205 || status === 304 || method === "HEAD";
          finish(() =>
            resolvePromise(
              new Response(nullBody ? null : Buffer.concat(chunks), {
                status: status < 200 ? 502 : status,
                statusText: res.statusMessage ?? "",
                headers: outHeaders,
              }),
            ),
          );
        });
      },
    );

    const onAbort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      req.destroy(err);
      finish(() => reject(err));
    };
    const timer = setTimeout(() => {
      const err = new Error(`safeFetch: timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      req.destroy(err);
      finish(() => reject(err));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    req.on("error", (err) => finish(() => reject(err)));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * DNS-pinning safe fetch. Resolves DNS once, validates every address against
 * the blocklist, then connects to exactly the validated address — a second
 * DNS answer (rebinding) can never be used. Redirects are not followed by
 * the HTTP client; each hop is validated and pinned again here.
 *
 * @throws Error ("SSRF: …") if the URL or any redirect hop is blocked
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const {
    maxRedirects = 5,
    redirect = "follow",
    timeoutMs = 30_000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    signal,
  } = options;

  let currentUrl = url;
  let method = (options.method ?? "GET").toUpperCase();
  let body = toBodyBuffer(options.body);
  const headers = new Headers(options.headers as ConstructorParameters<typeof Headers>[0]);
  headers.delete("host"); // always derived from the validated URL

  for (let hop = 0; ; hop++) {
    let target: ValidatedTarget;
    try {
      target = await validateTarget(currentUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordThreat({ category: "ssrf", sourceIp: "unknown", detail: `${detail}: ${currentUrl.slice(0, 200)}`, timestamp: Date.now() });
      throw err;
    }

    const response = await requestOnce(
      target,
      method,
      headers,
      body,
      signal ?? undefined,
      timeoutMs,
      maxResponseBytes,
    );

    if (!REDIRECT_STATUSES.has(response.status) || redirect === "manual") {
      Object.defineProperty(response, "url", { value: target.url.toString() });
      return response;
    }
    if (redirect === "error") throw new Error("SSRF: redirect not allowed");

    const location = response.headers.get("location");
    if (!location) {
      Object.defineProperty(response, "url", { value: target.url.toString() });
      return response;
    }
    if (hop >= maxRedirects) throw new Error("SSRF: too many redirects");

    const next = new URL(location, target.url);
    // Never forward credentials to a different origin.
    if (next.origin !== target.url.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
      headers.delete("x-api-key");
    }
    // 303 (and 301/302 for non-GET/HEAD) switch to GET without a body.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
      headers.delete("content-length");
    }
    currentUrl = next.toString();
  }
}
