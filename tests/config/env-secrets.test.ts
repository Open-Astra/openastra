import { describe, it, expect } from "vitest";
import {
  findSecretProblems,
  isPlaceholderSecret,
  securityEnforcement,
} from "../../src/config/env.js";

const strong = {
  JWT_SECRET: "k9f2Lq7ZxP0aWm3Vb8Nc5Rt1Yu6Ie4Oh",
  INTERNAL_API_KEY: "Zx81mPq04LrT7vYc2NbW9aKd",
  TYPESENSE_API_KEY: "7f3a9c1e5b2d8f40a6c1",
  PG_PASSWORD: "u7Rk2pQ9xLm4",
};

describe("placeholder secret detection", () => {
  it.each([
    "CHANGE_ME_AFTER_DEPLOY",
    "change_me_after_deploy",
    "ChangeMe",
    "TODO",
    "todo",
    "FIXME",
    "PLACEHOLDER_PG",
    "PLACEHOLDER_TS",
    "placeholder_jwt",
    "your-secret-here",
    "<your-key>",
    "astra-typesense-key",
    "  secret  ",
  ])("rejects %s regardless of case", (v) => {
    expect(isPlaceholderSecret(v)).toBe(true);
  });

  it("accepts real random values", () => {
    for (const v of Object.values(strong)) expect(isPlaceholderSecret(v)).toBe(false);
    expect(isPlaceholderSecret(undefined)).toBe(false);
  });
});

describe("findSecretProblems", () => {
  it("passes strong secrets", () => {
    expect(findSecretProblems(strong)).toEqual([]);
  });

  it("flags the placeholders that shipped in deploy specs", () => {
    const problems = findSecretProblems({
      ...strong,
      INTERNAL_API_KEY: "CHANGE_ME_AFTER_DEPLOY",
      TYPESENSE_API_KEY: "PLACEHOLDER_TS",
      PG_PASSWORD: "PLACEHOLDER_PG",
    });
    expect(problems.some((p) => p.startsWith("INTERNAL_API_KEY contains a placeholder"))).toBe(true);
    expect(problems.some((p) => p.startsWith("TYPESENSE_API_KEY contains a placeholder"))).toBe(true);
    expect(problems.some((p) => p.startsWith("PG_PASSWORD contains a placeholder"))).toBe(true);
  });

  it("enforces minimum lengths and distinct secrets", () => {
    expect(findSecretProblems({ ...strong, INTERNAL_API_KEY: "abc123" }).join()).toMatch(/INTERNAL_API_KEY is only 6/);
    expect(findSecretProblems({ ...strong, TYPESENSE_API_KEY: "shortkey" }).join()).toMatch(/TYPESENSE_API_KEY is only 8/);
    expect(findSecretProblems({ ...strong, JWT_SECRET: "tooshort" }).join()).toMatch(/JWT_SECRET is only 8/);
    expect(findSecretProblems({ ...strong, PG_PASSWORD: "" }).join()).toMatch(/PG_PASSWORD is empty/);
    expect(
      findSecretProblems({ ...strong, INTERNAL_API_KEY: strong.JWT_SECRET }).join(),
    ).toMatch(/must be different/);
  });
});

describe("securityEnforcement", () => {
  it("enforces in production and on the explicit flag", () => {
    expect(securityEnforcement({ NODE_ENV: "production" })).toBe("enforce");
    expect(securityEnforcement({ NODE_ENV: "development", ASTRA_ENFORCE_SECURITY: "true" })).toBe("enforce");
  });

  it("an unset NODE_ENV is reported distinctly, not treated as a silent opt-out", () => {
    expect(securityEnforcement({})).toBe("warn-unset");
    expect(securityEnforcement({ NODE_ENV: "development" })).toBe("warn");
    expect(securityEnforcement({ NODE_ENV: "production", ASTRA_ENFORCE_SECURITY: "false" })).toBe("warn");
  });
});
