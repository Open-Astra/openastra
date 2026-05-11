import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "../memory/embeddings.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";

// ── codebase_index ─────────────────────────────────────────────────
// Walk a repository, extract symbols, generate embeddings, and upsert
// into the codebase_index table for semantic code search.

const MAX_FILES = 500;
const MAX_EMBED_CHARS = 2000;

const DEFAULT_INCLUDE = /\.(ts|js|tsx|jsx|py|go|rs|java|rb|c|cpp|h|hpp)$/;

const Params = z.object({
  repoPath: z.string().describe("Path to repository root"),
  include: z
    .array(z.string())
    .optional()
    .describe("Glob patterns to include (default: common source files)"),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Glob patterns to exclude"),
});

// ── Symbol extraction regexes per language ──────────────────────────

const SYMBOL_EXTRACTORS: Record<string, RegExp[]> = {
  typescript: [
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
  ],
  javascript: [
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g,
  ],
  python: [/^(?:def|class)\s+(\w+)/gm],
  go: [/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm, /^type\s+(\w+)/gm],
  rust: [/(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+(\w+)/g],
  java: [
    /(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum)\s+(\w+)/g,
    /(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/g,
  ],
  ruby: [/(?:def|class|module)\s+(\w+)/g],
  c: [
    /^(?:static\s+)?(?:inline\s+)?[\w*]+\s+(\w+)\s*\(/gm,
    /^typedef\s+(?:struct|enum|union)\s+(\w+)/gm,
    /^struct\s+(\w+)/gm,
  ],
  cpp: [
    /^(?:static\s+)?(?:inline\s+)?(?:virtual\s+)?[\w:*&<>]+\s+(\w+)\s*\(/gm,
    /^(?:class|struct|enum)\s+(\w+)/gm,
    /^namespace\s+(\w+)/gm,
  ],
};

// Map file extensions to language names
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
};

function extractSymbols(content: string, language: string): string[] {
  const extractors = SYMBOL_EXTRACTORS[language];
  if (!extractors) return [];

  const symbols: string[] = [];
  for (const regex of extractors) {
    // Reset regex state for each call
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[1] && !symbols.includes(match[1])) {
        symbols.push(match[1]);
      }
    }
  }
  return symbols;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function matchesGlob(filePath: string, pattern: string): boolean {
  // Simple glob matching: supports * and **
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(filePath);
}

async function loadGitignore(repoPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(repoPath, ".gitignore"), "utf-8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function isIgnored(relativePath: string, gitignorePatterns: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const pattern of gitignorePatterns) {
    // Direct match
    if (normalized.includes(pattern.replace(/^\//, ""))) return true;
    // Glob match
    if (matchesGlob(normalized, pattern)) return true;
  }
  return false;
}

async function walkFiles(
  dir: string,
  rootDir: string,
  gitignorePatterns: string[],
  includePatterns: string[] | undefined,
  excludePatterns: string[] | undefined,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_FILES) return;

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;

    const fullPath = join(dir, entry.name);
    const relPath = relative(rootDir, fullPath);

    // Always skip common non-source directories
    if (
      entry.isDirectory() &&
      [
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        "__pycache__",
        ".venv",
        "venv",
        "target",
        "vendor",
        ".cache",
        "coverage",
      ].includes(entry.name)
    ) {
      continue;
    }

    // Check gitignore
    if (isIgnored(relPath, gitignorePatterns)) continue;

    if (entry.isDirectory()) {
      await walkFiles(
        fullPath,
        rootDir,
        gitignorePatterns,
        includePatterns,
        excludePatterns,
        results,
      );
    } else if (entry.isFile()) {
      // Check exclude patterns
      if (excludePatterns?.some((p) => matchesGlob(relPath, p))) continue;

      // Check include patterns
      if (includePatterns && includePatterns.length > 0) {
        if (!includePatterns.some((p) => matchesGlob(relPath, p))) continue;
      } else {
        // Default include: match common source file extensions
        if (!DEFAULT_INCLUDE.test(entry.name)) continue;
      }

      results.push(fullPath);
    }
  }
}

registerTool({
  name: "codebase_index",
  description:
    "Index a codebase repository: walk files, extract symbols, generate embeddings, and store in the database for semantic code search.",
  parameters: Params,

  async execute(params, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.uid;
    const pool = getPool();

    // Ensure table exists (migration should handle this, but be safe)
    const gitignorePatterns = await loadGitignore(params.repoPath);
    const filePaths: string[] = [];

    await walkFiles(
      params.repoPath,
      params.repoPath,
      gitignorePatterns,
      params.include,
      params.exclude,
      filePaths,
    );

    // Fetch existing hashes from DB
    const existingResult = await pool.query<{
      file_path: string;
      content_hash: string;
    }>(
      "SELECT file_path, content_hash FROM codebase_index WHERE workspace_id = $1",
      [workspaceId],
    );

    const existingHashes = new Map<string, string>();
    for (const row of existingResult.rows) {
      existingHashes.set(row.file_path, row.content_hash);
    }

    let indexed = 0;
    let skipped = 0;

    for (const fullPath of filePaths) {
      const relPath = relative(params.repoPath, fullPath).replace(/\\/g, "/");
      const ext = extname(fullPath).toLowerCase();
      const language = EXT_TO_LANG[ext] ?? ext.slice(1);

      let content: string;
      try {
        content = await readFile(fullPath, "utf-8");
      } catch {
        skipped++;
        continue;
      }

      const hash = contentHash(content);

      // Skip unchanged files
      if (existingHashes.get(relPath) === hash) {
        skipped++;
        continue;
      }

      const symbols = extractSymbols(content, language);
      const snippet = content.slice(0, 500);

      // Generate embedding from truncated content
      const embeddingText = content.slice(0, MAX_EMBED_CHARS);
      let embedding: number[];
      try {
        embedding = await generateEmbedding(embeddingText);
      } catch {
        // If embedding fails, store without vector
        embedding = [];
      }

      const embeddingValue =
        embedding.length > 0 ? `[${embedding.join(",")}]` : null;

      await pool.query(
        `INSERT INTO codebase_index (workspace_id, file_path, language, symbols, content_hash, snippet, embedding, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, now())
         ON CONFLICT (workspace_id, file_path)
         DO UPDATE SET language = $3, symbols = $4, content_hash = $5, snippet = $6, embedding = $7::vector, indexed_at = now()`,
        [
          workspaceId,
          relPath,
          language,
          JSON.stringify(symbols),
          hash,
          snippet,
          embeddingValue,
        ],
      );

      indexed++;
    }

    return {
      indexed,
      skipped,
      total: filePaths.length,
      repoPath: params.repoPath,
    };
  },
});
