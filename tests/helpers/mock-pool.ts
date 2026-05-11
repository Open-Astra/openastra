import { vi } from "vitest";

export interface MockPoolOptions {
  queryResponses?: Map<string, { rows: unknown[] }>;
  defaultRows?: unknown[];
  shouldError?: boolean;
  errorMessage?: string;
}

export function createMockPool(options: MockPoolOptions = {}) {
  const {
    queryResponses = new Map(),
    defaultRows = [],
    shouldError = false,
    errorMessage = "DB error",
  } = options;

  const queryFn = vi.fn().mockImplementation(async (sql: string) => {
    if (shouldError) throw new Error(errorMessage);
    for (const [pattern, result] of queryResponses) {
      if (sql.includes(pattern)) return result;
    }
    return { rows: defaultRows };
  });

  return {
    query: queryFn,
    connect: vi.fn().mockResolvedValue({
      query: queryFn,
      release: vi.fn(),
    }),
    end: vi.fn(),
    on: vi.fn(),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
}
