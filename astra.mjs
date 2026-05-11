#!/usr/bin/env node

// ── npx astra wrapper ──────────────────────────────────────────────
// Thin ESM shim that loads the compiled CLI entry point.
// This file lives at the repo root so `"bin": { "astra": "./astra.mjs" }`
// works with npx/npm link.

await import("./dist/bin/astra.js");
