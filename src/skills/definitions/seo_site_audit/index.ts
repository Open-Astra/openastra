import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

const SiteAuditParams = z.object({
  url: z.string().url().describe("The URL to audit"),
  depth: z.number().int().min(1).max(50).default(10).describe("Max pages to crawl"),
  checks: z.array(z.enum([
    "meta_tags", "headings", "images", "links", "performance",
    "mobile", "structured_data", "canonical", "robots", "sitemap",
  ])).default(["meta_tags", "headings", "images", "links", "canonical"]).describe("Checks to run"),
});

interface AuditIssue {
  severity: "error" | "warning" | "info";
  check: string;
  page: string;
  message: string;
  recommendation: string;
}

interface PageData {
  url: string;
  statusCode: number;
  title?: string;
  metaDescription?: string;
  h1Count: number;
  imageCount: number;
  imagesWithoutAlt: number;
  internalLinks: number;
  externalLinks: number;
  brokenLinks: string[];
  hasCanonical: boolean;
  hasStructuredData: boolean;
  loadTimeMs: number;
}

const seoSiteAuditSkill: SkillDefinition = {
  name: "seo_site_audit",
  version: "1.0.0",

  manifest: {
    id: "seo_site_audit",
    name: "SEO Site Audit",
    description: "Crawls a website and produces a comprehensive SEO audit report covering meta tags, headings, images, links, performance, structured data, and technical SEO issues.",
    category: "analyze",
    tools: ["seo_site_audit"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "seo_site_audit",
      description: "Run a comprehensive SEO audit on a website. Crawls pages and reports issues with meta tags, headings, images, links, canonical tags, and structured data.",
      parameters: SiteAuditParams,

      async execute(params) {
        const { url, depth, checks } = params;
        const issues: AuditIssue[] = [];
        const pages: PageData[] = [];
        const visited = new Set<string>();
        const queue = [url];

        while (queue.length > 0 && visited.size < depth) {
          const currentUrl = queue.shift()!;
          if (visited.has(currentUrl)) continue;
          visited.add(currentUrl);

          try {
            const start = Date.now();
            const response = await safeFetch(currentUrl, { timeout: 15_000 });
            const loadTimeMs = Date.now() - start;
            const html = await response.text();

            const pageData = parsePageData(currentUrl, html, response.status, loadTimeMs);
            pages.push(pageData);

            // Run selected checks
            if (checks.includes("meta_tags")) checkMetaTags(pageData, issues);
            if (checks.includes("headings")) checkHeadings(pageData, html, issues);
            if (checks.includes("images")) checkImages(pageData, issues);
            if (checks.includes("links")) checkLinks(pageData, issues);
            if (checks.includes("canonical")) checkCanonical(pageData, issues);
            if (checks.includes("structured_data")) checkStructuredData(pageData, issues);
            if (checks.includes("performance")) checkPerformance(pageData, issues);

            // Extract internal links for crawling
            const baseHost = new URL(url).hostname;
            const internalLinks = extractLinks(html, currentUrl).filter(
              (l) => { try { return new URL(l).hostname === baseHost; } catch { return false; } },
            );
            for (const link of internalLinks.slice(0, 20)) {
              if (!visited.has(link)) queue.push(link);
            }
          } catch (err) {
            issues.push({
              severity: "error",
              check: "crawl",
              page: currentUrl,
              message: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}`,
              recommendation: "Check if the URL is accessible and not blocked by robots.txt",
            });
          }
        }

        const score = calculateScore(issues, pages.length);

        return {
          url,
          pagesAudited: pages.length,
          score,
          issuesSummary: {
            errors: issues.filter((i) => i.severity === "error").length,
            warnings: issues.filter((i) => i.severity === "warning").length,
            info: issues.filter((i) => i.severity === "info").length,
          },
          issues: issues.slice(0, 50),
          pages: pages.map((p) => ({
            url: p.url,
            statusCode: p.statusCode,
            title: p.title,
            loadTimeMs: p.loadTimeMs,
          })),
        };
      },
    });
  },
};

function parsePageData(url: string, html: string, statusCode: number, loadTimeMs: number): PageData {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const metaDescMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/is);
  const h1Matches = html.match(/<h1[^>]*>/gi) ?? [];
  const imgMatches = html.match(/<img[^>]*>/gi) ?? [];
  const imagesWithoutAlt = imgMatches.filter((img) => !img.includes("alt=") || /alt=["']\s*["']/i.test(img)).length;
  const linkMatches = html.match(/<a[^>]*href=["'][^"']*["'][^>]*>/gi) ?? [];
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["']/i);
  const structuredDataMatch = html.match(/<script[^>]*type=["']application\/ld\+json["']/i);

  const baseHost = new URL(url).hostname;
  let internalLinks = 0;
  let externalLinks = 0;
  for (const link of linkMatches) {
    const hrefMatch = link.match(/href=["']([^"']*)["']/i);
    if (hrefMatch) {
      try {
        const linkUrl = new URL(hrefMatch[1]!, url);
        if (linkUrl.hostname === baseHost) internalLinks++;
        else externalLinks++;
      } catch { /* skip malformed */ }
    }
  }

  return {
    url,
    statusCode,
    title: titleMatch?.[1]?.trim(),
    metaDescription: metaDescMatch?.[1]?.trim(),
    h1Count: h1Matches.length,
    imageCount: imgMatches.length,
    imagesWithoutAlt,
    internalLinks,
    externalLinks,
    brokenLinks: [],
    hasCanonical: !!canonicalMatch,
    hasStructuredData: !!structuredDataMatch,
    loadTimeMs,
  };
}

function checkMetaTags(page: PageData, issues: AuditIssue[]): void {
  if (!page.title) {
    issues.push({ severity: "error", check: "meta_tags", page: page.url, message: "Missing page title", recommendation: "Add a unique, descriptive <title> tag (50-60 characters)" });
  } else if (page.title.length > 60) {
    issues.push({ severity: "warning", check: "meta_tags", page: page.url, message: `Title too long (${page.title.length} chars)`, recommendation: "Keep title under 60 characters to avoid truncation in SERPs" });
  }
  if (!page.metaDescription) {
    issues.push({ severity: "warning", check: "meta_tags", page: page.url, message: "Missing meta description", recommendation: "Add a compelling meta description (120-160 characters)" });
  } else if (page.metaDescription.length > 160) {
    issues.push({ severity: "info", check: "meta_tags", page: page.url, message: `Meta description too long (${page.metaDescription.length} chars)`, recommendation: "Keep meta description under 160 characters" });
  }
}

function checkHeadings(page: PageData, html: string, issues: AuditIssue[]): void {
  if (page.h1Count === 0) {
    issues.push({ severity: "error", check: "headings", page: page.url, message: "Missing H1 tag", recommendation: "Add exactly one H1 tag per page with primary keyword" });
  } else if (page.h1Count > 1) {
    issues.push({ severity: "warning", check: "headings", page: page.url, message: `Multiple H1 tags (${page.h1Count})`, recommendation: "Use only one H1 tag per page" });
  }
  const h2Matches = html.match(/<h2[^>]*>/gi) ?? [];
  if (h2Matches.length === 0) {
    issues.push({ severity: "info", check: "headings", page: page.url, message: "No H2 tags found", recommendation: "Use H2 tags to structure content with relevant subheadings" });
  }
}

function checkImages(page: PageData, issues: AuditIssue[]): void {
  if (page.imagesWithoutAlt > 0) {
    issues.push({ severity: "warning", check: "images", page: page.url, message: `${page.imagesWithoutAlt} images missing alt text`, recommendation: "Add descriptive alt text to all images for accessibility and SEO" });
  }
}

function checkLinks(page: PageData, issues: AuditIssue[]): void {
  if (page.internalLinks === 0) {
    issues.push({ severity: "warning", check: "links", page: page.url, message: "No internal links found", recommendation: "Add internal links to help search engines discover and index pages" });
  }
  for (const broken of page.brokenLinks) {
    issues.push({ severity: "error", check: "links", page: page.url, message: `Broken link: ${broken}`, recommendation: "Fix or remove broken links to improve user experience and crawl efficiency" });
  }
}

function checkCanonical(page: PageData, issues: AuditIssue[]): void {
  if (!page.hasCanonical) {
    issues.push({ severity: "warning", check: "canonical", page: page.url, message: "Missing canonical tag", recommendation: "Add a rel=canonical tag to prevent duplicate content issues" });
  }
}

function checkStructuredData(page: PageData, issues: AuditIssue[]): void {
  if (!page.hasStructuredData) {
    issues.push({ severity: "info", check: "structured_data", page: page.url, message: "No structured data (JSON-LD) found", recommendation: "Add Schema.org structured data to enable rich snippets in search results" });
  }
}

function checkPerformance(page: PageData, issues: AuditIssue[]): void {
  if (page.loadTimeMs > 3000) {
    issues.push({ severity: "error", check: "performance", page: page.url, message: `Slow page load (${page.loadTimeMs}ms)`, recommendation: "Optimize page load time to under 3 seconds for better rankings" });
  } else if (page.loadTimeMs > 1500) {
    issues.push({ severity: "warning", check: "performance", page: page.url, message: `Page load time ${page.loadTimeMs}ms`, recommendation: "Consider optimizing for sub-1.5s load times" });
  }
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const matches = html.matchAll(/href=["']([^"'#]*?)["']/gi);
  for (const match of matches) {
    try {
      const resolved = new URL(match[1]!, baseUrl).href;
      if (resolved.startsWith("http")) links.push(resolved);
    } catch { /* skip malformed */ }
  }
  return [...new Set(links)];
}

function calculateScore(issues: AuditIssue[], pageCount: number): number {
  if (pageCount === 0) return 0;
  const errorWeight = 10;
  const warningWeight = 3;
  const penalties = issues.reduce((sum, i) => {
    if (i.severity === "error") return sum + errorWeight;
    if (i.severity === "warning") return sum + warningWeight;
    return sum;
  }, 0);
  const maxPenalty = pageCount * 30;
  return Math.max(0, Math.round(100 - (penalties / maxPenalty) * 100));
}

export default seoSiteAuditSkill;
