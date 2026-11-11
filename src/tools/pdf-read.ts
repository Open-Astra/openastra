import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { registerTool } from "./registry.js";
import { tryGuardPath } from "./path-guard.js";
import { isBlockedUrl, safeFetch } from "../utils/ssrf-guard.js";

// ── pdf_read ──────────────────────────────────────────────────────────
// Extract text content from PDF files (local or URL) using pdf-parse.

const PdfReadParams = z.object({
  source: z
    .string()
    .min(1)
    .describe("File path or URL to a PDF document"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Maximum number of pages to extract (default 50, max 500)"),
});

function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

registerTool({
  name: "pdf_read",
  description:
    "Extract text from a PDF file. Accepts a local file path or a URL. Returns the extracted text, page count, and document metadata (title, author, etc.). Uses the pdf-parse library. Respects agent file access restrictions for local files.",
  parameters: PdfReadParams,
  async execute(params, ctx) {
    try {
      let buffer: Buffer;

      if (isUrl(params.source)) {
        // SSRF protection — uses DNS resolution to defeat rebinding attacks
        if (await isBlockedUrl(params.source)) {
          return { error: "URL targets a restricted internal address." };
        }

        // Fetch PDF from URL
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);

        try {
          const res = await safeFetch(params.source, {
            headers: { "User-Agent": "Astra-Agent/1.0" },
            signal: controller.signal,
            redirect: "manual",
          });

          // Block redirect-based SSRF
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            if (!location) {
              return { error: `Redirect (${res.status}) with no Location header` };
            }
            const redirectUrl = new URL(location, params.source).href;
            if (await isBlockedUrl(redirectUrl)) {
              return { error: "Redirect targets a restricted internal address." };
            }
            return { error: `PDF URL redirected to ${redirectUrl} — re-issue with the direct URL if needed.` };
          }

          if (!res.ok) {
            return { error: `Failed to fetch PDF: ${res.status} ${res.statusText}` };
          }

          const arrayBuffer = await res.arrayBuffer();
          buffer = Buffer.from(arrayBuffer);
        } finally {
          clearTimeout(timer);
        }
      } else {
        // Block null bytes — path truncation attack vector
        if (params.source.includes("\0") || params.source.includes("%00")) {
          return { error: "Null bytes are not allowed in file paths." };
        }

        // Read from local filesystem
        const guardedPath = tryGuardPath(params.source, { access: "read", agentId: ctx?.agentId });
        if (!guardedPath.ok) {
          return { error: guardedPath.error };
        }
        const filePath = guardedPath.path;

        const info = await stat(filePath);
        if (!info.isFile()) {
          return { error: `Not a file: ${filePath}` };
        }

        // Cap file size at 100MB
        if (info.size > 100 * 1024 * 1024) {
          return { error: "PDF file exceeds 100MB size limit." };
        }

        buffer = await readFile(filePath);
      }

      // Dynamic import of pdf-parse
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });

      // Extract text with page limit
      const textResult = await parser.getText({
        first: params.maxPages,
      });

      // Extract metadata
      const infoResult = await parser.getInfo();

      const totalPages = textResult.total;

      return {
        text: textResult.text,
        pageCount: totalPages,
        info: {
          title: infoResult.info?.Title ?? null,
          author: infoResult.info?.Author ?? null,
          subject: infoResult.info?.Subject ?? null,
          creator: infoResult.info?.Creator ?? null,
          producer: infoResult.info?.Producer ?? null,
          creationDate: infoResult.info?.CreationDate ?? null,
        },
        pagesExtracted: Math.min(params.maxPages, totalPages),
        truncated: totalPages > params.maxPages,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
