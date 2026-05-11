// ── SSRF Guard Tests ────────────────────────────────────────────────
// Tests for src/utils/ssrf-guard.ts — isBlockedUrl() and safeFetch()

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock node:dns/promises ──────────────────────────────────────────
const mockResolve4 = vi.fn<(hostname: string) => Promise<string[]>>();
const mockResolve6 = vi.fn<(hostname: string) => Promise<string[]>>();

vi.mock("node:dns/promises", () => ({
  resolve4: (...args: Parameters<typeof mockResolve4>) => mockResolve4(...args),
  resolve6: (...args: Parameters<typeof mockResolve6>) => mockResolve6(...args),
}));

// ── Mock intrusion-detection ────────────────────────────────────────
const mockRecordThreat = vi.fn();

vi.mock("../../src/security/intrusion-detection.js", () => ({
  recordThreat: (...args: unknown[]) => mockRecordThreat(...args),
}));

// ── Import after mocks ─────────────────────────────────────────────
import { isBlockedUrl, safeFetch } from "../../src/utils/ssrf-guard.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Configure DNS mocks to resolve to the given public IPs. */
function dnsResolvesTo(v4: string[] = ["93.184.216.34"], v6: string[] = []) {
  mockResolve4.mockResolvedValue(v4);
  if (v6.length > 0) {
    mockResolve6.mockResolvedValue(v6);
  } else {
    mockResolve6.mockRejectedValue(new Error("no AAAA records"));
  }
}

/** Configure DNS mocks to fail (NXDOMAIN / no records). */
function dnsFails() {
  mockResolve4.mockRejectedValue(new Error("ENOTFOUND"));
  mockResolve6.mockRejectedValue(new Error("ENOTFOUND"));
}

/** Configure DNS to return a mix of public and private IPs. */
function dnsRoundRobin(v4: string[]) {
  mockResolve4.mockResolvedValue(v4);
  mockResolve6.mockRejectedValue(new Error("no AAAA records"));
}

// ── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALLOWED_OUTBOUND_HOSTS;
});

// =====================================================================
// isBlockedUrl
// =====================================================================
describe("isBlockedUrl", () => {
  // ── IPv4 loopback ───────────────────────────────────────────────
  describe("blocks IPv4 loopback addresses", () => {
    it("blocks 127.0.0.1", async () => {
      expect(await isBlockedUrl("http://127.0.0.1/path")).toBe(true);
    });

    it("blocks 127.255.255.255", async () => {
      expect(await isBlockedUrl("http://127.255.255.255")).toBe(true);
    });

    it("blocks localhost", async () => {
      expect(await isBlockedUrl("http://localhost:8080/api")).toBe(true);
    });

    it("blocks LOCALHOST (case-insensitive)", async () => {
      expect(await isBlockedUrl("http://LOCALHOST/api")).toBe(true);
    });
  });

  // ── RFC 1918 private ranges ─────────────────────────────────────
  describe("blocks RFC 1918 private ranges", () => {
    it("blocks 10.0.0.1", async () => {
      expect(await isBlockedUrl("http://10.0.0.1")).toBe(true);
    });

    it("blocks 10.255.255.255", async () => {
      expect(await isBlockedUrl("http://10.255.255.255")).toBe(true);
    });

    it("blocks 172.16.0.1", async () => {
      expect(await isBlockedUrl("http://172.16.0.1")).toBe(true);
    });

    it("blocks 172.31.255.255", async () => {
      expect(await isBlockedUrl("http://172.31.255.255")).toBe(true);
    });

    it("blocks 192.168.0.1", async () => {
      expect(await isBlockedUrl("http://192.168.0.1")).toBe(true);
    });

    it("blocks 192.168.255.255", async () => {
      expect(await isBlockedUrl("http://192.168.255.255")).toBe(true);
    });
  });

  // ── IPv6 loopback and special addresses ─────────────────────────
  describe("blocks IPv6 loopback and special addresses", () => {
    it("blocks [::1]", async () => {
      expect(await isBlockedUrl("http://[::1]/path")).toBe(true);
    });

    it("blocks :: (bind-all)", async () => {
      expect(await isBlockedUrl("http://[::]/path")).toBe(true);
    });

    it("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback)", async () => {
      expect(await isBlockedUrl("http://[::ffff:127.0.0.1]")).toBe(true);
    });

    it("blocks ::ffff:10.0.0.1 (IPv4-mapped private)", async () => {
      expect(await isBlockedUrl("http://[::ffff:10.0.0.1]")).toBe(true);
    });

    it("blocks ::ffff:172.16.0.1 (IPv4-mapped private)", async () => {
      expect(await isBlockedUrl("http://[::ffff:172.16.0.1]")).toBe(true);
    });

    it("blocks ::ffff:192.168.1.1 (IPv4-mapped private)", async () => {
      expect(await isBlockedUrl("http://[::ffff:192.168.1.1]")).toBe(true);
    });
  });

  // ── Link-local and cloud metadata ───────────────────────────────
  describe("blocks link-local and cloud metadata addresses", () => {
    it("blocks 169.254.169.254 (AWS metadata)", async () => {
      expect(await isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
    });

    it("blocks 169.254.0.1 (link-local)", async () => {
      expect(await isBlockedUrl("http://169.254.0.1")).toBe(true);
    });

    it("blocks metadata.google.internal", async () => {
      expect(await isBlockedUrl("http://metadata.google.internal/computeMetadata/v1/")).toBe(true);
    });

    it("blocks METADATA.GOOGLE.INTERNAL (case-insensitive)", async () => {
      expect(await isBlockedUrl("http://METADATA.GOOGLE.INTERNAL/")).toBe(true);
    });
  });

  // ── Non-standard IP encodings ───────────────────────────────────
  describe("blocks non-standard IP encodings", () => {
    it("blocks hex IP 0x7f000001 (127.0.0.1)", async () => {
      expect(await isBlockedUrl("http://0x7f000001/")).toBe(true);
    });

    it("blocks hex IP 0x0a000001 (10.0.0.1)", async () => {
      expect(await isBlockedUrl("http://0x0a000001/")).toBe(true);
    });

    it("blocks decimal IP 2130706433 (127.0.0.1)", async () => {
      expect(await isBlockedUrl("http://2130706433/")).toBe(true);
    });

    it("blocks octal IP 0177.0.0.1 (127.0.0.1)", async () => {
      expect(await isBlockedUrl("http://0177.0.0.1/")).toBe(true);
    });

    it("blocks octal IP 017700000001", async () => {
      expect(await isBlockedUrl("http://017700000001/")).toBe(true);
    });
  });

  // ── Bind-all address ────────────────────────────────────────────
  describe("blocks bind-all addresses", () => {
    it("blocks 0.0.0.0", async () => {
      expect(await isBlockedUrl("http://0.0.0.0/")).toBe(true);
    });

    it("blocks ::ffff:0.0.0.0 (IPv4-mapped bind-all)", async () => {
      expect(await isBlockedUrl("http://[::ffff:0.0.0.0]")).toBe(true);
    });
  });

  // ── Protocol restrictions ───────────────────────────────────────
  describe("blocks non-HTTP protocols", () => {
    it("blocks ftp:// protocol", async () => {
      expect(await isBlockedUrl("ftp://example.com/file")).toBe(true);
    });

    it("blocks file:// protocol", async () => {
      expect(await isBlockedUrl("file:///etc/passwd")).toBe(true);
    });

    it("blocks gopher:// protocol", async () => {
      expect(await isBlockedUrl("gopher://evil.com")).toBe(true);
    });

    it("blocks javascript: protocol", async () => {
      expect(await isBlockedUrl("javascript:alert(1)")).toBe(true);
    });

    it("blocks data: protocol", async () => {
      expect(await isBlockedUrl("data:text/html,<h1>hi</h1>")).toBe(true);
    });
  });

  // ── Unparseable URLs ────────────────────────────────────────────
  describe("blocks unparseable URLs (fail-closed)", () => {
    it("blocks empty string", async () => {
      expect(await isBlockedUrl("")).toBe(true);
    });

    it("blocks garbage input", async () => {
      expect(await isBlockedUrl("not-a-url-at-all")).toBe(true);
    });

    it("blocks URL with no protocol", async () => {
      expect(await isBlockedUrl("example.com/path")).toBe(true);
    });
  });

  // ── DNS resolution: private IPs ─────────────────────────────────
  describe("blocks DNS resolving to private IPs", () => {
    it("blocks hostname resolving to 127.0.0.1", async () => {
      dnsResolvesTo(["127.0.0.1"]);
      expect(await isBlockedUrl("http://evil-rebind.example.com/")).toBe(true);
    });

    it("blocks hostname resolving to 10.0.0.5", async () => {
      dnsResolvesTo(["10.0.0.5"]);
      expect(await isBlockedUrl("http://internal.example.com/")).toBe(true);
    });

    it("blocks hostname resolving to 192.168.1.100", async () => {
      dnsResolvesTo(["192.168.1.100"]);
      expect(await isBlockedUrl("http://home.example.com/")).toBe(true);
    });

    it("blocks hostname resolving to 169.254.169.254 (metadata via DNS)", async () => {
      dnsResolvesTo(["169.254.169.254"]);
      expect(await isBlockedUrl("http://metadata-proxy.example.com/")).toBe(true);
    });
  });

  // ── DNS round-robin: any private IP blocks ──────────────────────
  describe("blocks when ANY resolved IP is private (round-robin)", () => {
    it("blocks when one of multiple A records is private", async () => {
      dnsRoundRobin(["93.184.216.34", "10.0.0.1"]);
      expect(await isBlockedUrl("http://mixed-dns.example.com/")).toBe(true);
    });

    it("blocks when last A record is private", async () => {
      dnsRoundRobin(["93.184.216.34", "8.8.8.8", "192.168.1.1"]);
      expect(await isBlockedUrl("http://sneaky.example.com/")).toBe(true);
    });

    it("blocks when one of multiple IPs is loopback", async () => {
      dnsRoundRobin(["1.2.3.4", "127.0.0.1", "5.6.7.8"]);
      expect(await isBlockedUrl("http://tricky.example.com/")).toBe(true);
    });
  });

  // ── DNS failure: fail-closed ────────────────────────────────────
  describe("fails closed on DNS failure", () => {
    it("blocks when DNS resolution fails entirely", async () => {
      dnsFails();
      expect(await isBlockedUrl("http://nonexistent.example.com/")).toBe(true);
    });

    it("blocks when DNS returns no records (empty arrays)", async () => {
      mockResolve4.mockResolvedValue([]);
      mockResolve6.mockRejectedValue(new Error("no AAAA"));
      expect(await isBlockedUrl("http://no-records.example.com/")).toBe(true);
    });
  });

  // ── Allowed public URLs ─────────────────────────────────────────
  describe("allows valid public URLs", () => {
    it("allows http:// with public DNS resolution", async () => {
      dnsResolvesTo(["93.184.216.34"]);
      expect(await isBlockedUrl("http://example.com/")).toBe(false);
    });

    it("allows https:// with public DNS resolution", async () => {
      dnsResolvesTo(["93.184.216.34"]);
      expect(await isBlockedUrl("https://example.com/api/data")).toBe(false);
    });

    it("allows URL when all resolved IPs are public", async () => {
      dnsResolvesTo(["93.184.216.34", "93.184.216.35"], ["2606:2800:220:1:248:1893:25c8:1946"]);
      expect(await isBlockedUrl("https://cdn.example.com/asset.js")).toBe(false);
    });

    it("allows URL with port on public domain", async () => {
      dnsResolvesTo(["93.184.216.34"]);
      expect(await isBlockedUrl("https://api.example.com:8443/v1/data")).toBe(false);
    });
  });

  // ── IPv6 unique-local and link-local via DNS ────────────────────
  describe("blocks IPv6 unique-local and link-local via DNS", () => {
    it("blocks hostname resolving to fe80:: (link-local IPv6)", async () => {
      mockResolve4.mockRejectedValue(new Error("no A"));
      mockResolve6.mockResolvedValue(["fe80::1"]);
      expect(await isBlockedUrl("http://v6-linklocal.example.com/")).toBe(true);
    });

    it("blocks hostname resolving to fc00:: (unique-local IPv6)", async () => {
      mockResolve4.mockRejectedValue(new Error("no A"));
      mockResolve6.mockResolvedValue(["fc00::1"]);
      expect(await isBlockedUrl("http://v6-ula.example.com/")).toBe(true);
    });

    it("blocks hostname resolving to fd12:: (unique-local IPv6)", async () => {
      mockResolve4.mockRejectedValue(new Error("no A"));
      mockResolve6.mockResolvedValue(["fd12::1"]);
      expect(await isBlockedUrl("http://v6-fd.example.com/")).toBe(true);
    });
  });
});
