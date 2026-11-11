import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import * as tls from "node:tls";
import { isBlockedUrl } from "../../../utils/ssrf-guard.js";

// Certificate checks open a TCP connection from the gateway, so the target
// is validated like any other outbound request (no internal hosts, no
// arbitrary port scanning).
const ALLOWED_TLS_PORTS = new Set([443, 465, 563, 636, 853, 993, 995, 8443]);

async function checkTarget(hostname: string, port: number): Promise<string | null> {
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname)) return "Invalid hostname";
  if (!ALLOWED_TLS_PORTS.has(port)) return `Port ${port} is not an allowed TLS port`;
  if (await isBlockedUrl(`https://${hostname}:${port}/`)) return "Host is not reachable from this tool (internal or unresolvable address)";
  return null;
}

// ── SSL Checker Skill ───────────────────────────────────────────────
// Check SSL/TLS certificates: expiry, issuer, chain validation.

const CheckParams = z.object({
  hostname: z.string().describe("Hostname to check SSL certificate for"),
  port: z.number().int().default(443).describe("Port (default: 443)"),
});

const BatchCheckParams = z.object({
  hostnames: z.array(z.string()).min(1).max(10).describe("Hostnames to check"),
});

function checkCert(hostname: string, port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.destroy();

      if (!cert || !cert.subject) {
        resolve({ hostname, error: "No certificate returned" });
        return;
      }

      const validFrom = new Date(cert.valid_from);
      const validTo = new Date(cert.valid_to);
      const now = new Date();
      const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);

      resolve({
        hostname,
        valid: authorized,
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: validFrom.toISOString(),
        validTo: validTo.toISOString(),
        daysUntilExpiry,
        expired: daysUntilExpiry < 0,
        expiringSoon: daysUntilExpiry > 0 && daysUntilExpiry <= 30,
        serialNumber: cert.serialNumber,
        fingerprint: cert.fingerprint,
        protocol: socket.getProtocol(),
        subjectAltNames: cert.subjectaltname?.split(", ").map((s: string) => s.replace("DNS:", "")) ?? [],
      });
    });

    socket.on("error", (err) => {
      resolve({ hostname, error: err.message });
    });

    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve({ hostname, error: "Connection timeout" });
    });
  });
}

const sslCheckerSkill: SkillDefinition = {
  name: "ssl_checker",
  version: "1.0.0",

  manifest: {
    id: "ssl_checker",
    name: "SSL Checker",
    description: "Check SSL/TLS certificates for expiry, validity, issuer, and chain information.",
    category: "analyze",
    tools: ["ssl_check", "ssl_batch_check"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "ssl_check",
      description: "Check SSL/TLS certificate for a hostname. Returns expiry, issuer, and validity info.",
      parameters: CheckParams,

      async execute(params) {
        const blocked = await checkTarget(params.hostname, params.port);
        if (blocked) return { hostname: params.hostname, error: blocked };
        return checkCert(params.hostname, params.port);
      },
    });

    ctx.registerTool({
      name: "ssl_batch_check",
      description: "Check SSL certificates for multiple hostnames at once.",
      parameters: BatchCheckParams,

      async execute(params) {
        const results = await Promise.all(
          params.hostnames.map(async (h): Promise<Record<string, unknown>> => {
            const blocked = await checkTarget(h, 443);
            return blocked ? { hostname: h, error: blocked } : checkCert(h, 443);
          }),
        );
        const expiring = results.filter((r) => r.expiringSoon || r.expired);
        return { count: results.length, expiringCount: expiring.length, results };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "ssl_checker",
      instructions: "You can check SSL certificates with `ssl_check` (single host) and `ssl_batch_check` (multiple hosts). Returns expiry, issuer, validity, and days until expiry.",
    };
  },
};

export default sslCheckerSkill;
