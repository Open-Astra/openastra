import { randomUUID, createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";
import type { SkillManifest } from "./types.js";

const logger = createLogger("signed-registry");

// ── Signed Skill Registry ─────────────────────────────────────────────
// Supply-chain security for skills. Every skill published to the registry
// is signed with the publisher's key. Before execution, signatures are
// verified to ensure integrity. Supports:
//   - RSA signature verification on skill packages
//   - Publisher identity and trust levels
//   - Version pinning and immutable releases
//   - Vulnerability scanning metadata
//   - Dependency graph validation
//   - Allowlist/blocklist per tenant

// ── Types ────────────────────────────────────────────────────────────

export type TrustLevel = "untrusted" | "community" | "verified" | "official";
export type SkillStatus = "draft" | "published" | "deprecated" | "revoked";

export interface SkillPackage {
  id: string;
  skillId: string;
  version: string;
  publisherId: string;
  manifest: SkillManifest;
  sourceHash: string;
  signature: string;
  trustLevel: TrustLevel;
  status: SkillStatus;
  dependencies: SkillDependency[];
  securityMetadata: SecurityMetadata;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDependency {
  skillId: string;
  versionConstraint: string;
  optional: boolean;
}

export interface SecurityMetadata {
  lastScanAt?: string;
  vulnerabilities: VulnerabilityReport[];
  permissions: string[];
  networkAccess: boolean;
  fileSystemAccess: boolean;
  dataClassification: "public" | "internal" | "confidential" | "restricted";
}

export interface VulnerabilityReport {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  fixedInVersion?: string;
  reportedAt: string;
}

export interface Publisher {
  id: string;
  name: string;
  publicKey: string;
  trustLevel: TrustLevel;
  verified: boolean;
  skillCount: number;
  createdAt: string;
}

export interface TenantSkillPolicy {
  tenantId: string;
  allowedTrustLevels: TrustLevel[];
  allowedPublishers: string[];
  blockedSkills: string[];
  requireSignatureVerification: boolean;
  maxVulnerabilitySeverity: "low" | "medium" | "high" | "critical";
  autoUpdateMinor: boolean;
  pinnedVersions: Record<string, string>;
}

export interface InstallationRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  skillId: string;
  version: string;
  packageId: string;
  installedBy: string;
  pinnedVersion: boolean;
  installedAt: string;
}

// ── Signed Registry Manager ───────────────────────────────────────────

export class SignedSkillRegistry {
  async publish(params: {
    skillId: string;
    version: string;
    publisherId: string;
    manifest: SkillManifest;
    sourceCode: string;
    privateKey: string;
    dependencies?: SkillDependency[];
    securityMetadata?: Partial<SecurityMetadata>;
  }): Promise<SkillPackage> {
    const pool = getPool();

    // Check for duplicate version
    const existing = await this.getPackage(params.skillId, params.version);
    if (existing && existing.status === "published") {
      throw new Error(`Version ${params.version} of ${params.skillId} is already published (immutable)`);
    }

    // Compute source hash
    const sourceHash = createHash("sha256").update(params.sourceCode).digest("hex");

    // Sign the package content
    const signContent = JSON.stringify({
      skillId: params.skillId,
      version: params.version,
      sourceHash,
      manifest: params.manifest,
    });

    const signer = createSign("RSA-SHA256");
    signer.update(signContent);
    const signature = signer.sign(params.privateKey, "hex");

    // Get publisher trust level
    const publisher = await this.getPublisher(params.publisherId);
    const trustLevel = publisher?.trustLevel ?? "untrusted";

    const id = randomUUID();
    const pkg: SkillPackage = {
      id,
      skillId: params.skillId,
      version: params.version,
      publisherId: params.publisherId,
      manifest: params.manifest,
      sourceHash,
      signature,
      trustLevel,
      status: "published",
      dependencies: params.dependencies ?? [],
      securityMetadata: {
        vulnerabilities: [],
        permissions: params.manifest.tools,
        networkAccess: false,
        fileSystemAccess: false,
        dataClassification: "internal",
        ...params.securityMetadata,
      },
      downloads: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO skill_packages (id, skill_id, version, publisher_id, manifest, source_hash, signature, trust_level, status, dependencies, security_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, params.skillId, params.version, params.publisherId, JSON.stringify(params.manifest), sourceHash, signature, trustLevel, "published", JSON.stringify(pkg.dependencies), JSON.stringify(pkg.securityMetadata)],
    );

    getEventBus().emit("skill.published", { skillId: params.skillId, version: params.version, publisherId: params.publisherId });
    logger.info(`Published ${params.skillId}@${params.version} by ${params.publisherId}`);
    return pkg;
  }

  async verify(skillId: string, version: string): Promise<{ valid: boolean; error?: string }> {
    const pkg = await this.getPackage(skillId, version);
    if (!pkg) return { valid: false, error: "Package not found" };

    if (pkg.status === "revoked") return { valid: false, error: "Package has been revoked" };

    const publisher = await this.getPublisher(pkg.publisherId);
    if (!publisher) return { valid: false, error: "Publisher not found" };

    // Verify signature
    const signContent = JSON.stringify({
      skillId: pkg.skillId,
      version: pkg.version,
      sourceHash: pkg.sourceHash,
      manifest: pkg.manifest,
    });

    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signContent);
      const valid = verifier.verify(publisher.publicKey, pkg.signature, "hex");

      if (!valid) return { valid: false, error: "Signature verification failed" };
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async install(params: {
    tenantId: string;
    workspaceId: string;
    skillId: string;
    version?: string;
    installedBy: string;
  }): Promise<InstallationRecord> {
    const pool = getPool();

    // Get tenant policy
    const policy = await this.getTenantPolicy(params.tenantId);

    // Resolve version (latest if not specified)
    const version = params.version ?? await this.getLatestVersion(params.skillId);
    if (!version) throw new Error(`No published version found for ${params.skillId}`);

    const pkg = await this.getPackage(params.skillId, version);
    if (!pkg) throw new Error(`Package not found: ${params.skillId}@${version}`);

    // Policy checks
    if (policy) {
      if (policy.blockedSkills.includes(params.skillId)) {
        throw new Error(`Skill ${params.skillId} is blocked by tenant policy`);
      }
      if (!policy.allowedTrustLevels.includes(pkg.trustLevel)) {
        throw new Error(`Trust level '${pkg.trustLevel}' not allowed (policy requires: ${policy.allowedTrustLevels.join(", ")})`);
      }
      if (policy.allowedPublishers.length > 0 && !policy.allowedPublishers.includes(pkg.publisherId)) {
        throw new Error(`Publisher '${pkg.publisherId}' not in allowlist`);
      }

      // Check vulnerability policy
      const maxSeverity = policy.maxVulnerabilitySeverity;
      const severityOrder = ["low", "medium", "high", "critical"];
      const maxIdx = severityOrder.indexOf(maxSeverity);
      const hasBlockingVuln = pkg.securityMetadata.vulnerabilities.some(
        (v) => severityOrder.indexOf(v.severity) > maxIdx,
      );
      if (hasBlockingVuln) {
        throw new Error(`Package has vulnerabilities exceeding policy threshold (${maxSeverity})`);
      }

      // Verify signature if required
      if (policy.requireSignatureVerification) {
        const verification = await this.verify(params.skillId, version);
        if (!verification.valid) {
          throw new Error(`Signature verification failed: ${verification.error}`);
        }
      }
    }

    // Validate dependencies
    await this.validateDependencies(pkg.dependencies, params.tenantId, params.workspaceId);

    const id = randomUUID();
    const record: InstallationRecord = {
      id,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
      skillId: params.skillId,
      version,
      packageId: pkg.id,
      installedBy: params.installedBy,
      pinnedVersion: policy?.pinnedVersions[params.skillId] === version,
      installedAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO skill_installations (id, tenant_id, workspace_id, skill_id, version, package_id, installed_by, pinned_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, workspace_id, skill_id) DO UPDATE SET version = $5, package_id = $6, installed_by = $7, updated_at = NOW()`,
      [id, params.tenantId, params.workspaceId, params.skillId, version, pkg.id, params.installedBy, record.pinnedVersion],
    );

    // Increment download count
    await pool.query(`UPDATE skill_packages SET downloads = downloads + 1 WHERE id = $1`, [pkg.id]);

    getEventBus().emit("skill.installed", {
      skillId: params.skillId,
      version,
      tenantId: params.tenantId,
      workspaceId: params.workspaceId,
    });

    logger.info(`Installed ${params.skillId}@${version} for tenant ${params.tenantId}`);
    return record;
  }

  async revoke(skillId: string, version: string, reason: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE skill_packages SET status = 'revoked', updated_at = NOW() WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    getEventBus().emit("skill.revoked", { skillId, version, reason });
    logger.warn(`Revoked ${skillId}@${version}: ${reason}`);
  }

  async deprecate(skillId: string, version: string, successor?: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE skill_packages SET status = 'deprecated', updated_at = NOW() WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    logger.info(`Deprecated ${skillId}@${version}${successor ? ` → ${successor}` : ""}`);
  }

  // ── Publisher Management ──────────────────────────────────────────

  async registerPublisher(params: {
    name: string;
    publicKey?: string;
  }): Promise<Publisher> {
    const pool = getPool();
    const id = randomUUID();

    // Generate key pair if not provided
    let publicKey = params.publicKey;
    if (!publicKey) {
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      publicKey = keyPair.publicKey;
    }

    const publisher: Publisher = {
      id,
      name: params.name,
      publicKey,
      trustLevel: "community",
      verified: false,
      skillCount: 0,
      createdAt: new Date().toISOString(),
    };

    await pool.query(
      `INSERT INTO skill_publishers (id, name, public_key, trust_level, verified)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, params.name, publicKey, "community", false],
    );

    return publisher;
  }

  async getPublisher(id: string): Promise<Publisher | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM skill_publishers WHERE id = $1`, [id]);
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      name: row.name as string,
      publicKey: row.public_key as string,
      trustLevel: row.trust_level as TrustLevel,
      verified: row.verified as boolean,
      skillCount: row.skill_count as number ?? 0,
      createdAt: String(row.created_at),
    };
  }

  // ── Policy Management ─────────────────────────────────────────────

  async setTenantPolicy(policy: TenantSkillPolicy): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO tenant_skill_policies (tenant_id, allowed_trust_levels, allowed_publishers, blocked_skills, require_signature, max_vuln_severity, auto_update_minor, pinned_versions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id) DO UPDATE SET
         allowed_trust_levels = $2, allowed_publishers = $3, blocked_skills = $4,
         require_signature = $5, max_vuln_severity = $6, auto_update_minor = $7, pinned_versions = $8, updated_at = NOW()`,
      [policy.tenantId, JSON.stringify(policy.allowedTrustLevels), JSON.stringify(policy.allowedPublishers), JSON.stringify(policy.blockedSkills), policy.requireSignatureVerification, policy.maxVulnerabilitySeverity, policy.autoUpdateMinor, JSON.stringify(policy.pinnedVersions)],
    );
  }

  async getTenantPolicy(tenantId: string): Promise<TenantSkillPolicy | null> {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM tenant_skill_policies WHERE tenant_id = $1`, [tenantId]);
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      tenantId: row.tenant_id as string,
      allowedTrustLevels: JSON.parse(String(row.allowed_trust_levels)),
      allowedPublishers: JSON.parse(String(row.allowed_publishers)),
      blockedSkills: JSON.parse(String(row.blocked_skills)),
      requireSignatureVerification: row.require_signature as boolean,
      maxVulnerabilitySeverity: row.max_vuln_severity as TenantSkillPolicy["maxVulnerabilitySeverity"],
      autoUpdateMinor: row.auto_update_minor as boolean,
      pinnedVersions: JSON.parse(String(row.pinned_versions)),
    };
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getPackage(skillId: string, version: string): Promise<SkillPackage | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM skill_packages WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    if (rows.length === 0) return null;
    return this.rowToPackage(rows[0]);
  }

  async search(query: string, filters?: { category?: string; trustLevel?: TrustLevel; limit?: number }): Promise<SkillPackage[]> {
    const pool = getPool();
    let sql = `SELECT * FROM skill_packages WHERE status = 'published' AND (skill_id ILIKE $1 OR manifest->>'name' ILIKE $1 OR manifest->>'description' ILIKE $1)`;
    const params: unknown[] = [`%${query}%`];

    if (filters?.trustLevel) {
      params.push(filters.trustLevel);
      sql += ` AND trust_level = $${params.length}`;
    }
    sql += ` ORDER BY downloads DESC LIMIT $${params.length + 1}`;
    params.push(filters?.limit ?? 50);

    const { rows } = await pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => this.rowToPackage(r));
  }

  async getInstalledSkills(tenantId: string, workspaceId: string): Promise<InstallationRecord[]> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM skill_installations WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY installed_at DESC`,
      [tenantId, workspaceId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      workspaceId: r.workspace_id as string,
      skillId: r.skill_id as string,
      version: r.version as string,
      packageId: r.package_id as string,
      installedBy: r.installed_by as string,
      pinnedVersion: r.pinned_version as boolean,
      installedAt: String(r.installed_at),
    }));
  }

  // ── Internal ──────────────────────────────────────────────────────

  private async getLatestVersion(skillId: string): Promise<string | null> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT version FROM skill_packages WHERE skill_id = $1 AND status = 'published' ORDER BY created_at DESC LIMIT 1`,
      [skillId],
    );
    return rows.length > 0 ? (rows[0].version as string) : null;
  }

  private async validateDependencies(deps: SkillDependency[], tenantId: string, workspaceId: string): Promise<void> {
    for (const dep of deps) {
      if (dep.optional) continue;
      const installed = await this.getInstalledSkills(tenantId, workspaceId);
      const hasDep = installed.some((i) => i.skillId === dep.skillId);
      if (!hasDep) {
        throw new Error(`Missing required dependency: ${dep.skillId} (${dep.versionConstraint})`);
      }
    }
  }

  private rowToPackage(row: Record<string, unknown>): SkillPackage {
    return {
      id: row.id as string,
      skillId: row.skill_id as string,
      version: row.version as string,
      publisherId: row.publisher_id as string,
      manifest: typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest as SkillManifest,
      sourceHash: row.source_hash as string,
      signature: row.signature as string,
      trustLevel: row.trust_level as TrustLevel,
      status: row.status as SkillStatus,
      dependencies: typeof row.dependencies === "string" ? JSON.parse(row.dependencies) : row.dependencies as SkillDependency[],
      securityMetadata: typeof row.security_metadata === "string" ? JSON.parse(row.security_metadata) : row.security_metadata as SecurityMetadata,
      downloads: (row.downloads as number) ?? 0,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: SignedSkillRegistry | null = null;

export function getSignedSkillRegistry(): SignedSkillRegistry {
  if (!instance) instance = new SignedSkillRegistry();
  return instance;
}
