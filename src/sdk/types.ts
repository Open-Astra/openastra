import type {
  HttpMethod,
  RouteAuth,
  RouteDescriptor,
  RouteStability,
} from "../gateway/route-meta.js";

export type { HttpMethod, RouteAuth, RouteDescriptor, RouteStability };

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
  [key: string]: unknown;
}

export interface OpenApiOperation {
  summary?: string;
  tags?: string[];
  operationId?: string;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  security?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface AstraClientOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}
