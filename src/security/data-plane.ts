import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("data-plane");

// ── Egress-Only Data Plane ────────────────────────────────────────────
// Enforces outbound-only networking with data classification and DLP.
// The agent runtime NEVER accepts inbound connections from the internet —
// all communication is initiated outbound. This module:
//   - Classifies data before it leaves the system
//   - Applies DLP rules to prevent sensitive data leakage
//   - Maintains an allowlist of permitted egress destinations
//   - Logs all outbound data flows for audit
//   - Enforces per-tenant egress policies

// ── Types ────────────────────────────────────────────────────────────

export type DataClassification = "public" | "internal" | "confidential" | "restricted" | "pii" | "phi" | "pci";

export type EgressDecision = "allow" | "block" | "redact" | "encrypt";

export interface EgressRequest {
  id: string;
  tenantId: string;
  workspaceId: string;
  agentId: string;
  destination: string;
  protocol: "https" | "grpc" | "smtp" | "webhook";
  method: string;
  payloadSize: number;
  dataClassifications: DataClassification[];
  decision: EgressDecision;
  policyId?: string;
  blockedReason?: string;
  redactedFields?: string[];
  timestamp: string;
}

export interface EgressPolicy {
  id: string;
  tenantId: string;
  name: string;
  rules: EgressRule[];
  allowedDestinations: DestinationRule[];
  dlpRules: DlpRule[];
  enabled: boolean;
  createdAt: string;
}

export interface EgressRule {
  priority: number;
  condition: {
    dataClassification?: DataClassification[];
    destinationPattern?: string;
    protocol?: string;
    maxPayloadBytes?: number;
    agentId?: string;
  };
  action: EgressDecision;
  reason: string;
}

export interface DestinationRule {
  pattern: string;
  protocols: string[];
  maxRequestsPerMinute: number;
  requireEncryption: boolean;
  allowedDataClassifications: DataClassification[];
}

export interface DlpRule {
  id: string;
  name: string;
  pattern: string;
  type: "regex" | "keyword" | "ner";
  classification: DataClassification;
  action: "redact" | "block" | "flag";
  replacement?: string;
}

export interface DataFlowLog {
  id: string;
  tenantId: string;
  agentId: string;
  destination: string;
  direction: "egress";
  payloadSize: number;
  classifications: DataClassification[];
  decision: EgressDecision;
  timestamp: string;
}

// ── Default DLP Patterns ────────────────────────────────────────────

const DEFAULT_DLP_RULES: DlpRule[] = [
  { id: "ssn", name: "US Social Security Number", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", type: "regex", classification: "pii", action: "redact", replacement: "[SSN-REDACTED]" },
  { id: "credit-card", name: "Credit Card Number", pattern: "\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\\b", type: "regex", classification: "pci", action: "redact", replacement: "[CARD-REDACTED]" },
  { id: "email-pii", name: "Email Address (PII context)", pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", type: "regex", classification: "pii", action: "flag" },
  { id: "api-key", name: "API Key Pattern", pattern: "\\b(sk|pk|api)[-_][a-zA-Z0-9]{20,}\\b", type: "regex", classification: "restricted", action: "block" },
  { id: "aws-key", name: "AWS Access Key", pattern: "\\bAKIA[0-9A-Z]{16}\\b", type: "regex", classification: "restricted", action: "block" },
  { id: "private-key", name: "Private Key Header", pattern: "-----BEGIN (RSA |EC )?PRIVATE KEY-----", type: "regex", classification: "restricted", action: "block" },
  { id: "phone-us", name: "US Phone Number", pattern: "\\b(?:\\+1)?[- .]?\\(?\\d{3}\\)?[- .]?\\d{3}[- .]?\\d{4}\\b", type: "regex", classification: "pii", action: "redact", replacement: "[PHONE-REDACTED]" },
  { id: "ip-internal", name: "Internal IP Address", pattern: "\\b(?:10\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)\\d{1,3}\\.\\d{1,3}\\b", type: "regex", classification: "internal", action: "flag" },
];

// ── Data Plane Manager ────────────────────────────────────────────────

export class DataPlaneManager {
  async evaluateEgress(params: {
    tenantId: string;
    workspaceId: string;
    agentId: string;
    destination: string;
    protocol: "https" | "grpc" | "smtp" | "webhook";
    method: string;
    payload: string;
  }): Promise<EgressRequest> {
    const id = randomUUID();

    // Classify data in payload
    const classifications = this.classifyData(params.payload);

    // Get tenant policy
    const policy = await this.getPolicy(params.tenantId);

    // Evaluate against policy
    const { decision, reason, redactedFields } = this.evaluatePolicy(
      policy,
      params.destination,
      params.protocol,
      classifications,
      params.payload.length,
      params.agentId,
    );

    const request: EgressRequest = {
      id,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      destination: params.destination,
      protocol: params.protocol,
      method: params.method,
      payloadSize: params.payload.length,
      dataClassifications: classifications,
      decision,
      policyId: policy?.id,
      blockedReason: decision === "block" ? reason : undefined,
      redactedFields,
      timestamp: new Date().toISOString(),
    };

    // Log the egress attempt
    await this.logDataFlow(request);

    // Emit events
    const bus = getEventBus();
    if (decision === "block") {
      bus.emit("security.egress_blocked", {
        tenantId: params.tenantId,
        agentId: params.agentId,
        destination: params.destination,
        reason,
      });
      logger.warn(`Egress blocked: ${params.agentId} → ${params.destination}: ${reason}`);
    } else if (decision === "redact") {
      bus.emit("security.egress_redacted", {
        tenantId: params.tenantId,
        destination: params.destination,
        redactedFields: redactedFields ?? [],
      });
    }

    return request;
  }

  applyDlp(payload: string, tenantId?: string): { sanitized: string; redactions: string[]; blocked: boolean; blockReason?: string } {
    let sanitized = payload;
    const redactions: string[] = [];
    let blocked = false;
    let blockReason: string | undefined;

    const rules = DEFAULT_DLP_RULES;

    for (const rule of rules) {
      if (rule.type !== "regex") continue;

      const regex = new RegExp(rule.pattern, "gi");
      const matches = sanitized.match(regex);

      if (matches && matches.length > 0) {
        if (rule.action === "block") {
          blocked = true;
          blockReason = `DLP rule '${rule.name}' triggered — ${rule.classification} data detected`;
          break;
        }
        if (rule.action === "redact" && rule.replacement) {
          sanitized = sanitized.replace(regex, rule.replacement);
          redactions.push(`${rule.name}: ${matches.length} occurrence(s) redacted`);
        }
        if (rule.action === "flag") {
          redactions.push(`${rule.name}: ${matches.length} occurrence(s) flagged`);
        }
      }
    }

    return { sanitized, redactions, blocked, blockReason };
  }

  classifyData(content: string): DataClassification[] {
    const classifications = new Set<DataClassification>();

    for (const rule of DEFAULT_DLP_RULES) {
      if (rule.type !== "regex") continue;
      const regex = new RegExp(rule.pattern, "i");
      if (regex.test(content)) {
        classifications.add(rule.classification);
      }
    }

    if (classifications.size === 0) {
      classifications.add("internal");
    }

    return [...classifications];
  }

  // ── Policy Management ─────────────────────────────────────────────

  async createPolicy(params: {
    tenantId: string;
    name: string;
    rules: EgressRule[];
    allowedDestinations: DestinationRule[];
    dlpRules?: DlpRule[];
  }): Promise<EgressPolicy> {
    const pool = getPool();
    const id = randomUUID();
    const policy: EgressPolicy = {
      id,
      tenantId: params.tenantId,
      name: params.name,
      rules: params.rules,
      allowedDestinations: params.allowedDestinations,
      dlpRules: params.dlpRules ?? DEFAULT_DLP_RULES,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO egress_policies (id, tenant_id, name, rules, allowed_destinations, dlp_rules, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, params.tenantId, params.name, JSON.stringify(params.rules), JSON.stringify(params.allowedDestinations), JSON.stringify(policy.dlpRules), true],
    );

    return policy;
  }

  async getPolicy(tenantId: string): Promise<EgressPolicy | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM egress_policies WHERE tenant_id = $1 AND enabled = true ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    return this.rowToPolicy(rows[0]);
  }

  // ── Destination Management ────────────────────────────────────────

  async addAllowedDestination(tenantId: string, rule: DestinationRule): Promise<void> {
    const policy = await this.getPolicy(tenantId);
    if (!policy) {
      await this.createPolicy({
        tenantId,
        name: "default",
        rules: [],
        allowedDestinations: [rule],
      });
      return;
    }

    const pool = getPool();
    policy.allowedDestinations.push(rule);
    await pool.query(
      `UPDATE egress_policies SET allowed_destinations = $1 WHERE id = $2`,
      [JSON.stringify(policy.allowedDestinations), policy.id],
    );
  }

  async getDataFlowLogs(tenantId: string, limit = 100): Promise<DataFlowLog[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM data_flow_logs WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      agentId: r.agent_id as string,
      destination: r.destination as string,
      direction: "egress" as const,
      payloadSize: r.payload_size as number,
      classifications: typeof r.classifications === "string" ? JSON.parse(r.classifications) : r.classifications as DataClassification[],
      decision: r.decision as EgressDecision,
      timestamp: String(r.timestamp),
    }));
  }

  // ── Internal ──────────────────────────────────────────────────────

  private evaluatePolicy(
    policy: EgressPolicy | null,
    destination: string,
    protocol: string,
    classifications: DataClassification[],
    payloadSize: number,
    agentId: string,
  ): { decision: EgressDecision; reason: string; redactedFields?: string[] } {
    if (!policy) {
      // Default: allow with DLP check
      return { decision: "allow", reason: "No policy configured — default allow" };
    }

    // Check destination allowlist
    const destAllowed = policy.allowedDestinations.some((d) => {
      const pattern = new RegExp(d.pattern.replace(/\*/g, ".*"));
      return pattern.test(destination) && d.protocols.includes(protocol);
    });

    if (!destAllowed && policy.allowedDestinations.length > 0) {
      return { decision: "block", reason: `Destination ${destination} not in allowlist` };
    }

    // Check destination-specific classification restrictions
    for (const destRule of policy.allowedDestinations) {
      const pattern = new RegExp(destRule.pattern.replace(/\*/g, ".*"));
      if (pattern.test(destination)) {
        const disallowed = classifications.filter((c) => !destRule.allowedDataClassifications.includes(c));
        if (disallowed.length > 0) {
          return { decision: "block", reason: `Data classification(s) ${disallowed.join(", ")} not allowed for ${destination}` };
        }
      }
    }

    // Evaluate explicit rules (sorted by priority)
    const sortedRules = [...policy.rules].sort((a, b) => a.priority - b.priority);
    for (const rule of sortedRules) {
      const matches = this.matchesCondition(rule.condition, destination, protocol, classifications, payloadSize, agentId);
      if (matches) {
        return { decision: rule.action, reason: rule.reason };
      }
    }

    return { decision: "allow", reason: "No matching rule — default allow" };
  }

  private matchesCondition(
    condition: EgressRule["condition"],
    destination: string,
    protocol: string,
    classifications: DataClassification[],
    payloadSize: number,
    agentId: string,
  ): boolean {
    if (condition.agentId && condition.agentId !== agentId) return false;
    if (condition.protocol && condition.protocol !== protocol) return false;
    if (condition.maxPayloadBytes && payloadSize > condition.maxPayloadBytes) return true;
    if (condition.destinationPattern) {
      const pattern = new RegExp(condition.destinationPattern);
      if (!pattern.test(destination)) return false;
    }
    if (condition.dataClassification) {
      const hasMatch = condition.dataClassification.some((c) => classifications.includes(c));
      if (!hasMatch) return false;
    }
    return true;
  }

  private async logDataFlow(request: EgressRequest): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO data_flow_logs (id, tenant_id, agent_id, destination, direction, payload_size, classifications, decision, timestamp)
       VALUES ($1, $2, $3, $4, 'egress', $5, $6, $7, $8)`,
      [request.id, request.tenantId, request.agentId, request.destination, request.payloadSize, JSON.stringify(request.dataClassifications), request.decision, request.timestamp],
    );
  }

  private rowToPolicy(row: Record<string, unknown>): EgressPolicy {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      rules: typeof row.rules === "string" ? JSON.parse(row.rules) : row.rules as EgressRule[],
      allowedDestinations: typeof row.allowed_destinations === "string" ? JSON.parse(row.allowed_destinations) : row.allowed_destinations as DestinationRule[],
      dlpRules: typeof row.dlp_rules === "string" ? JSON.parse(row.dlp_rules) : row.dlp_rules as DlpRule[],
      enabled: row.enabled as boolean,
      createdAt: String(row.created_at),
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: DataPlaneManager | null = null;

export function getDataPlaneManager(): DataPlaneManager {
  if (!instance) instance = new DataPlaneManager();
  return instance;
}
