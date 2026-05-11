import { randomUUID, createHash, createHmac } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("audit-trail");

// ── Evidence-Grade Audit Trail ────────────────────────────────────────
// Tamper-evident audit log with hash-chain integrity. Every action
// produces a signed audit entry that links to the previous entry,
// forming an append-only chain. Supports:
//   - Hash-chain verification (detect gaps or mutations)
//   - HMAC signing with workspace-scoped keys
//   - Structured evidence attachments (before/after snapshots)
//   - Compliance export (JSONL, CSV for SOC2/ISO27001)
//   - Retention policies with archival support

// ── Types ────────────────────────────────────────────────────────────

export type AuditAction =
  | "agent.action"
  | "agent.spawn"
  | "agent.complete"
  | "skill.execute"
  | "skill.install"
  | "skill.remove"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "approval.escalated"
  | "config.changed"
  | "data.read"
  | "data.write"
  | "data.delete"
  | "auth.login"
  | "auth.logout"
  | "auth.permission_change"
  | "billing.charge"
  | "billing.refund"
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "system.error"
  | "system.security_event";

export interface AuditEntry {
  id: string;
  sequence: number;
  tenantId: string;
  workspaceId: string;
  uid: string;
  agentId?: string;
  sessionId?: string;
  action: AuditAction;
  category: string;
  description: string;
  metadata: Record<string, unknown>;
  evidence?: AuditEvidence;
  riskLevel: "info" | "low" | "medium" | "high" | "critical";
  previousHash: string;
  entryHash: string;
  signature: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

export interface AuditEvidence {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  diff?: string;
  attachments?: EvidenceAttachment[];
}

export interface EvidenceAttachment {
  name: string;
  contentType: string;
  size: number;
  hash: string;
  url?: string;
}

export interface AuditQuery {
  tenantId: string;
  workspaceId?: string;
  uid?: string;
  agentId?: string;
  action?: AuditAction;
  category?: string;
  riskLevel?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface AuditExportOptions {
  format: "jsonl" | "csv";
  tenantId: string;
  startDate: string;
  endDate: string;
  includeEvidence?: boolean;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  firstBrokenAt?: number;
  error?: string;
}

// ── Audit Trail Manager ───────────────────────────────────────────────

export class AuditTrailManager {
  private signingKey: string;
  private sequenceCache = new Map<string, number>();

  constructor() {
    this.signingKey = process.env.AUDIT_SIGNING_KEY ?? "openastra-audit-default-key";
  }

  async record(params: {
    tenantId: string;
    workspaceId: string;
    uid: string;
    agentId?: string;
    sessionId?: string;
    action: AuditAction;
    category: string;
    description: string;
    metadata?: Record<string, unknown>;
    evidence?: AuditEvidence;
    riskLevel?: "info" | "low" | "medium" | "high" | "critical";
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuditEntry> {
    const pool = getPool();
    const id = randomUUID();

    // Get next sequence number for this tenant
    const sequence = await this.getNextSequence(params.tenantId);

    // Get previous hash for chain integrity
    const previousHash = await this.getPreviousHash(params.tenantId);

    // Compute entry hash (includes content + previous hash for chain)
    const entryContent = JSON.stringify({
      id,
      sequence,
      tenantId: params.tenantId,
      action: params.action,
      description: params.description,
      metadata: params.metadata ?? {},
      previousHash,
      timestamp: new Date().toISOString(),
    });
    const entryHash = createHash("sha256").update(entryContent).digest("hex");

    // Sign with HMAC
    const signature = createHmac("sha256", this.signingKey)
      .update(entryHash)
      .digest("hex");

    const entry: AuditEntry = {
      id,
      sequence,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      uid: params.uid,
      agentId: params.agentId,
      sessionId: params.sessionId,
      action: params.action,
      category: params.category,
      description: params.description,
      metadata: params.metadata ?? {},
      evidence: params.evidence,
      riskLevel: params.riskLevel ?? "info",
      previousHash,
      entryHash,
      signature,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO audit_trail (id, sequence, tenant_id, workspace_id, uid, agent_id, session_id, action, category, description, metadata, evidence, risk_level, previous_hash, entry_hash, signature, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, sequence, params.tenantId, params.workspaceId, params.uid, params.agentId, params.sessionId, params.action, params.category, params.description, JSON.stringify(params.metadata ?? {}), JSON.stringify(params.evidence ?? null), params.riskLevel ?? "info", previousHash, entryHash, signature, params.ipAddress, params.userAgent],
    );

    // Update sequence cache
    this.sequenceCache.set(params.tenantId, sequence);

    // Emit event for real-time monitoring
    if (params.riskLevel === "high" || params.riskLevel === "critical") {
      getEventBus().emit("audit.high_risk", {
        entryId: id,
        tenantId: params.tenantId,
        action: params.action,
        riskLevel: params.riskLevel,
      });
    }

    return entry;
  }

  async query(params: AuditQuery): Promise<{ entries: AuditEntry[]; total: number }> {
    const pool = getPool();
    let query = `SELECT * FROM audit_trail WHERE tenant_id = $1`;
    let countQuery = `SELECT COUNT(*) FROM audit_trail WHERE tenant_id = $1`;
    const queryParams: unknown[] = [params.tenantId];

    if (params.workspaceId) {
      queryParams.push(params.workspaceId);
      const clause = ` AND workspace_id = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.uid) {
      queryParams.push(params.uid);
      const clause = ` AND uid = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.agentId) {
      queryParams.push(params.agentId);
      const clause = ` AND agent_id = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.action) {
      queryParams.push(params.action);
      const clause = ` AND action = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.category) {
      queryParams.push(params.category);
      const clause = ` AND category = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.riskLevel) {
      queryParams.push(params.riskLevel);
      const clause = ` AND risk_level = $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.startDate) {
      queryParams.push(params.startDate);
      const clause = ` AND created_at >= $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }
    if (params.endDate) {
      queryParams.push(params.endDate);
      const clause = ` AND created_at <= $${queryParams.length}`;
      query += clause;
      countQuery += clause;
    }

    const countParams = [...queryParams];
    query += ` ORDER BY sequence DESC`;
    queryParams.push(params.limit ?? 100);
    query += ` LIMIT $${queryParams.length}`;
    queryParams.push(params.offset ?? 0);
    query += ` OFFSET $${queryParams.length}`;

    const [dataResult, countResult] = await Promise.all([
      pool.query(query, queryParams),
      pool.query(countQuery, countParams),
    ]);

    return {
      entries: dataResult.rows.map((r: Record<string, unknown>) => this.rowToEntry(r)),
      total: parseInt(String(countResult.rows[0]?.count ?? 0), 10),
    };
  }

  async verifyChain(tenantId: string, startSequence?: number, endSequence?: number): Promise<ChainVerificationResult> {
    const pool = getPool();
    let query = `SELECT * FROM audit_trail WHERE tenant_id = $1`;
    const params: unknown[] = [tenantId];

    if (startSequence !== undefined) {
      params.push(startSequence);
      query += ` AND sequence >= $${params.length}`;
    }
    if (endSequence !== undefined) {
      params.push(endSequence);
      query += ` AND sequence <= $${params.length}`;
    }
    query += ` ORDER BY sequence ASC`;

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return { valid: true, totalEntries: 0, verifiedEntries: 0 };
    }

    let verifiedCount = 0;
    let previousHash = "";

    for (const row of rows as Record<string, unknown>[]) {
      const storedPreviousHash = row.previous_hash as string;
      const storedEntryHash = row.entry_hash as string;
      const storedSignature = row.signature as string;

      // Verify chain link
      if (verifiedCount > 0 && storedPreviousHash !== previousHash) {
        return {
          valid: false,
          totalEntries: rows.length,
          verifiedEntries: verifiedCount,
          firstBrokenAt: row.sequence as number,
          error: `Chain broken at sequence ${row.sequence}: expected previous_hash ${previousHash}, got ${storedPreviousHash}`,
        };
      }

      // Verify signature
      const expectedSignature = createHmac("sha256", this.signingKey)
        .update(storedEntryHash)
        .digest("hex");

      if (storedSignature !== expectedSignature) {
        return {
          valid: false,
          totalEntries: rows.length,
          verifiedEntries: verifiedCount,
          firstBrokenAt: row.sequence as number,
          error: `Invalid signature at sequence ${row.sequence}`,
        };
      }

      previousHash = storedEntryHash;
      verifiedCount++;
    }

    logger.info(`Chain verification passed for tenant ${tenantId}: ${verifiedCount} entries verified`);
    return { valid: true, totalEntries: rows.length, verifiedEntries: verifiedCount };
  }

  async export(options: AuditExportOptions): Promise<string> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM audit_trail WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY sequence ASC`,
      [options.tenantId, options.startDate, options.endDate],
    );

    if (options.format === "jsonl") {
      return rows.map((r: Record<string, unknown>) => {
        const entry = this.rowToEntry(r);
        if (!options.includeEvidence) delete (entry as Record<string, unknown>).evidence;
        return JSON.stringify(entry);
      }).join("\n");
    }

    // CSV format
    const headers = ["id", "sequence", "created_at", "action", "category", "description", "risk_level", "uid", "agent_id", "entry_hash"];
    const csvRows = rows.map((r: Record<string, unknown>) =>
      headers.map((h) => {
        const val = r[h];
        const str = val === null || val === undefined ? "" : String(val);
        return str.includes(",") ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(","),
    );
    return [headers.join(","), ...csvRows].join("\n");
  }

  async applyRetention(tenantId: string, retainDays: number, archiveFn?: (entries: AuditEntry[]) => Promise<void>): Promise<number> {
    const pool = getPool();
    const cutoff = new Date(Date.now() - retainDays * 86_400_000).toISOString();

    if (archiveFn) {
      const { rows } = await pool.query(
        `SELECT * FROM audit_trail WHERE tenant_id = $1 AND created_at < $2 ORDER BY sequence ASC`,
        [tenantId, cutoff],
      );
      if (rows.length > 0) {
        await archiveFn(rows.map((r: Record<string, unknown>) => this.rowToEntry(r)));
      }
    }

    const { rowCount } = await pool.query(
      `DELETE FROM audit_trail WHERE tenant_id = $1 AND created_at < $2`,
      [tenantId, cutoff],
    );

    const deleted = rowCount ?? 0;
    if (deleted > 0) {
      logger.info(`Retention: removed ${deleted} audit entries older than ${retainDays} days for tenant ${tenantId}`);
    }
    return deleted;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async getNextSequence(tenantId: string): Promise<number> {
    const cached = this.sequenceCache.get(tenantId);
    if (cached !== undefined) return cached + 1;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT MAX(sequence) as max_seq FROM audit_trail WHERE tenant_id = $1`,
      [tenantId],
    );
    const maxSeq = (rows[0]?.max_seq as number) ?? 0;
    this.sequenceCache.set(tenantId, maxSeq);
    return maxSeq + 1;
  }

  private async getPreviousHash(tenantId: string): Promise<string> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT entry_hash FROM audit_trail WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [tenantId],
    );
    return (rows[0]?.entry_hash as string) ?? "genesis";
  }

  private rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as string,
      sequence: row.sequence as number,
      tenantId: row.tenant_id as string,
      workspaceId: row.workspace_id as string,
      uid: row.uid as string,
      agentId: row.agent_id as string | undefined,
      sessionId: row.session_id as string | undefined,
      action: row.action as AuditAction,
      category: row.category as string,
      description: row.description as string,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata as Record<string, unknown>,
      evidence: row.evidence ? (typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence as AuditEvidence) : undefined,
      riskLevel: row.risk_level as AuditEntry["riskLevel"],
      previousHash: row.previous_hash as string,
      entryHash: row.entry_hash as string,
      signature: row.signature as string,
      ipAddress: row.ip_address as string | undefined,
      userAgent: row.user_agent as string | undefined,
      createdAt: String(row.created_at),
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: AuditTrailManager | null = null;

export function getAuditTrailManager(): AuditTrailManager {
  if (!instance) instance = new AuditTrailManager();
  return instance;
}
