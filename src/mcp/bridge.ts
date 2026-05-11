import { z } from "zod";
import { registerTool } from "../tools/registry.js";
import { mcpManager, type McpServerConfig } from "./client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp-bridge");

// ── MCP → Astra Tool Bridge ─────────────────────────────────────────
// Connects to MCP servers declared in astra.yml and registers each
// discovered tool in Astra's tool registry so agents can call them
// the same way as built-in tools.

/**
 * Build a Zod schema from a JSON Schema object.
 * MCP tool input schemas are JSON Schema — we convert them to z.object()
 * for Astra's Zod-based validation layer. Unknown/complex types pass
 * through as z.unknown() so MCP tools with dynamic schemas still work.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (schema.type === "object") {
    const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    const required = new Set((schema.required as string[]) ?? []);
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, prop] of Object.entries(props)) {
      let field = propToZod(prop);
      if (prop.description) field = field.describe(prop.description as string);
      if (!required.has(key)) field = field.optional();
      shape[key] = field;
    }

    return z.object(shape).passthrough();
  }

  return z.record(z.string(), z.unknown());
}

function propToZod(prop: Record<string, unknown>): z.ZodTypeAny {
  switch (prop.type) {
    case "string":  return z.string();
    case "number":  return z.number();
    case "integer": return z.number().int();
    case "boolean": return z.boolean();
    case "array":   return z.array(z.unknown());
    case "object":  return jsonSchemaToZod(prop);
    default:        return z.unknown();
  }
}

/**
 * Connect to all configured MCP servers and register their tools.
 * Called once during gateway startup after tool discovery.
 */
export async function loadMcpServers(configs: McpServerConfig[]): Promise<void> {
  if (configs.length === 0) return;

  log.info(`Connecting to ${configs.length} MCP server(s)...`);

  await Promise.allSettled(configs.map((cfg) => mcpManager.connect(cfg)));

  const tools = mcpManager.getTools();

  for (const descriptor of tools) {
    const schema = jsonSchemaToZod(descriptor.inputSchema);

    registerTool({
      name: descriptor.astraName,
      description: `[MCP:${descriptor.serverName}] ${descriptor.description}`,
      parameters: schema as z.ZodObject<z.ZodRawShape>,
      async execute(params) {
        return mcpManager.callTool(descriptor.astraName, params as Record<string, unknown>);
      },
    });
  }

  log.info(`MCP bridge: ${tools.length} tools registered across ${configs.length} server(s)`);
}

/**
 * Gracefully shut down all MCP server connections.
 */
export async function stopMcpServers(): Promise<void> {
  await mcpManager.disconnectAll();
}
