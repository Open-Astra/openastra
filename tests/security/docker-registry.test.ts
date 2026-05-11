import { describe, it, expect } from "vitest";
import { _testOnly } from "../../src/tools/code-execute.js";

const { isImageTrusted, JS_BLOCKED, PY_BLOCKED } = _testOnly;

// ── Docker Image Trust Checks ────────────────────────────────────────

describe("Docker Image Trust — Allowed Registries", () => {
  it("allows docker.io/ prefixed images", () => {
    expect(isImageTrusted("docker.io/library/node:18")).toBe(true);
  });

  it("allows ghcr.io/ prefixed images", () => {
    expect(isImageTrusted("ghcr.io/some-org/some-image:latest")).toBe(true);
  });

  it("allows official node images (no slash)", () => {
    expect(isImageTrusted("node:18")).toBe(true);
  });

  it("allows official python images (no slash)", () => {
    expect(isImageTrusted("python:3.12-alpine")).toBe(true);
  });

  it("allows official alpine images (no slash)", () => {
    expect(isImageTrusted("alpine:3.19")).toBe(true);
  });

  it("allows bare image names without a slash (e.g. ubuntu)", () => {
    // Images without a slash are considered official Docker Hub images
    expect(isImageTrusted("ubuntu")).toBe(true);
  });
});

describe("Docker Image Trust — Blocked Registries", () => {
  it("blocks evil.com/malware", () => {
    expect(isImageTrusted("evil.com/malware")).toBe(false);
  });

  it("blocks registry.evil.com/img", () => {
    expect(isImageTrusted("registry.evil.com/img")).toBe(false);
  });

  it("blocks arbitrary third-party registry images", () => {
    expect(isImageTrusted("quay.io/untrusted/image:latest")).toBe(false);
  });
});

// ── Code Pattern Blocking (JS) ───────────────────────────────────────

function matchesJsBlocked(code: string): boolean {
  return JS_BLOCKED.some((p: RegExp) => p.test(code));
}

function matchesPyBlocked(code: string): boolean {
  return PY_BLOCKED.some((p: RegExp) => p.test(code));
}

describe("Code Blocked Patterns — JavaScript", () => {
  it("blocks require() calls", () => {
    expect(matchesJsBlocked("const fs = require('fs')")).toBe(true);
  });

  it("blocks process.env access", () => {
    expect(matchesJsBlocked("console.log(process.env.SECRET)")).toBe(true);
  });

  it("blocks dynamic import()", () => {
    expect(matchesJsBlocked("const m = await import('child_process')")).toBe(true);
  });

  it("allows safe code: console.log(1+1)", () => {
    expect(matchesJsBlocked("console.log(1+1)")).toBe(false);
  });

  it("allows safe code: arithmetic", () => {
    expect(matchesJsBlocked("const x = 42 * 3; console.log(x)")).toBe(false);
  });
});

describe("Code Blocked Patterns — Python", () => {
  it("blocks import os", () => {
    expect(matchesPyBlocked("import os")).toBe(true);
  });

  it("blocks eval()", () => {
    expect(matchesPyBlocked("eval('malicious')")).toBe(true);
  });

  it("blocks __import__()", () => {
    expect(matchesPyBlocked("__import__('os').system('id')")).toBe(true);
  });

  it("allows safe code: print(1+1)", () => {
    expect(matchesPyBlocked("print(1+1)")).toBe(false);
  });

  it("allows safe code: list comprehension", () => {
    expect(matchesPyBlocked("[x**2 for x in range(10)]")).toBe(false);
  });
});
