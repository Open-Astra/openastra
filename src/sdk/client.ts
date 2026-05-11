import type {
  AstraClientOptions,
  HttpMethod,
  OpenApiDocument,
  RequestOptions,
  RouteDescriptor,
} from "./types.js";

type RawBody = string | Uint8Array | ArrayBuffer | URLSearchParams | Blob | FormData;

class RouteHandle {
  constructor(
    private readonly client: AstraClient,
    public readonly method: HttpMethod,
    public readonly path: string,
  ) {}

  async request<T>(options?: RequestOptions): Promise<T> {
    return this.client.request<T>(this.method, this.path, options);
  }
}

export class AstraClient {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AstraClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token?: string): void {
    this.token = token;
  }

  route(method: HttpMethod, path: string): RouteHandle {
    return new RouteHandle(this, method, normalizePath(path));
  }

  async openapi(): Promise<OpenApiDocument> {
    return this.request("GET", "/openapi.json");
  }

  async routes(): Promise<RouteDescriptor[]> {
    const payload = await this.request<{ count: number; routes: RouteDescriptor[] }>(
      "GET",
      "/openapi/routes",
    );
    return payload.routes;
  }

  async describeRoute(
    method: HttpMethod,
    path: string,
  ): Promise<RouteDescriptor | undefined> {
    const routes = await this.routes();
    const normalizedPath = normalizePath(path);
    return routes.find((route) => route.method === method && route.path === normalizedPath);
  }

  async request<T>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers = new Headers(options.headers ?? {});

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    let body: RawBody | undefined;
    if (options.body !== undefined) {
      if (isRawBody(options.body)) {
        body = options.body;
      } else {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.body);
      }
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "Unknown error");
      throw new Error(`Astra API request failed (${response.status}): ${message}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): string {
    const normalizedPath = normalizePath(path);
    const url = `${this.baseUrl}${normalizedPath}`;

    if (!query) {
      return url;
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }

    const queryString = params.toString();
    return queryString ? `${url}?${queryString}` : url;
  }
}

export function createAstraClient(options?: AstraClientOptions): AstraClient {
  return new AstraClient(options);
}

function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  return `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function isRawBody(body: unknown): body is RawBody {
  return (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams
  );
}
