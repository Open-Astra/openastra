// ── Sanity CMS Publish Tool ────────────────────────────────────────
// Publishes articles to Sanity.io via the mutations API.
// Converts markdown body to Portable Text blocks for Sanity storage.
//
// Required env vars: SANITY_PROJECT_ID, SANITY_API_TOKEN
// Optional: SANITY_DATASET (defaults to "production"),
//           SANITY_AUTHOR_REF (author document ID for reference field)

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";

const SanityPublishParams = z.object({
  documentType: z.string().default("blogPost").describe("Sanity document _type"),
  title: z.string().describe("Article title"),
  slug: z.string().describe("URL-friendly slug (kebab-case)"),
  body: z.string().describe("Article body in markdown"),
  category: z.string().optional().describe("Article category (e.g., nba, nhl, mlb)"),
  sport: z.string().optional().describe("Sport identifier (e.g., basketball, hockey)"),
  excerpt: z.string().optional().describe("Short excerpt or summary"),
  tags: z.array(z.string()).optional().describe("Article tags"),
  publishedAt: z.string().optional().describe("ISO 8601 publish date (defaults to now)"),
  isDraft: z.boolean().default(true).describe("Publish as draft if true (default: true)"),
  imageAlt: z.string().optional().describe("Alt text for the main image placeholder"),
});

// ── Markdown → Portable Text ──────────────────────────────────────

interface PortableTextBlock {
  _type: "block";
  _key: string;
  style: string;
  children: Array<{
    _type: "span";
    _key: string;
    text: string;
    marks: string[];
  }>;
  markDefs: Array<{
    _type: string;
    _key: string;
    href?: string;
  }>;
}

let _keyCounter = 0;
function nextKey(): string {
  return `k${(++_keyCounter).toString(36)}`;
}

function parseInlineMarks(
  text: string,
  markDefs: PortableTextBlock["markDefs"],
): PortableTextBlock["children"] {
  const spans: PortableTextBlock["children"] = [];

  // Process bold, italic, links, and inline code
  const regex = /(\*\*(.+?)\*\*|_(.+?)_|\[(.+?)\]\((.+?)\)|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      spans.push({
        _type: "span",
        _key: nextKey(),
        text: text.slice(lastIndex, match.index),
        marks: [],
      });
    }

    if (match[2]) {
      // Bold: **text**
      spans.push({
        _type: "span",
        _key: nextKey(),
        text: match[2],
        marks: ["strong"],
      });
    } else if (match[3]) {
      // Italic: _text_
      spans.push({
        _type: "span",
        _key: nextKey(),
        text: match[3],
        marks: ["em"],
      });
    } else if (match[4] && match[5]) {
      // Link: [text](url)
      const linkKey = nextKey();
      markDefs.push({ _type: "link", _key: linkKey, href: match[5] });
      spans.push({
        _type: "span",
        _key: nextKey(),
        text: match[4],
        marks: [linkKey],
      });
    } else if (match[6]) {
      // Inline code: `text`
      spans.push({
        _type: "span",
        _key: nextKey(),
        text: match[6],
        marks: ["code"],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    spans.push({
      _type: "span",
      _key: nextKey(),
      text: text.slice(lastIndex),
      marks: [],
    });
  }

  // If no spans were created, use the whole text as a plain span
  if (spans.length === 0) {
    spans.push({
      _type: "span",
      _key: nextKey(),
      text,
      marks: [],
    });
  }

  return spans;
}

function markdownToPortableText(markdown: string): PortableTextBlock[] {
  _keyCounter = 0;
  const blocks: PortableTextBlock[] = [];
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === "") {
      i++;
      continue;
    }

    // Headers
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const style = level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "h4";
      const markDefs: PortableTextBlock["markDefs"] = [];
      blocks.push({
        _type: "block",
        _key: nextKey(),
        style,
        children: parseInlineMarks(headingMatch[2]!, markDefs),
        markDefs,
      });
      i++;
      continue;
    }

    // Bullet list items
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const markDefs: PortableTextBlock["markDefs"] = [];
      blocks.push({
        _type: "block",
        _key: nextKey(),
        style: "normal",
        children: parseInlineMarks(trimmed.slice(2), markDefs),
        markDefs,
      });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      const markDefs: PortableTextBlock["markDefs"] = [];
      blocks.push({
        _type: "block",
        _key: nextKey(),
        style: "blockquote",
        children: parseInlineMarks(trimmed.slice(2), markDefs),
        markDefs,
      });
      i++;
      continue;
    }

    // Regular paragraph — collect consecutive non-empty, non-special lines
    let paragraph = trimmed;
    i++;
    while (i < lines.length) {
      const next = lines[i]!.trim();
      if (
        next === "" ||
        next.startsWith("#") ||
        next.startsWith("- ") ||
        next.startsWith("* ") ||
        next.startsWith("> ")
      ) {
        break;
      }
      paragraph += " " + next;
      i++;
    }

    const markDefs: PortableTextBlock["markDefs"] = [];
    blocks.push({
      _type: "block",
      _key: nextKey(),
      style: "normal",
      children: parseInlineMarks(paragraph, markDefs),
      markDefs,
    });
  }

  return blocks;
}

// ── Content Sanitization ─────────────────────────────────────────
// Strips internal artifacts so only production-ready blog content
// reaches Sanity. Some agent workflows produce data briefs,
// word counts, source lists, and process commentary that readers
// should never see.

function sanitizeForPublish(markdown: string): string {
  let cleaned = markdown;

  // 1. Strip <data-brief>...</data-brief> blocks (single and multiline)
  cleaned = cleaned.replace(/<data-brief>[\s\S]*?<\/data-brief>/gi, "");

  // 2. Strip any remaining opening/closing data-brief tags (malformed)
  cleaned = cleaned.replace(/<\/?data-brief>/gi, "");

  // 3. Strip code-fenced blocks that look like data briefs or tool counts
  //    e.g. ```\nTOOL CALL COUNTS:\n...\n```
  cleaned = cleaned.replace(/```[\s\S]*?(?:TOOL CALL COUNTS|SOURCED FACTS|HALLUCINATION RATIO|SOURCED FACT COUNT)[\s\S]*?```/gi, "");

  // 4. Strip word count references: "(Word count: 1,248)", "Word count: ~1200", etc.
  cleaned = cleaned.replace(/\(?\s*word\s+count[:\s]*~?\s*[\d,]+\s*\)?\s*/gi, "");

  // 5. Strip character count references
  cleaned = cleaned.replace(/\(?\s*character\s+count[:\s]*~?\s*[\d,]+\s*\)?\s*/gi, "");

  // 6. Strip "**Sources:**" footer blocks through end of content or next section
  cleaned = cleaned.replace(/\*{0,2}Sources:?\*{0,2}\s*[\s\S]*?(?=\n#{1,4}\s|\n*$)/gi, (match) => {
    // Only strip if it looks like a source list (has URLs, reporter names, or "per" attributions)
    if (/https?:\/\/|fetched|url_fetch|sports_data|web_search/i.test(match)) {
      return "";
    }
    return match;
  });

  // 7. Strip verification disclaimers
  cleaned = cleaned.replace(/^.*(?:all stats verified|stats verified from|all data sourced|verified from fetched).*$/gim, "");

  // 8. Strip "Note: This is a simulated article" disclaimers
  cleaned = cleaned.replace(/^.*(?:note:\s*this is a simulated|this article is simulated|this is a simulated article).*$/gim, "");

  // 9. Strip process commentary lines (self-talk about formatting/rules)
  cleaned = cleaned.replace(/^.*(?:word count approx|but no,? rule|wait,? delete|anyway,? the article is structured).*$/gim, "");

  // 10. Strip tool call count lines that leak outside data-brief
  cleaned = cleaned.replace(/^.*(?:web_search:\s*\[?\d|url_fetch:\s*\[?\d|sports_data:\s*\[?\d|TOOL CALL COUNTS).*$/gim, "");

  // 11. Strip hallucination ratio lines
  cleaned = cleaned.replace(/^.*(?:hallucination ratio|sourced fact count).*$/gim, "");

  // 12. Strip dataset references (e.g., "Dataset: production", "dataset: staging")
  cleaned = cleaned.replace(/^.*dataset:\s*(?:production|staging|development).*$/gim, "");

  // 13. Collapse 3+ consecutive blank lines into 2
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // 14. Trim leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/** Extract SEO description from the first non-heading paragraph or excerpt */
function extractSeoDescription(markdown: string, excerpt?: string): string {
  // Use excerpt if long enough
  if (excerpt && excerpt.length >= 50) {
    return excerpt.slice(0, 320);
  }

  // Find first non-heading, non-empty paragraph
  const lines = markdown.split("\n");
  let paragraph = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("> ")) {
      continue;
    }
    paragraph = trimmed;
    break;
  }

  if (paragraph) {
    return paragraph.slice(0, 320);
  }

  return excerpt ?? "";
}

/** Estimate read time from cleaned markdown word count */
function estimateReadTime(markdown: string): string {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
}

// ── Title Deduplication ──────────────────────────────────────────
// If the first non-empty line of the body matches the title (with or
// without markdown heading/bold markers), strip it so the headline
// isn't duplicated in the published article.

function stripLeadingTitle(body: string, title: string): string {
  const lines = body.split("\n");
  const normalizedTitle = title.replace(/[*#]/g, "").trim().toLowerCase();
  if (!normalizedTitle) return body;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") continue;

    // Normalize: strip markdown heading markers, bold markers, trailing punctuation
    const normalizedLine = trimmed
      .replace(/^#{1,4}\s+/, "")
      .replace(/\*\*/g, "")
      .trim()
      .toLowerCase();

    if (normalizedLine === normalizedTitle) {
      lines.splice(i, 1);
      // Also remove the blank line that may follow
      if (i < lines.length && lines[i]!.trim() === "") {
        lines.splice(i, 1);
      }
      return lines.join("\n").replace(/^\n+/, "");
    }
    // First non-empty line doesn't match — stop looking
    break;
  }
  return body;
}

// ── Tool Registration ─────────────────────────────────────────────

registerTool({
  name: "sanity_publish",
  description:
    "Publish an article to Sanity.io CMS. Accepts markdown body and converts it to " +
    "Portable Text. Requires SANITY_PROJECT_ID and SANITY_API_TOKEN env vars.",
  parameters: SanityPublishParams,

  async execute(params) {
    const projectId = process.env.SANITY_PROJECT_ID;
    const dataset = process.env.SANITY_DATASET ?? "production";
    const token = process.env.SANITY_API_TOKEN;
    const authorRef = process.env.SANITY_AUTHOR_REF;

    if (!projectId || !token) {
      return {
        error:
          "SANITY_PROJECT_ID and SANITY_API_TOKEN environment variables must be set.",
      };
    }

    const url = `https://${projectId}.api.sanity.io/v2023-08-01/data/mutate/${dataset}`;

    // Strip internal artifacts (data briefs, word counts, source lists)
    // so only production-ready blog content reaches Sanity
    let cleanBody = sanitizeForPublish(params.body);

    // Strip the title/headline from the body if it appears as the first line,
    // since it's already stored in the separate title field. This prevents
    // the headline from being duplicated in the published article.
    cleanBody = stripLeadingTitle(cleanBody, params.title);

    // Sanitize title and excerpt — strip data-brief tags that may leak through
    const stripBriefTags = (s: string) =>
      s.replace(/<data-brief>[\s\S]*?<\/data-brief>/gi, "")
       .replace(/<\/?data-brief>/gi, "")
       .trim();
    const cleanTitle = stripBriefTags(params.title) || "Untitled Article";
    const cleanExcerpt = stripBriefTags(params.excerpt ?? "");

    const blocks = markdownToPortableText(cleanBody);
    const docUuid = randomUUID();
    const docId = params.isDraft
      ? `drafts.${docUuid}`
      : docUuid;
    const publishedAt = params.publishedAt ?? new Date().toISOString();
    const readTime = estimateReadTime(cleanBody);

    // Extract SEO description from the first non-heading paragraph
    const seoDescription = extractSeoDescription(cleanBody, cleanExcerpt);

    // Build document matching the blogPost schema
    const doc: Record<string, unknown> = {
      _id: docId,
      _type: params.documentType,
      title: cleanTitle,
      slug: { _type: "slug", current: params.slug },
      body: blocks,
      excerpt: cleanExcerpt,
      publishedAt,
      readTime,
      seo: {
        title: cleanTitle,
        description: seoDescription,
      },
    };

    // Add author reference if configured
    if (authorRef) {
      doc.author = {
        _type: "reference",
        _ref: authorRef,
        _weak: true,
        _strengthenOnPublish: {
          type: "author",
          template: { id: "author" },
        },
      };
    }

    // Add main image placeholder if alt text provided
    if (params.imageAlt) {
      doc.mainImage = {
        _type: "image",
        alt: params.imageAlt,
      };
    }

    // Include optional fields if provided
    if (params.category) doc.category = params.category;
    if (params.sport) doc.sport = params.sport;
    if (params.tags && params.tags.length > 0) doc.tags = params.tags;

    const mutation = {
      mutations: [{ createOrReplace: doc }],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(mutation),
        signal: controller.signal,
      });

      const result = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        return {
          error: `Sanity API error ${res.status}: ${JSON.stringify(result)}`,
        };
      }

      return {
        success: true,
        documentId: docId,
        transactionId: result.transactionId ?? null,
        title: cleanTitle,
        slug: params.slug,
        readTime,
        publishedAt,
        isDraft: params.isDraft,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { error: "Sanity publish timed out after 15 seconds" };
      }
      return { error: msg };
    } finally {
      clearTimeout(timeout);
    }
  },
});
