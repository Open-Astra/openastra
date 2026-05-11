import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";
import { createLogger } from "../utils/logger.js";

// ── RAG Document Upload & Retrieval ─────────────────────────────────
// Upload PDFs, text files, Markdown, and Obsidian vaults. Documents
// are chunked, embedded, and indexed for semantic retrieval during
// agent context assembly.
//
// Supported formats:
//   - PDF: parsed via pdf-parse
//   - Markdown / Obsidian: parsed directly, wiki-links resolved
//   - Plain text: chunked by paragraphs
//   - Notion export: JSON → Markdown conversion
//
// Pipeline: Upload → Parse → Chunk → Embed → Index → Retrieve

const log = createLogger("rag");

// ── Types ───────────────────────────────────────────────────────────

export type DocumentFormat = "pdf" | "markdown" | "text" | "notion" | "obsidian";

export interface Document {
  id: string;
  uid: string;
  workspaceId?: string;
  title: string;
  format: DocumentFormat;
  sourceUrl?: string;
  chunkCount: number;
  totalTokens: number;
  status: "processing" | "indexed" | "failed";
  createdAt: number;
  metadata: Record<string, unknown>;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  uid: string;
  index: number;              // chunk position in document
  content: string;
  heading?: string;           // nearest heading for context
  tokenEstimate: number;
  embedding?: number[];
}

export interface RAGSearchResult {
  chunk: DocumentChunk;
  document: Document;
  score: number;
}

export interface ChunkConfig {
  maxChunkTokens: number;     // max tokens per chunk (default: 512)
  overlapTokens: number;      // overlap between chunks (default: 64)
  minChunkTokens: number;     // skip chunks smaller than this (default: 20)
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxChunkTokens: 512,
  overlapTokens: 64,
  minChunkTokens: 20,
};

// ── Document Ingestion ──────────────────────────────────────────────

/**
 * Ingest a document: parse, chunk, embed, and index.
 */
export async function ingestDocument(
  uid: string,
  title: string,
  content: string,
  format: DocumentFormat,
  options: {
    workspaceId?: string;
    sourceUrl?: string;
    metadata?: Record<string, unknown>;
    chunkConfig?: Partial<ChunkConfig>;
  } = {},
): Promise<Document> {
  const docId = randomUUID();
  const config = { ...DEFAULT_CHUNK_CONFIG, ...options.chunkConfig };

  log.info(`Ingesting document: ${title} (${format}, ${content.length} chars)`);

  const doc: Document = {
    id: docId,
    uid,
    workspaceId: options.workspaceId,
    title,
    format,
    sourceUrl: options.sourceUrl,
    chunkCount: 0,
    totalTokens: 0,
    status: "processing",
    createdAt: Date.now(),
    metadata: options.metadata ?? {},
  };

  await persistDocument(doc);

  try {
    // Parse based on format
    const parsedContent = await parseDocument(content, format);

    // Chunk the content
    const chunks = chunkText(parsedContent, config);
    doc.chunkCount = chunks.length;
    doc.totalTokens = chunks.reduce((s, c) => s + c.tokenEstimate, 0);

    // Embed and index chunks
    for (const chunk of chunks) {
      chunk.documentId = docId;
      chunk.uid = uid;

      try {
        const embedding = await generateEmbedding(chunk.content);
        chunk.embedding = embedding;
      } catch {
        // Continue without embedding — keyword search still works
      }

      await persistChunk(chunk);
    }

    doc.status = "indexed";
    await persistDocument(doc);

    log.info(`Indexed ${doc.chunkCount} chunks from "${title}" (${doc.totalTokens} tokens)`);
    return doc;
  } catch (err) {
    doc.status = "failed";
    await persistDocument(doc);
    log.error(`Failed to ingest "${title}":`, err);
    throw err;
  }
}

/**
 * Ingest a PDF from a Buffer.
 */
export async function ingestPDF(
  uid: string,
  title: string,
  pdfBuffer: Buffer,
  options: Parameters<typeof ingestDocument>[4] = {},
): Promise<Document> {
  let pdfParse: typeof import("pdf-parse");
  try {
    pdfParse = await import("pdf-parse");
  } catch {
    throw new Error("pdf-parse not installed. Run: npm install pdf-parse");
  }

  const parsed = await (pdfParse as any).default(pdfBuffer);
  return ingestDocument(uid, title, parsed.text, "pdf", {
    ...options,
    metadata: {
      ...options.metadata,
      pages: parsed.numpages,
      pdfInfo: parsed.info,
    },
  });
}

/**
 * Ingest an Obsidian vault directory (array of {path, content} entries).
 */
export async function ingestObsidianVault(
  uid: string,
  files: Array<{ path: string; content: string }>,
  options: Parameters<typeof ingestDocument>[4] = {},
): Promise<Document[]> {
  const docs: Document[] = [];

  // Build wiki-link index for cross-referencing
  const fileIndex = new Map<string, string>();
  for (const file of files) {
    const name = file.path.replace(/\.md$/, "").split("/").pop() ?? file.path;
    fileIndex.set(name.toLowerCase(), file.path);
  }

  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;

    // Resolve wiki-links [[Page Name]] → inline references
    const resolvedContent = file.content.replace(
      /\[\[([^\]]+)\]\]/g,
      (_match, linkText: string) => {
        const target = fileIndex.get(linkText.toLowerCase());
        return target ? `[${linkText}](${target})` : linkText;
      },
    );

    const title = file.path.replace(/\.md$/, "").split("/").pop() ?? file.path;
    const doc = await ingestDocument(uid, title, resolvedContent, "obsidian", {
      ...options,
      sourceUrl: file.path,
      metadata: { ...options.metadata, vaultPath: file.path },
    });
    docs.push(doc);
  }

  log.info(`Ingested Obsidian vault: ${docs.length} documents`);
  return docs;
}

// ── Search ──────────────────────────────────────────────────────────

/**
 * Semantic search across all user documents.
 */
export async function searchDocuments(
  uid: string,
  query: string,
  limit: number = 5,
  workspaceId?: string,
  precomputedEmbedding?: number[],
): Promise<RAGSearchResult[]> {
  const pool = getPool();

  let embedding: number[] | null = null;
  try {
    embedding = precomputedEmbedding ?? await generateEmbedding(query);
  } catch {
    // Fallback to keyword search
  }

  if (embedding) {
    // Vector search
    const { rows } = await pool.query<{
      chunk_id: string;
      document_id: string;
      content: string;
      heading: string | null;
      chunk_index: number;
      token_estimate: number;
      score: number;
      doc_title: string;
      doc_format: string;
      doc_metadata: Record<string, unknown>;
    }>(
      `SELECT dc.id as chunk_id, dc.document_id, dc.content, dc.heading,
              dc.chunk_index, dc.token_estimate,
              1 - (dc.embedding <=> $1::vector) as score,
              d.title as doc_title, d.format as doc_format, d.metadata as doc_metadata
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id
       WHERE dc.uid = $2 AND d.status = 'indexed'
       ${workspaceId ? "AND d.workspace_id = $4" : ""}
       ORDER BY dc.embedding <=> $1::vector
       LIMIT $3`,
      workspaceId ? [JSON.stringify(embedding), uid, limit, workspaceId] : [JSON.stringify(embedding), uid, limit],
    );

    return rows.map((r) => ({
      chunk: {
        id: r.chunk_id,
        documentId: r.document_id,
        uid,
        index: r.chunk_index,
        content: r.content,
        heading: r.heading ?? undefined,
        tokenEstimate: r.token_estimate,
      },
      document: {
        id: r.document_id,
        uid,
        title: r.doc_title,
        format: r.doc_format as DocumentFormat,
        chunkCount: 0,
        totalTokens: 0,
        status: "indexed" as const,
        createdAt: 0,
        metadata: r.doc_metadata,
      },
      score: r.score,
    }));
  }

  // Keyword fallback
  const { rows } = await pool.query<{
    chunk_id: string;
    document_id: string;
    content: string;
    heading: string | null;
    chunk_index: number;
    token_estimate: number;
    doc_title: string;
    doc_format: string;
    doc_metadata: Record<string, unknown>;
  }>(
    `SELECT dc.id as chunk_id, dc.document_id, dc.content, dc.heading,
            dc.chunk_index, dc.token_estimate,
            d.title as doc_title, d.format as doc_format, d.metadata as doc_metadata
     FROM document_chunks dc
     JOIN documents d ON d.id = dc.document_id
     WHERE dc.uid = $1 AND d.status = 'indexed' AND dc.content ILIKE $2
     ${workspaceId ? "AND d.workspace_id = $3" : ""}
     LIMIT $${workspaceId ? "4" : "3"}`,
    workspaceId ? [uid, `%${query}%`, workspaceId, limit] : [uid, `%${query}%`, limit],
  );

  return rows.map((r, i) => ({
    chunk: {
      id: r.chunk_id,
      documentId: r.document_id,
      uid,
      index: r.chunk_index,
      content: r.content,
      heading: r.heading ?? undefined,
      tokenEstimate: r.token_estimate,
    },
    document: {
      id: r.document_id,
      uid,
      title: r.doc_title,
      format: r.doc_format as DocumentFormat,
      chunkCount: 0,
      totalTokens: 0,
      status: "indexed" as const,
      createdAt: 0,
      metadata: r.doc_metadata,
    },
    score: 0.5 - i * 0.05, // rough relevance ordering
  }));
}

/**
 * List all documents for a user.
 */
export async function listDocuments(
  uid: string,
  workspaceId?: string,
): Promise<Document[]> {
  const pool = getPool();
  const { rows } = await pool.query<{ config: Document }>(
    `SELECT config FROM documents WHERE uid = $1 ${workspaceId ? "AND workspace_id = $2" : ""}
     ORDER BY created_at DESC`,
    workspaceId ? [uid, workspaceId] : [uid],
  );
  return rows.map((r) => r.config);
}

/**
 * Delete a document and all its chunks.
 */
export async function deleteDocument(uid: string, documentId: string): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM document_chunks WHERE document_id = $1 AND uid = $2", [documentId, uid]);
  await pool.query("DELETE FROM documents WHERE id = $1 AND uid = $2", [documentId, uid]);
}

// ── Document Parsing ────────────────────────────────────────────────

async function parseDocument(content: string, format: DocumentFormat): Promise<string> {
  switch (format) {
    case "pdf":
      // Already parsed by pdf-parse before reaching here
      return content;
    case "markdown":
    case "obsidian":
      return content;
    case "text":
      return content;
    case "notion":
      return parseNotionExport(content);
    default:
      return content;
  }
}

function parseNotionExport(content: string): string {
  // Notion exports as JSON with blocks — convert to Markdown
  try {
    const data = JSON.parse(content) as {
      results?: Array<{
        type: string;
        [key: string]: unknown;
      }>;
    };

    if (!data.results) return content;

    const lines: string[] = [];
    for (const block of data.results) {
      switch (block.type) {
        case "paragraph":
          lines.push(extractRichText(block.paragraph as any));
          break;
        case "heading_1":
          lines.push(`# ${extractRichText(block.heading_1 as any)}`);
          break;
        case "heading_2":
          lines.push(`## ${extractRichText(block.heading_2 as any)}`);
          break;
        case "heading_3":
          lines.push(`### ${extractRichText(block.heading_3 as any)}`);
          break;
        case "bulleted_list_item":
          lines.push(`- ${extractRichText(block.bulleted_list_item as any)}`);
          break;
        case "numbered_list_item":
          lines.push(`1. ${extractRichText(block.numbered_list_item as any)}`);
          break;
        case "code":
          lines.push(`\`\`\`\n${extractRichText(block.code as any)}\n\`\`\``);
          break;
        default:
          break;
      }
    }
    return lines.join("\n\n");
  } catch {
    return content;
  }
}

function extractRichText(block: { rich_text?: Array<{ plain_text: string }> }): string {
  return block?.rich_text?.map((rt) => rt.plain_text).join("") ?? "";
}

// ── Chunking ────────────────────────────────────────────────────────

function chunkText(content: string, config: ChunkConfig): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  const maxChars = config.maxChunkTokens * 4; // ~4 chars per token
  const overlapChars = config.overlapTokens * 4;
  const minChars = config.minChunkTokens * 4;

  // Split by headings first for better chunks
  const sections = splitByHeadings(content);

  for (const section of sections) {
    const paragraphs = section.content.split(/\n\n+/);
    let currentChunk = "";
    let currentHeading = section.heading;

    for (const para of paragraphs) {
      if (currentChunk.length + para.length > maxChars && currentChunk.length > minChars) {
        chunks.push({
          id: randomUUID(),
          documentId: "",
          uid: "",
          index: chunks.length,
          content: currentChunk.trim(),
          heading: currentHeading,
          tokenEstimate: Math.ceil(currentChunk.length / 4),
        });

        // Keep overlap
        const overlapStart = Math.max(0, currentChunk.length - overlapChars);
        currentChunk = currentChunk.slice(overlapStart) + "\n\n" + para;
      } else {
        currentChunk += (currentChunk ? "\n\n" : "") + para;
      }
    }

    // Remaining content
    if (currentChunk.trim().length > minChars) {
      chunks.push({
        id: randomUUID(),
        documentId: "",
        uid: "",
        index: chunks.length,
        content: currentChunk.trim(),
        heading: currentHeading,
        tokenEstimate: Math.ceil(currentChunk.length / 4),
      });
    }
  }

  return chunks;
}

function splitByHeadings(content: string): Array<{ heading?: string; content: string }> {
  const headingRegex = /^(#{1,3})\s+(.+)$/gm;
  const sections: Array<{ heading?: string; content: string }> = [];
  let lastIndex = 0;
  let lastHeading: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      sections.push({
        heading: lastHeading,
        content: content.slice(lastIndex, match.index),
      });
    }
    lastHeading = match[2];
    lastIndex = match.index;
  }

  // Remaining content
  sections.push({
    heading: lastHeading,
    content: content.slice(lastIndex),
  });

  return sections.filter((s) => s.content.trim().length > 0);
}

// ── Persistence ─────────────────────────────────────────────────────

async function persistDocument(doc: Document): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO documents (id, uid, workspace_id, title, format, status, config, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET status = $6, config = $7::jsonb`,
    [doc.id, doc.uid, doc.workspaceId ?? null, doc.title, doc.format, doc.status, JSON.stringify(doc)],
  );
}

async function persistChunk(chunk: DocumentChunk): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO document_chunks (id, document_id, uid, chunk_index, content, heading, token_estimate, embedding, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      chunk.id,
      chunk.documentId,
      chunk.uid,
      chunk.index,
      chunk.content,
      chunk.heading ?? null,
      chunk.tokenEstimate,
      chunk.embedding ? JSON.stringify(chunk.embedding) : null,
    ],
  );
}
