import { vi } from "vitest";

export function createMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
    body: {},
    query: {},
    params: {},
    ip: "1.2.3.4",
    path: "/test",
    get(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    header(name: string) {
      return this.get(name);
    },
    ...overrides,
  };
}

export function createMockResponse() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.removeHeader = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.headersSent = false;
  res.locals = {};
  return res;
}

export function createMockNext() {
  return vi.fn();
}
