// ── Demo / mock-data gating ─────────────────────────────────────────
// Sample data must never be shown silently in a production build.
//
//   • `npm run dev`                      → demo mode on (mock fallbacks, dev login)
//   • production build                   → demo mode OFF: API failures surface as
//                                          empty states, and views that are not yet
//                                          wired to the gateway show a placeholder
//   • production build + VITE_DEMO_MODE=true → demo mode on, with a visible banner
//
// `import.meta.env.DEV` is replaced at build time, so in a normal production
// build these branches are statically false.

export const DEMO_MODE: boolean =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";

/** Returns `value` in demo mode, otherwise the empty fallback. */
export function demoOnly<T>(value: () => T, empty: T): T {
  return DEMO_MODE ? value() : empty;
}
