import { afterEach, describe, expect, it } from "vitest";
import { Router } from "express";
import {
  buildOpenApiPaths,
  getRouteInventory,
  registerMountedRouter,
  resetRouteRegistryForTests,
} from "../../src/gateway/route-meta.js";

afterEach(() => {
  resetRouteRegistryForTests();
});

describe("route metadata registry", () => {
  it("discovers nested routers and decorates them with stability metadata", () => {
    const child = Router();
    child.get("/chat", () => {});
    child.post("/chat/:id", () => {});

    const parent = Router();
    parent.use(child);

    registerMountedRouter("/agent", parent);

    const inventory = getRouteInventory();
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/agent/chat",
          auth: "jwt",
          stability: "stable",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/agent/chat/:id",
          auth: "jwt",
          stability: "stable",
        }),
      ]),
    );

    const paths = buildOpenApiPaths({});
    expect(paths["/agent/chat"]).toMatchObject({
      get: expect.objectContaining({
        operationId: "getAgentChat",
        "x-auth": "jwt",
        "x-stability": "stable",
        "x-feature": "agent-runtime",
      }),
    });
  });
});
