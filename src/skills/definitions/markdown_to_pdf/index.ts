import { z } from "zod";
import { writeFile } from "node:fs/promises";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Markdown to PDF Skill ────────────────────────────────────────
// Converts markdown to well-formatted HTML that can be printed to PDF.
// Pure local computation — no external API required.

const MarkdownToPdfParams = z.object({
  markdown: z.string().describe("Markdown content to convert"),
  title: z.string().optional().describe("Document title (used in HTML <title> and header)"),
  outputPath: z
    .string()
    .optional()
    .describe("Output file path (defaults to /tmp/astra-export.html)"),
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function convertMarkdownToHtml(md: string): string {
  let html = md;

  // Code blocks (fenced) — must be processed before inline patterns
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Tables
  html = html.replace(
    /(?:^|\n)((?:\|[^\n]+\|\n)+)/g,
    (_match, tableBlock: string) => {
      const rows = tableBlock.trim().split("\n");
      if (rows.length < 2) return tableBlock;

      // Check for separator row
      const isSeparator = (row: string) => /^\|[\s\-:|]+\|$/.test(row.trim());
      let headerEnd = -1;
      for (let i = 0; i < rows.length; i++) {
        if (isSeparator(rows[i])) {
          headerEnd = i;
          break;
        }
      }

      const parseRow = (row: string, tag: string) => {
        const cells = row
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
      };

      let tableHtml = "<table>";
      if (headerEnd > 0) {
        tableHtml += "<thead>";
        for (let i = 0; i < headerEnd; i++) {
          tableHtml += parseRow(rows[i], "th");
        }
        tableHtml += "</thead><tbody>";
        for (let i = headerEnd + 1; i < rows.length; i++) {
          if (!isSeparator(rows[i])) tableHtml += parseRow(rows[i], "td");
        }
        tableHtml += "</tbody>";
      } else {
        tableHtml += "<tbody>";
        for (const row of rows) {
          if (!isSeparator(row)) tableHtml += parseRow(row, "td");
        }
        tableHtml += "</tbody>";
      }
      tableHtml += "</table>";
      return "\n" + tableHtml + "\n";
    },
  );

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Horizontal rules
  html = html.replace(/^(?:---|\*\*\*|___)\s*$/gm, "<hr>");

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Links and images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;">');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Unordered lists
  html = html.replace(
    /(?:^|\n)((?:[\t ]*[-*+]\s+.+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => line.replace(/^[\t ]*[-*+]\s+/, "").trim())
        .filter(Boolean);
      return "\n<ul>" + items.map((item) => `<li>${item}</li>`).join("") + "</ul>\n";
    },
  );

  // Ordered lists
  html = html.replace(
    /(?:^|\n)((?:[\t ]*\d+\.\s+.+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split("\n")
        .map((line) => line.replace(/^[\t ]*\d+\.\s+/, "").trim())
        .filter(Boolean);
      return "\n<ol>" + items.map((item) => `<li>${item}</li>`).join("") + "</ol>\n";
    },
  );

  // Paragraphs — wrap remaining lines that aren't already HTML
  const lines = html.split("\n");
  const result: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isBlock = /^<(?:h[1-6]|pre|code|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|hr|div|p)[\s>]/i.test(trimmed);
    const isEmpty = trimmed === "";

    if (isBlock || isEmpty) {
      if (inParagraph) {
        result.push("</p>");
        inParagraph = false;
      }
      if (!isEmpty) result.push(trimmed);
    } else {
      if (!inParagraph) {
        result.push("<p>" + trimmed);
        inParagraph = true;
      } else {
        result.push(trimmed);
      }
    }
  }
  if (inParagraph) result.push("</p>");

  return result.join("\n");
}

function wrapInHtmlDocument(bodyHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @media print {
      body { margin: 0; }
      @page { margin: 2cm; }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      color: #1a1a1a;
      background: #fff;
    }
    h1, h2, h3, h4, h5, h6 {
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }
    h1 { font-size: 2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
    h3 { font-size: 1.25em; }
    code {
      background: #f4f4f4;
      padding: 0.15em 0.4em;
      border-radius: 3px;
      font-size: 0.9em;
      font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    }
    pre {
      background: #f8f8f8;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 1em;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #ddd;
      margin-left: 0;
      padding: 0.5em 1em;
      color: #555;
      background: #fafafa;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 0.5em 0.75em;
      text-align: left;
    }
    th { background: #f4f4f4; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    hr {
      border: none;
      border-top: 2px solid #eee;
      margin: 2em 0;
    }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    img { max-width: 100%; height: auto; }
    ul, ol { padding-left: 1.5em; }
    li { margin: 0.25em 0; }
    del { color: #999; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

const markdownToPdfSkill: SkillDefinition = {
  name: "markdown_to_pdf",
  version: "1.0.0",

  manifest: {
    id: "markdown_to_pdf",
    name: "Markdown to PDF",
    description:
      "Converts markdown to well-formatted HTML that can be printed to PDF. Supports headers, code blocks, tables, lists, and more.",
    category: "transform",
    tools: ["markdown_to_pdf"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "markdown_to_pdf",
      description:
        "Convert markdown content to a print-ready HTML file. Supports headers, code blocks, tables, lists, bold, italic, links, images, and blockquotes.",
      parameters: MarkdownToPdfParams,

      async execute(params) {
        const title = params.title ?? "Document";
        const outputPath = params.outputPath ?? "/tmp/astra-export.html";

        try {
          const bodyHtml = convertMarkdownToHtml(params.markdown);
          const fullHtml = wrapInHtmlDocument(bodyHtml, title);

          await writeFile(outputPath, fullHtml, "utf-8");

          return {
            title,
            outputPath,
            sizeBytes: Buffer.byteLength(fullHtml, "utf-8"),
            message: `HTML document written to ${outputPath}. Open in a browser and use Print → Save as PDF.`,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Failed to write HTML: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "markdown_to_pdf",
      instructions:
        "You can convert markdown to a print-ready HTML file using the `markdown_to_pdf` tool. The HTML output can be opened in a browser and printed to PDF.",
    };
  },
};

export default markdownToPdfSkill;
