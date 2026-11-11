import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Migrations are tracked by filename in schema_migrations and run in
// alphabetical order. Two files sharing a numeric prefix have no defined
// relative order by intent, and the second one's IF NOT EXISTS can silently
// no-op. These pairs shipped before the rule was enforced and cannot be
// renamed (renaming would re-run them on existing databases).
const LEGACY_DUPLICATE_PREFIXES = new Set(["010", "149", "169", "170", "171", "176", "185"]);

const dir = join(process.cwd(), "src", "db", "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("migration numbering", () => {
  it("every migration has a zero-padded numeric prefix", () => {
    for (const f of files) expect(f).toMatch(/^\d{3}-[a-z0-9-]+\.sql$/);
  });

  it("no numeric prefix is reused (except the grandfathered ones)", () => {
    const seen = new Map<string, string[]>();
    for (const f of files) {
      const prefix = f.slice(0, 3);
      seen.set(prefix, [...(seen.get(prefix) ?? []), f]);
    }
    const dupes = [...seen.entries()]
      .filter(([prefix, names]) => names.length > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix))
      .map(([, names]) => names);
    expect(dupes).toEqual([]);
  });
});
