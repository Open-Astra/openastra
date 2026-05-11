import Typesense from "typesense";
import type { EnvConfig } from "./env.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("typesense");

let client: Typesense.Client | undefined;

/** Parse a comma-separated "host:port" list into Typesense node entries. */
function parseNodes(
  nodesEnv: string,
  protocol: string,
): Array<{ host: string; port: number; protocol: string }> {
  return nodesEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.lastIndexOf(":");
      if (colonIdx === -1) {
        return { host: entry, port: 8108, protocol };
      }
      const host = entry.slice(0, colonIdx);
      const port = parseInt(entry.slice(colonIdx + 1), 10);
      return { host, port: Number.isNaN(port) ? 8108 : port, protocol };
    });
}

export function initTypesense(env: EnvConfig): Typesense.Client {
  if (!client) {
    const nodesEnvVar = process.env.TYPESENSE_NODES;

    const nodes = nodesEnvVar
      ? parseNodes(nodesEnvVar, env.typesenseProtocol)
      : [
          {
            host: env.typesenseHost,
            port: env.typesensePort,
            protocol: env.typesenseProtocol,
          },
        ];

    if (nodesEnvVar) {
      log.active(`Typesense cluster mode: ${nodes.length} node(s) configured`);
    }

    client = new Typesense.Client({
      nodes,
      apiKey: env.typesenseApiKey,
      connectionTimeoutSeconds: 5,
      numRetries: 3,
      retryIntervalSeconds: 0.1,
    });
  }
  return client;
}

export function getTypesense(): Typesense.Client {
  if (!client) throw new Error("Typesense not initialized — call initTypesense()");
  return client;
}


// ── Collection Schema ───────────────────────────────────────────────
// One collection per user for memory isolation. The schema supports
// hybrid search: BM25 on `content` + vector similarity on `embedding`.

export const MEMORY_COLLECTION_SCHEMA = {
  fields: [
    { name: "uid", type: "string" as const, facet: true },
    { name: "content", type: "string" as const },
    { name: "source", type: "string" as const, facet: true }, // "daily" | "profile" | "session"
    { name: "category", type: "string" as const, facet: true, optional: true },
    { name: "date", type: "string" as const, optional: true }, // YYYY-MM-DD for daily entries
    { name: "timestamp", type: "int64" as const },
    {
      name: "embedding",
      type: "float[]" as const,
      embed: undefined, // we generate embeddings externally via Gemini
      num_dim: 768, // text-embedding-004 output dimension
    },
  ],
};

export async function ensureMemoryCollection(): Promise<void> {
  const ts = getTypesense();
  const name = "memory_chunks";

  try {
    await ts.collections(name).retrieve();
  } catch {
    // Collection doesn't exist — create it
    await ts.collections().create({
      name,
      fields: MEMORY_COLLECTION_SCHEMA.fields,
    });
    log.active(`Created collection`, name);
  }
}
