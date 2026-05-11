import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp");

// ── Config Types ────────────────────────────────────────────────────

export interface McpStdioConfig {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  name: string;
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

// ── Tool Descriptor ─────────────────────────────────────────────────

export interface McpToolDescriptor {
  serverName: string;
  toolName: string;
  astraName: string;       // mcp:{serverName}:{toolName}
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── MCP Client Manager ──────────────────────────────────────────────

class McpClientManager {
  private clients = new Map<string, Client>();
  private tools = new Map<string, McpToolDescriptor>(); // astraName → descriptor

  async connect(config: McpServerConfig): Promise<void> {
    if (this.clients.has(config.name)) return;

    const client = new Client(
      { name: "astra-gateway", version: "1.0.0" },
      { capabilities: {} },
    );

    let transport;
    if (config.transport === "stdio") {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env
          ? { ...process.env, ...config.env } as Record<string, string>
          : undefined,
      });
    } else {
      const url = new URL(config.url);
      const headers = config.headers ?? {};

      // Prefer streamable-HTTP, fall back to SSE for legacy servers
      try {
        transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      } catch {
        transport = new SSEClientTransport(url);
      }
    }

    try {
      await client.connect(transport);
      this.clients.set(config.name, client);

      const { tools } = await client.listTools();
      for (const tool of tools) {
        const astraName = `mcp:${config.name}:${tool.name}`;
        this.tools.set(astraName, {
          serverName: config.name,
          toolName: tool.name,
          astraName,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        });
      }

      log.info(`MCP server "${config.name}" connected — ${tools.length} tools registered`);
    } catch (err) {
      log.error(`Failed to connect MCP server "${config.name}": ${err instanceof Error ? err.message : String(err)}`);
      this.clients.delete(config.name);
    }
  }

  async callTool(astraName: string, args: Record<string, unknown>): Promise<unknown> {
    const descriptor = this.tools.get(astraName);
    if (!descriptor) throw new Error(`MCP tool not found: ${astraName}`);

    const client = this.clients.get(descriptor.serverName);
    if (!client) throw new Error(`MCP server not connected: ${descriptor.serverName}`);

    const result = await client.callTool({
      name: descriptor.toolName,
      arguments: args,
    });

    // MCP content is an array of blocks — flatten to text for the agent
    const blocks = result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    if (result.isError) {
      const msg = blocks.map((b) => b.text ?? "").join("\n");
      throw new Error(`MCP tool error: ${msg}`);
    }

    if (blocks.length === 1 && blocks[0]?.type === "text") {
      return blocks[0].text;
    }

    return blocks.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image") return { type: "image", mimeType: b.mimeType, data: b.data };
      return b;
    });
  }

  getTools(): McpToolDescriptor[] {
    return [...this.tools.values()];
  }

  getToolDescriptor(astraName: string): McpToolDescriptor | undefined {
    return this.tools.get(astraName);
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
        log.dim(`MCP server "${name}" disconnected`);
      } catch { /* ignore close errors */ }
    }
    this.clients.clear();
    this.tools.clear();
  }
}

// Singleton
const manager = new McpClientManager();
export { manager as mcpManager };
