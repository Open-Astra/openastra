// ── YAML Config Transforms ──────────────────────────────────────────
// Post-parse transform pipeline for astra.yml. Four transforms run in
// order, each a no-op when its keys are absent:
//
//   parseYaml() → resolveIncludes() → expandToolGroups()
//                → applyDefaults() → expandTemplates()
//
// This lets us express similar agents via templates with ~6 lines
// instead of duplicating config, while remaining fully backward compatible.

import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";

// ── Helpers ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Deep Merge ──────────────────────────────────────────────────────
// Rules:
//   - Objects: recurse
//   - Arrays: replace (unless items have + prefix → append)
//   - null value: removes key
//   - Scalars: override

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete result[key];
      continue;
    }

    if (Array.isArray(value)) {
      const hasAppend = value.some(
        (v) => typeof v === "string" && v.startsWith("+"),
      );
      if (hasAppend && Array.isArray(result[key])) {
        // Append mode: strip + prefix, add to existing array
        const existing = result[key] as unknown[];
        const newItems = value.map((v) =>
          typeof v === "string" && v.startsWith("+") ? v.slice(1) : v,
        );
        result[key] = [...existing, ...newItems];
      } else {
        result[key] = value;
      }
      continue;
    }

    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
      continue;
    }

    result[key] = value;
  }

  return result;
}

// ── Template Variable Interpolation ─────────────────────────────────
// %{var}         — simple replacement
// %{var|upper}   — with filter (upper, lower, capitalize)

export function interpolateTemplateVars(
  value: unknown,
  vars: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      /%\{(\w+)(?:\|(\w+))?\}/g,
      (_match, name: string, filter?: string) => {
        const val = vars[name] ?? "";
        if (filter === "upper") return val.toUpperCase();
        if (filter === "lower") return val.toLowerCase();
        if (filter === "capitalize")
          return val.charAt(0).toUpperCase() + val.slice(1);
        return val;
      },
    );
  }

  if (Array.isArray(value)) {
    return value.map((v) => interpolateTemplateVars(v, vars));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = interpolateTemplateVars(k, vars) as string;
      result[newKey] = interpolateTemplateVars(v, vars);
    }
    return result;
  }

  return value;
}

// ── Walk helper ─────────────────────────────────────────────────────

function walkAndTransform(
  value: unknown,
  transform: (v: unknown) => unknown,
): unknown {
  const transformed = transform(value);
  if (transformed !== value) return transformed;

  if (Array.isArray(value)) {
    return value.map((v) => walkAndTransform(v, transform));
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = walkAndTransform(v, transform);
    }
    return result;
  }

  return value;
}

// ── 1. !include resolver ────────────────────────────────────────────
// Replaces string values starting with "!include " with the contents
// of the referenced file. Paths are relative to the astra.yml dir.
// No absolute paths or ../ traversal allowed.

const INCLUDE_PREFIX = "!include ";

export function resolveIncludes(
  config: Record<string, unknown>,
  basePath: string,
): Record<string, unknown> {
  return walkAndTransform(config, (value) => {
    if (typeof value === "string" && value.startsWith(INCLUDE_PREFIX)) {
      const relPath = value.slice(INCLUDE_PREFIX.length).trim();
      const normalized = normalize(relPath);
      if (normalized.startsWith("..") || normalized.startsWith("/")) {
        throw new Error(
          `!include path must be relative and cannot traverse up: ${relPath}`,
        );
      }
      const fullPath = join(basePath, normalized);
      return readFileSync(fullPath, "utf-8").trimEnd();
    }
    return value;
  }) as Record<string, unknown>;
}

// ── 2. Tool group expander ──────────────────────────────────────────
// Resolves $groupName references in tool allow/deny arrays.
// Consumes and removes the top-level `toolGroups` key.

export function expandToolGroups(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const toolGroups = config.toolGroups as
    | Record<string, string[]>
    | undefined;
  if (!toolGroups) return config;

  const result = { ...config };
  delete result.toolGroups;

  const expandArray = (arr: unknown[]): unknown[] => {
    const expanded: unknown[] = [];
    for (const item of arr) {
      if (typeof item === "string" && item.startsWith("$")) {
        const groupName = item.slice(1);
        const group = toolGroups[groupName];
        if (group) {
          expanded.push(...group);
        } else {
          expanded.push(item); // keep as-is if group not found
        }
      } else {
        expanded.push(item);
      }
    }
    return expanded;
  };

  const expandToolsIn = (
    block: Record<string, unknown>,
  ): Record<string, unknown> => {
    const b = { ...block };
    if (isPlainObject(b.tools)) {
      const tools = { ...(b.tools as Record<string, unknown>) };
      if (Array.isArray(tools.allow)) tools.allow = expandArray(tools.allow);
      if (Array.isArray(tools.deny)) tools.deny = expandArray(tools.deny);
      b.tools = tools;
    }
    return b;
  };

  // Expand in defaults
  if (isPlainObject(result.defaults)) {
    result.defaults = expandToolsIn(
      result.defaults as Record<string, unknown>,
    );
  }

  // Expand in agents
  if (isPlainObject(result.agents)) {
    const agents = { ...(result.agents as Record<string, unknown>) };
    for (const [id, agent] of Object.entries(agents)) {
      if (isPlainObject(agent)) {
        agents[id] = expandToolsIn(agent);
      }
    }
    result.agents = agents;
  }

  // Expand in templates
  if (isPlainObject(result.templates)) {
    const templates = { ...(result.templates as Record<string, unknown>) };
    for (const [id, tmpl] of Object.entries(templates)) {
      if (isPlainObject(tmpl)) {
        templates[id] = expandToolsIn(tmpl);
      }
    }
    result.templates = templates;
  }

  return result;
}

// ── 3. Defaults applier ─────────────────────────────────────────────
// Deep-merges `defaults` into every agent (and template). Agent/template
// values always override defaults. Consumes the `defaults` key.

export function applyDefaults(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = config.defaults as Record<string, unknown> | undefined;
  if (!defaults) return config;

  const result = { ...config };
  delete result.defaults;

  if (isPlainObject(result.agents)) {
    const agents = { ...(result.agents as Record<string, unknown>) };
    for (const [id, agent] of Object.entries(agents)) {
      if (isPlainObject(agent)) {
        agents[id] = deepMerge(defaults, agent);
      }
    }
    result.agents = agents;
  }

  // Also apply to templates so template-derived agents get defaults
  if (isPlainObject(result.templates)) {
    const templates = { ...(result.templates as Record<string, unknown>) };
    for (const [id, tmpl] of Object.entries(templates)) {
      if (isPlainObject(tmpl)) {
        templates[id] = deepMerge(defaults, tmpl);
      }
    }
    result.templates = templates;
  }

  return result;
}

// ── 4. Template expander ────────────────────────────────────────────
// Handles $extends, $each, and %{var} interpolation.
// Consumes the `templates` key.

export function expandTemplates(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const templates = config.templates as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (!templates && !hasExtends(config)) return config;

  const result = { ...config };
  delete result.templates;

  if (!isPlainObject(result.agents)) return result;

  const agents = { ...(result.agents as Record<string, unknown>) };
  const expanded: Record<string, unknown> = {};

  for (const [pattern, agentDef] of Object.entries(agents)) {
    if (!isPlainObject(agentDef)) {
      expanded[pattern] = agentDef;
      continue;
    }

    const def = agentDef as Record<string, unknown>;
    const extendsName = def.$extends as string | undefined;
    const eachDef = def.$each as Record<string, unknown> | undefined;

    if (!extendsName && !eachDef) {
      expanded[pattern] = agentDef;
      continue;
    }

    // Get template base
    const templateBase =
      extendsName && templates?.[extendsName]
        ? { ...templates[extendsName] }
        : {};

    // Strip meta keys from agent def
    const overrides: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def)) {
      if (k !== "$extends" && k !== "$each") {
        overrides[k] = v;
      }
    }

    if (eachDef) {
      // $each expansion — generate one agent per value
      const entries = Object.entries(eachDef);
      if (entries.length === 0) {
        expanded[pattern] = agentDef;
        continue;
      }

      const [varName, values] = entries[0]!;
      if (!Array.isArray(values)) {
        expanded[pattern] = agentDef;
        continue;
      }

      for (const val of values) {
        const strVal = String(val);
        const vars: Record<string, string> = { [varName]: strVal };

        // Merge template base + overrides, then interpolate
        const merged = deepMerge(templateBase, overrides);
        const interpolated = interpolateTemplateVars(
          merged,
          vars,
        ) as Record<string, unknown>;

        // Generate agent ID from pattern
        const agentId = pattern.replace(
          /%\{(\w+)(?:\|\w+)?\}/g,
          (_match, name: string) => vars[name] ?? "",
        );

        expanded[agentId] = interpolated;
      }
    } else {
      // Simple $extends without $each
      expanded[pattern] = deepMerge(templateBase, overrides);
    }
  }

  result.agents = expanded;
  return result;
}

function hasExtends(config: Record<string, unknown>): boolean {
  if (!isPlainObject(config.agents)) return false;
  return Object.values(config.agents as Record<string, unknown>).some(
    (a) => isPlainObject(a) && ("$extends" in a || "$each" in a),
  );
}

// ── Full Transform Pipeline ─────────────────────────────────────────

export function applyTransforms(
  config: Record<string, unknown>,
  basePath: string,
): Record<string, unknown> {
  let result = config;
  result = resolveIncludes(result, basePath);
  result = expandToolGroups(result);
  result = expandTemplates(result);
  result = applyDefaults(result);
  return result;
}
