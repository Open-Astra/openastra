// ── Shared TUI Helpers ──────────────────────────────────────────────
// Readline-based prompts used by onboard.ts and the main CLI.
// Each helper accepts an `rl` instance so the caller owns the lifecycle.

import { createInterface, type Interface as RLInterface } from "node:readline";

// ── ANSI Constants ──────────────────────────────────────────────────

export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const CYAN = "\x1b[36m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";
export const CELESTIAL = "\x1b[38;5;39m";

// ── Readline Factory ────────────────────────────────────────────────

export function createRL(): RLInterface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

// ── Prompt Helpers ──────────────────────────────────────────────────

export function ask(rl: RLInterface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export function askYesNo(rl: RLInterface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  return new Promise((resolve) => {
    rl.question(`  ${question} ${DIM}(${hint})${RESET}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

export function askChoice(rl: RLInterface, question: string, options: string[], defaultIndex = 0): Promise<string> {
  console.log(`  ${question}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? `${GREEN}>${RESET}` : " ";
    console.log(`    ${marker} ${i + 1}. ${options[i]}`);
  }
  return new Promise((resolve) => {
    rl.question(`  ${DIM}Enter number (${defaultIndex + 1})${RESET}: `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      resolve(options[idx >= 0 && idx < options.length ? idx : defaultIndex]!);
    });
  });
}

export function askSecret(rl: RLInterface, question: string): Promise<string> {
  // Mask input by temporarily overriding stdout.write during readline
  return new Promise((resolve) => {
    const origWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
    let masking = false;

    rl.question(`  ${question}: `, (answer) => {
      // Restore stdout
      process.stdout.write = origWrite;
      console.log(); // newline after masked input
      resolve(answer.trim());
    });

    // After the prompt is printed, start masking
    masking = true;
    process.stdout.write = function (
      chunk: string | Uint8Array,
      ...args: unknown[]
    ): boolean {
      if (masking && typeof chunk === "string" && !chunk.includes("\x1b[")) {
        // Replace visible characters with asterisks
        const masked = chunk.replace(/[^\r\n]/g, "*");
        return (origWrite as Function).call(process.stdout, masked, ...args);
      }
      return (origWrite as Function).call(process.stdout, chunk, ...args);
    } as typeof process.stdout.write;
  });
}

// ── Display Helpers ─────────────────────────────────────────────────

export function banner(title: string, subtitle: string): void {
  const width = 44;
  const pad = (s: string) => {
    const total = width - 2;
    const left = Math.floor((total - s.length) / 2);
    const right = total - s.length - left;
    return " ".repeat(left) + s + " ".repeat(right);
  };
  console.log(`
${CELESTIAL}${BOLD}    ${"╔" + "═".repeat(width) + "╗"}
    ${"║"}${pad(title)}${"║"}
    ${"║"}${pad(subtitle)}${"║"}
    ${"╚" + "═".repeat(width) + "╝"}${RESET}
`);
}

export function section(title: string): void {
  console.log(`\n${CYAN}${BOLD}── ${title} ${"─".repeat(Math.max(0, 50 - title.length))}${RESET}\n`);
}

export function success(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${DIM}${msg}${RESET}`);
}

export function error(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}
