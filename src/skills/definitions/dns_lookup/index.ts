import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import * as dns from "node:dns/promises";
import { isBlockedIp } from "../../../utils/ssrf-guard.js";

// The gateway's resolver can see split-horizon / cluster DNS. These tools
// must not become a way to enumerate internal names and addresses.
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|corp|home|svc|cluster\.local|in-addr\.arpa|ip6\.arpa)\.?$/i;
const VALID_DOMAIN = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;

function publicOnly(ips: string[]): string[] {
  return ips.filter((ip) => !isBlockedIp(ip));
}

// ── DNS Lookup Skill ────────────────────────────────────────────────
// DNS record lookups: A, AAAA, MX, TXT, CNAME, NS, SOA.
// Uses Node.js built-in dns module.

const LookupParams = z.object({
  domain: z.string().describe("Domain name to look up"),
  types: z.array(z.enum(["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA"])).default(["A", "AAAA", "MX", "TXT"]).describe("Record types to query"),
});

const ReverseLookupParams = z.object({
  ip: z.string().describe("IP address to reverse lookup"),
});

const dnsLookupSkill: SkillDefinition = {
  name: "dns_lookup",
  version: "1.0.0",

  manifest: {
    id: "dns_lookup",
    name: "DNS Lookup",
    description: "DNS record lookups for A, AAAA, MX, TXT, CNAME, NS, SOA records and reverse lookups.",
    category: "analyze",
    tools: ["dns_query", "dns_reverse"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "dns_query",
      description: "Query DNS records for a domain. Returns A, AAAA, MX, TXT, CNAME, NS, and/or SOA records.",
      parameters: LookupParams,

      async execute(params) {
        if (!VALID_DOMAIN.test(params.domain) || INTERNAL_NAME.test(params.domain)) {
          return { domain: params.domain, error: "Only public DNS names can be queried." };
        }
        const results: Record<string, unknown> = { domain: params.domain };

        for (const type of params.types) {
          try {
            switch (type) {
              case "A":
                results.A = publicOnly(await dns.resolve4(params.domain));
                break;
              case "AAAA":
                results.AAAA = publicOnly(await dns.resolve6(params.domain));
                break;
              case "MX":
                results.MX = (await dns.resolveMx(params.domain)).sort((a, b) => a.priority - b.priority);
                break;
              case "TXT":
                results.TXT = (await dns.resolveTxt(params.domain)).map((r) => r.join(""));
                break;
              case "CNAME":
                results.CNAME = await dns.resolveCname(params.domain);
                break;
              case "NS":
                results.NS = await dns.resolveNs(params.domain);
                break;
              case "SOA":
                results.SOA = await dns.resolveSoa(params.domain);
                break;
            }
          } catch (err) {
            results[type] = { error: err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err) };
          }
        }

        return results;
      },
    });

    ctx.registerTool({
      name: "dns_reverse",
      description: "Reverse DNS lookup: find hostnames for an IP address.",
      parameters: ReverseLookupParams,

      async execute(params) {
        if (isBlockedIp(params.ip)) {
          return { ip: params.ip, error: "Reverse lookups are limited to public IP addresses." };
        }
        try {
          const hostnames = await dns.reverse(params.ip);
          return { ip: params.ip, hostnames };
        } catch (err) {
          return { ip: params.ip, error: err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.message : String(err) };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "dns_lookup",
      instructions: "You can query DNS with `dns_query` (A, AAAA, MX, TXT, CNAME, NS, SOA records) and `dns_reverse` (reverse IP lookup). Uses Node.js built-in dns module.",
    };
  },
};

export default dnsLookupSkill;
