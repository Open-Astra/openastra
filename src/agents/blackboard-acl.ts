// ── Blackboard Namespaces & ACLs (Feature 14) ───────────────────────
// Partition the blackboard into typed namespaces with per-agent
// read/write permissions. Prevents noisy agents from polluting
// shared state.

// ── Types ────────────────────────────────────────────────────────────

export interface NamespaceACL {
  /** Dot-separated namespace pattern (e.g., "research.findings", "research.*", "*") */
  namespace: string;
  /** Role IDs allowed to read, or ["*"] for all */
  allowRead: string[];
  /** Role IDs allowed to write, or ["*"] for all */
  allowWrite: string[];
}

export interface BlackboardNamespaceConfig {
  namespaces: NamespaceACL[];
  defaultPolicy: "open" | "restricted";
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ── Default Config ───────────────────────────────────────────────────

export const DEFAULT_NAMESPACE_CONFIG: BlackboardNamespaceConfig = {
  namespaces: [],
  defaultPolicy: "open",
};

// ── Namespace Matching ───────────────────────────────────────────────
// Supports: exact match, wildcard "*" (match everything),
// and glob "research.*" (match any child of research).

export function matchNamespace(pattern: string, target: string): boolean {
  if (pattern === "*") return true;
  if (pattern === target) return true;

  // Glob matching: "research.*" matches "research.findings", "research.sources"
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return target === prefix || target.startsWith(prefix + ".");
  }

  // Prefix matching: "research" matches "research.findings"
  if (target.startsWith(pattern + ".")) return true;

  return false;
}

// ── Permission Checks ────────────────────────────────────────────────

export function checkReadPermission(
  config: BlackboardNamespaceConfig,
  namespace: string,
  agentRole: string,
): PermissionResult {
  // Find matching ACL rule (most specific match wins)
  const rule = findBestMatch(config.namespaces, namespace);

  if (!rule) {
    // No matching rule — fall back to default policy
    if (config.defaultPolicy === "open") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `No ACL rule for namespace "${namespace}" and default policy is "restricted"`,
    };
  }

  if (rule.allowRead.includes("*") || rule.allowRead.includes(agentRole)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role "${agentRole}" does not have read access to namespace "${namespace}". Allowed: [${rule.allowRead.join(", ")}]`,
  };
}

export function checkWritePermission(
  config: BlackboardNamespaceConfig,
  namespace: string,
  agentRole: string,
): PermissionResult {
  const rule = findBestMatch(config.namespaces, namespace);

  if (!rule) {
    if (config.defaultPolicy === "open") {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `No ACL rule for namespace "${namespace}" and default policy is "restricted"`,
    };
  }

  if (rule.allowWrite.includes("*") || rule.allowWrite.includes(agentRole)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role "${agentRole}" does not have write access to namespace "${namespace}". Allowed: [${rule.allowWrite.join(", ")}]`,
  };
}

// ── Best Match Selection ─────────────────────────────────────────────
// More specific patterns take precedence over wildcards.

function findBestMatch(rules: NamespaceACL[], namespace: string): NamespaceACL | null {
  let best: NamespaceACL | null = null;
  let bestSpecificity = -1;

  for (const rule of rules) {
    if (!matchNamespace(rule.namespace, namespace)) continue;

    const specificity = getSpecificity(rule.namespace);
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      best = rule;
    }
  }

  return best;
}

function getSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith(".*")) return pattern.split(".").length;
  return pattern.split(".").length + 1; // exact match is most specific
}

// ── Auto-Generate ACL from Roles ─────────────────────────────────────

export function createSwarmACL(
  roles: Array<{ roleId: string }>,
): BlackboardNamespaceConfig {
  const ROLE_WRITE_NAMESPACES: Record<string, string> = {
    researcher: "research.*",
    analyst: "analysis.*",
    writer: "synthesis.*",
    validator: "validation.*",
    mediator: "*",
  };

  const namespaces: NamespaceACL[] = [];
  const roleIds = roles.map((r) => r.roleId);

  for (const role of roles) {
    const writeNs = ROLE_WRITE_NAMESPACES[role.roleId];
    if (writeNs && writeNs !== "*") {
      namespaces.push({
        namespace: writeNs,
        allowRead: ["*"],
        allowWrite: [role.roleId, "mediator"],
      });
    }
  }

  // Global read access + mediator write access
  namespaces.push({
    namespace: "*",
    allowRead: ["*"],
    allowWrite: roleIds.includes("mediator") ? ["mediator"] : [],
  });

  return {
    namespaces,
    defaultPolicy: "restricted",
  };
}

// ── Validation ───────────────────────────────────────────────────────

export function validateNamespaceConfig(
  config: BlackboardNamespaceConfig,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const ns of config.namespaces) {
    if (!ns.namespace || ns.namespace.trim() === "") {
      errors.push("Namespace pattern cannot be empty");
    }

    if (ns.allowRead.length === 0 && ns.allowWrite.length === 0) {
      errors.push(`Namespace "${ns.namespace}" has no read or write permissions defined`);
    }

    // Check for contradictions: write without read
    for (const writer of ns.allowWrite) {
      if (writer === "*") continue;
      if (!ns.allowRead.includes("*") && !ns.allowRead.includes(writer)) {
        errors.push(
          `Namespace "${ns.namespace}": role "${writer}" has write but no read access`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
