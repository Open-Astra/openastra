import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

const SchemaValidateParams = z.object({
  url: z.string().url().describe("URL to validate structured data on"),
});

const SchemaGenerateParams = z.object({
  type: z.enum([
    "Article", "Product", "LocalBusiness", "FAQPage", "HowTo",
    "BreadcrumbList", "Organization", "WebSite", "Event", "Recipe",
    "VideoObject", "SoftwareApplication", "Review",
  ]).describe("Schema.org type to generate"),
  data: z.record(z.unknown()).describe("Key-value data to populate the schema"),
});

interface SchemaIssue {
  severity: "error" | "warning";
  type: string;
  path: string;
  message: string;
}

const seoSchemaMarkupSkill: SkillDefinition = {
  name: "seo_schema_markup",
  version: "1.0.0",

  manifest: {
    id: "seo_schema_markup",
    name: "SEO Schema Markup",
    description: "Validates existing structured data on pages and generates Schema.org JSON-LD markup for rich snippet eligibility.",
    category: "transform",
    tools: ["seo_schema_validate", "seo_schema_generate"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "seo_schema_validate",
      description: "Validate structured data (JSON-LD) on a given URL. Checks for required fields, correct types, and Google rich result eligibility.",
      parameters: SchemaValidateParams,

      async execute(params) {
        const { url } = params;
        const response = await safeFetch(url, { timeout: 15_000 });
        const html = await response.text();

        const schemas = extractJsonLd(html);
        const issues: SchemaIssue[] = [];
        const validSchemas: Array<{ type: string; valid: boolean; richResultEligible: boolean }> = [];

        for (const schema of schemas) {
          const type = schema["@type"] as string ?? "Unknown";
          const typeIssues = validateSchema(type, schema);
          issues.push(...typeIssues);
          const hasErrors = typeIssues.some((i) => i.severity === "error");
          validSchemas.push({
            type,
            valid: !hasErrors,
            richResultEligible: !hasErrors && isRichResultEligible(type, schema),
          });
        }

        return {
          url,
          schemasFound: schemas.length,
          schemas: validSchemas,
          issues,
          summary: {
            valid: issues.filter((i) => i.severity === "error").length === 0,
            errors: issues.filter((i) => i.severity === "error").length,
            warnings: issues.filter((i) => i.severity === "warning").length,
            richResultEligible: validSchemas.filter((s) => s.richResultEligible).length,
          },
        };
      },
    });

    ctx.registerTool({
      name: "seo_schema_generate",
      description: "Generate Schema.org JSON-LD markup for a given type. Outputs ready-to-use HTML script tag.",
      parameters: SchemaGenerateParams,

      async execute(params) {
        const { type, data } = params;
        const schema = generateSchema(type, data);
        const jsonLd = JSON.stringify(schema, null, 2);
        const htmlSnippet = `<script type="application/ld+json">\n${jsonLd}\n</script>`;

        return {
          type,
          schema,
          htmlSnippet,
          validationNotes: getTypeNotes(type),
        };
      },
    });
  },
};

function extractJsonLd(html: string): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];
  const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]!);
      if (Array.isArray(parsed)) schemas.push(...parsed);
      else schemas.push(parsed);
    } catch { /* skip malformed */ }
  }
  return schemas;
}

function validateSchema(type: string, schema: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const required = getRequiredFields(type);

  for (const field of required) {
    if (!schema[field]) {
      issues.push({ severity: "error", type, path: field, message: `Missing required field: ${field}` });
    }
  }

  if (!schema["@context"]) {
    issues.push({ severity: "warning", type, path: "@context", message: "Missing @context (should be https://schema.org)" });
  } else if (schema["@context"] !== "https://schema.org" && schema["@context"] !== "http://schema.org") {
    issues.push({ severity: "warning", type, path: "@context", message: "Non-standard @context value" });
  }

  // Type-specific validations
  if (type === "Article" || type === "NewsArticle" || type === "BlogPosting") {
    if (schema.datePublished && typeof schema.datePublished === "string") {
      if (!/\d{4}-\d{2}-\d{2}/.test(schema.datePublished)) {
        issues.push({ severity: "error", type, path: "datePublished", message: "datePublished must be in ISO 8601 format" });
      }
    }
    if (!schema.image) {
      issues.push({ severity: "warning", type, path: "image", message: "Articles without images are less likely to get rich results" });
    }
  }

  if (type === "Product") {
    if (!schema.offers && !schema.review) {
      issues.push({ severity: "warning", type, path: "offers/review", message: "Products need offers or review for rich results" });
    }
  }

  return issues;
}

function getRequiredFields(type: string): string[] {
  const fields: Record<string, string[]> = {
    Article: ["headline", "author", "datePublished"],
    Product: ["name", "description"],
    LocalBusiness: ["name", "address"],
    FAQPage: ["mainEntity"],
    HowTo: ["name", "step"],
    BreadcrumbList: ["itemListElement"],
    Organization: ["name", "url"],
    WebSite: ["name", "url"],
    Event: ["name", "startDate", "location"],
    Recipe: ["name", "recipeIngredient", "recipeInstructions"],
    VideoObject: ["name", "description", "uploadDate", "thumbnailUrl"],
    SoftwareApplication: ["name", "operatingSystem"],
    Review: ["itemReviewed", "author", "reviewRating"],
  };
  return fields[type] ?? ["name"];
}

function isRichResultEligible(type: string, schema: Record<string, unknown>): boolean {
  const required = getRequiredFields(type);
  const hasAll = required.every((f) => schema[f]);
  if (!hasAll) return false;

  if (type === "Product") return !!(schema.offers || schema.review || schema.aggregateRating);
  if (type === "Article") return !!(schema.image && schema.author && schema.datePublished);
  if (type === "FAQPage") return Array.isArray(schema.mainEntity) && (schema.mainEntity as unknown[]).length > 0;
  return true;
}

function generateSchema(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    ...data,
  };

  // Add recommended fields if missing
  switch (type) {
    case "Article":
      if (!base.dateModified) base.dateModified = base.datePublished;
      if (!base["@type"]) base["@type"] = "Article";
      break;
    case "Product":
      if (base.price && !base.offers) {
        base.offers = {
          "@type": "Offer",
          price: base.price,
          priceCurrency: base.currency ?? "USD",
          availability: "https://schema.org/InStock",
        };
        delete base.price;
        delete base.currency;
      }
      break;
    case "FAQPage":
      if (Array.isArray(base.questions)) {
        base.mainEntity = (base.questions as Array<{ q: string; a: string }>).map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        }));
        delete base.questions;
      }
      break;
    case "BreadcrumbList":
      if (Array.isArray(base.items)) {
        base.itemListElement = (base.items as Array<{ name: string; url: string }>).map((item, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: item.name,
          item: item.url,
        }));
        delete base.items;
      }
      break;
    case "HowTo":
      if (Array.isArray(base.steps)) {
        base.step = (base.steps as Array<{ text: string; name?: string }>).map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.name ?? `Step ${i + 1}`,
          text: s.text,
        }));
        delete base.steps;
      }
      break;
  }

  return base;
}

function getTypeNotes(type: string): string[] {
  const notes: Record<string, string[]> = {
    Article: [
      "Google requires: headline, image, author, publisher, datePublished",
      "Keep headline under 110 characters",
      "Use a high-resolution image (min 1200px wide)",
    ],
    Product: [
      "Include offers with price and availability for rich results",
      "Add aggregateRating for star ratings in SERPs",
      "Brand and SKU help with product knowledge panel",
    ],
    FAQPage: [
      "Each question/answer pair appears as an expandable result",
      "Content must match what's visible on the page",
      "Avoid promotional or advertising content in answers",
    ],
    LocalBusiness: [
      "Include geo coordinates for map placement",
      "Add openingHoursSpecification for business hours",
      "Include telephone and priceRange",
    ],
    HowTo: [
      "Include estimated time with totalTime property",
      "Add images per step for visual rich results",
      "Include tools and supplies needed",
    ],
  };
  return notes[type] ?? ["Ensure all required fields are present for rich result eligibility"];
}

export default seoSchemaMarkupSkill;
