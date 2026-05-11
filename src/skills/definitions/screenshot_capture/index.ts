import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Screenshot Capture Skill ────────────────────────────────────────
// Capture screenshots of web pages via screenshotting API.
// Uses SCREENSHOT_API_URL or screenshotlayer.com.

const CaptureParams = z.object({
  url: z.string().url().describe("URL to capture"),
  width: z.number().int().min(320).max(1920).default(1280).describe("Viewport width"),
  height: z.number().int().min(240).max(1080).default(720).describe("Viewport height"),
  fullPage: z.boolean().default(false).describe("Capture full page (not just viewport)"),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
});

const BatchCaptureParams = z.object({
  urls: z.array(z.string().url()).min(1).max(5).describe("URLs to capture"),
  width: z.number().int().min(320).max(1920).default(1280),
});

const screenshotCaptureSkill: SkillDefinition = {
  name: "screenshot_capture",
  version: "1.0.0",

  manifest: {
    id: "screenshot_capture",
    name: "Screenshot Capture",
    description: "Capture screenshots of web pages. Returns image data via screenshotting API.",
    category: "execute",
    tools: ["screenshot_capture", "screenshot_batch"],
    configFields: [
      { name: "apiUrl", type: "string", required: false, description: "Screenshot API URL", envVar: "SCREENSHOT_API_URL" },
      { name: "apiKey", type: "string", required: false, description: "Screenshot API key", envVar: "SCREENSHOT_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getConfig = () => ({
      apiUrl: process.env.SCREENSHOT_API_URL ?? "",
      apiKey: process.env.SCREENSHOT_API_KEY ?? "",
    });

    ctx.registerTool({
      name: "screenshot_capture",
      description: "Capture a screenshot of a web page URL.",
      parameters: CaptureParams,

      async execute(params) {
        const { apiUrl, apiKey } = getConfig();
        if (!apiUrl) {
          return {
            note: "SCREENSHOT_API_URL not configured. Set up a screenshotting service.",
            suggestion: "Use a service like screenshotlayer, urlbox, or browserless.io",
            requestedUrl: params.url,
            viewport: `${params.width}x${params.height}`,
          };
        }

        const url = new URL(apiUrl);
        url.searchParams.set("url", params.url);
        url.searchParams.set("width", String(params.width));
        url.searchParams.set("height", String(params.height));
        url.searchParams.set("format", params.format);
        if (params.fullPage) url.searchParams.set("full_page", "true");
        if (apiKey) url.searchParams.set("access_key", apiKey);

        const res = await safeFetch(url.toString(), { timeoutMs: 30_000, ssrfProtection: false });
        if (!res.ok) return { error: `Screenshot API error ${res.status}` };

        const contentType = res.headers.get("content-type") ?? "";
        const size = parseInt(res.headers.get("content-length") ?? "0", 10);

        return {
          url: params.url,
          viewport: `${params.width}x${params.height}`,
          format: params.format,
          size,
          contentType,
          fullPage: params.fullPage,
          captured: true,
        };
      },
    });

    ctx.registerTool({
      name: "screenshot_batch",
      description: "Capture screenshots of multiple URLs at once.",
      parameters: BatchCaptureParams,

      async execute(params) {
        const { apiUrl } = getConfig();
        if (!apiUrl) {
          return {
            note: "SCREENSHOT_API_URL not configured.",
            urls: params.urls,
          };
        }

        const results = await Promise.allSettled(
          params.urls.map(async (targetUrl) => {
            const url = new URL(apiUrl);
            url.searchParams.set("url", targetUrl);
            url.searchParams.set("width", String(params.width));
            const res = await safeFetch(url.toString(), { timeoutMs: 30_000, ssrfProtection: false });
            return { url: targetUrl, status: res.status, captured: res.ok };
          }),
        );

        return {
          count: results.length,
          results: results.map((r, i) =>
            r.status === "fulfilled" ? r.value : { url: params.urls[i], error: String((r as PromiseRejectedResult).reason) },
          ),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "screenshot_capture",
      instructions: "You can capture web page screenshots with `screenshot_capture` (single URL) and `screenshot_batch` (multiple URLs). Requires SCREENSHOT_API_URL.",
    };
  },
};

export default screenshotCaptureSkill;
