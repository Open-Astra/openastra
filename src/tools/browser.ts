import { z } from "zod";
import { registerTool } from "./registry.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool:browser");

// ── Browser Automation Tool ────────────────────────────────────────
// Playwright-based browser control for agentic workflows: navigation,
// interaction, screenshots, DOM snapshots, and JS evaluation.
//
// Requires: npm install playwright (peer dependency — not bundled).
// On first use, requires chromium via `npx playwright install chromium`.
//
// Lifecycle: lazy-launches a single browser instance, reuses across
// calls within the same process. Cleaned up on process exit.

// ── Lazy Playwright Loader ─────────────────────────────────────────
// All Playwright types are avoided at the module level since it's an
// optional dependency. We use `unknown` and cast dynamically.

let _browser: unknown = null;
let _page: unknown = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPage(): Promise<{ page: any; browser: any }> {
  if (_page && _browser) {
    // Check if browser is still connected
    const browser = _browser as { isConnected(): boolean };
    if (browser.isConnected()) {
      return { page: _page, browser: _browser };
    }
    _page = null;
    _browser = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    // Dynamic import as string to avoid TS module resolution on optional peer dep
    const modName = "playwright";
    pw = await import(/* webpackIgnore: true */ modName);
  } catch {
    throw new Error(
      "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
    );
  }

  const browser = await pw.chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: "Astra-Browser/1.0 (Playwright; Headless Chromium)",
  });

  const page = await context.newPage();
  _browser = browser;
  _page = page;

  // Cleanup on process exit
  const cleanup = () => {
    try { browser.close().catch(() => {}); } catch { /* ignore */ }
    _browser = null;
    _page = null;
  };
  process.once("beforeExit", cleanup);
  process.once("SIGTERM", cleanup);

  return { page, browser };
}

// ── Action Schemas ─────────────────────────────────────────────────

const NavigateAction = z.object({
  action: z.literal("navigate"),
  url: z.string().url(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("domcontentloaded"),
});

const ClickAction = z.object({
  action: z.literal("click"),
  selector: z.string().describe("CSS selector or text selector (e.g. 'text=Login')"),
});

const TypeAction = z.object({
  action: z.literal("type"),
  selector: z.string().describe("CSS selector of the input element"),
  text: z.string(),
  pressEnter: z.boolean().default(false),
});

const ScreenshotAction = z.object({
  action: z.literal("screenshot"),
  selector: z.string().optional().describe("CSS selector to screenshot a specific element (omit for full page)"),
  fullPage: z.boolean().default(false),
});

const SnapshotAction = z.object({
  action: z.literal("snapshot"),
  selector: z.string().default("body").describe("CSS selector to get inner text/HTML from"),
  mode: z.enum(["text", "html"]).default("text"),
  maxLength: z.number().int().positive().default(8000).describe("Max characters to return"),
});

const EvaluateAction = z.object({
  action: z.literal("evaluate"),
  script: z.string().describe("JavaScript expression to evaluate in the page context"),
});

const SelectAction = z.object({
  action: z.literal("select"),
  selector: z.string(),
  value: z.string().describe("Option value to select"),
});

const WaitAction = z.object({
  action: z.literal("wait"),
  selector: z.string().describe("CSS selector to wait for"),
  state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible"),
  timeoutMs: z.number().int().positive().default(10000),
});

const GoBackAction = z.object({
  action: z.literal("go_back"),
});

const BrowserParams = z.discriminatedUnion("action", [
  NavigateAction,
  ClickAction,
  TypeAction,
  ScreenshotAction,
  SnapshotAction,
  EvaluateAction,
  SelectAction,
  WaitAction,
  GoBackAction,
]);

// ── SSRF Guard for Navigation ──────────────────────────────────────

async function checkNavigationUrl(url: string): Promise<void> {
  try {
    const { isBlockedUrl } = await import("../utils/ssrf-guard.js");
    if (await isBlockedUrl(url)) {
      throw new Error(`Navigation to ${url} blocked by SSRF guard`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("SSRF")) throw err;
    // ssrf-guard not available — allow navigation
  }
}

// ── Tool Registration ──────────────────────────────────────────────

registerTool({
  name: "browser",
  description:
    "Control a headless browser. Actions: navigate (go to URL), click (CSS/text selector), " +
    "type (fill input), screenshot (capture page or element), snapshot (get page text/HTML), " +
    "evaluate (run JS), select (dropdown), wait (for element), go_back (navigate back). " +
    "Use snapshot to read page content, screenshot to see visual state.",
  parameters: BrowserParams,

  async execute(params) {
    const startMs = Date.now();

    switch (params.action) {
      case "navigate": {
        await checkNavigationUrl(params.url);
        const { page } = await getPage();
        const response = await page.goto(params.url, {
          waitUntil: params.waitUntil,
          timeout: 30000,
        });
        const title = await page.title();
        const url = page.url();
        return {
          action: "navigate",
          url,
          title,
          status: response?.status() ?? null,
          durationMs: Date.now() - startMs,
        };
      }

      case "click": {
        const { page } = await getPage();
        await page.click(params.selector, { timeout: 10000 });
        await page.waitForTimeout(500);
        return {
          action: "click",
          selector: params.selector,
          currentUrl: page.url(),
          durationMs: Date.now() - startMs,
        };
      }

      case "type": {
        const { page } = await getPage();
        await page.fill(params.selector, params.text);
        if (params.pressEnter) {
          await page.press(params.selector, "Enter");
          await page.waitForTimeout(500);
        }
        return {
          action: "type",
          selector: params.selector,
          textLength: params.text.length,
          pressedEnter: params.pressEnter,
          durationMs: Date.now() - startMs,
        };
      }

      case "screenshot": {
        const { page } = await getPage();
        let buffer: Buffer;
        if (params.selector) {
          const element = await page.$(params.selector);
          if (!element) {
            return { action: "screenshot", error: `Element not found: ${params.selector}` };
          }
          buffer = await element.screenshot({ type: "png" });
        } else {
          buffer = await page.screenshot({
            type: "png",
            fullPage: params.fullPage,
          });
        }
        return {
          action: "screenshot",
          base64: buffer.toString("base64"),
          mimeType: "image/png",
          sizeBytes: buffer.length,
          currentUrl: page.url(),
          durationMs: Date.now() - startMs,
        };
      }

      case "snapshot": {
        const { page } = await getPage();
        const element = await page.$(params.selector);
        if (!element) {
          return { action: "snapshot", error: `Element not found: ${params.selector}` };
        }

        let content: string;
        if (params.mode === "html") {
          content = await element.innerHTML();
        } else {
          content = await element.innerText();
        }

        const truncated = content.length > params.maxLength;
        if (truncated) {
          content = content.slice(0, params.maxLength) + "\n...[truncated]";
        }

        return {
          action: "snapshot",
          selector: params.selector,
          mode: params.mode,
          content,
          truncated,
          characterCount: content.length,
          currentUrl: page.url(),
          title: await page.title(),
          durationMs: Date.now() - startMs,
        };
      }

      case "evaluate": {
        const { page } = await getPage();
        const result = await page.evaluate(params.script);
        const serialized = JSON.stringify(result, null, 2) ?? "undefined";
        return {
          action: "evaluate",
          result: serialized.length > 8000 ? serialized.slice(0, 8000) + "...[truncated]" : serialized,
          durationMs: Date.now() - startMs,
        };
      }

      case "select": {
        const { page } = await getPage();
        const selected = await page.selectOption(params.selector, params.value);
        return {
          action: "select",
          selector: params.selector,
          selectedValues: selected,
          durationMs: Date.now() - startMs,
        };
      }

      case "wait": {
        const { page } = await getPage();
        await page.waitForSelector(params.selector, {
          state: params.state,
          timeout: params.timeoutMs,
        });
        return {
          action: "wait",
          selector: params.selector,
          state: params.state,
          found: true,
          durationMs: Date.now() - startMs,
        };
      }

      case "go_back": {
        const { page } = await getPage();
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
        return {
          action: "go_back",
          currentUrl: page.url(),
          title: await page.title(),
          durationMs: Date.now() - startMs,
        };
      }

      default:
        return { error: "Unknown browser action" };
    }
  },

  retryable: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 1000,
    retryOn: ["net::ERR_", "Timeout", "Navigation timeout", "browser has been closed"],
  },
  requiresApproval: false,
  estimatedCostUsd: 0,
});

logger.info("Browser automation tool registered");
