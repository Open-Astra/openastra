import type { Request, Response, NextFunction } from "express";

const DEFAULT_VERSION = "v1";
const VERSION_REGEX = /^\/v(\d+)\//;

export interface VersionedRequest extends Request {
  apiVersion: string;
}

export function apiVersioning() {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Check Accept-Version header first
    const headerVersion = req.headers["accept-version"];
    if (headerVersion && typeof headerVersion === "string") {
      (req as unknown as VersionedRequest).apiVersion = headerVersion.startsWith("v")
        ? headerVersion
        : `v${headerVersion}`;
      return next();
    }

    // Check URL prefix
    const match = req.path.match(VERSION_REGEX);
    if (match) {
      (req as unknown as VersionedRequest).apiVersion = `v${match[1]}`;
      return next();
    }

    (req as unknown as VersionedRequest).apiVersion = DEFAULT_VERSION;
    next();
  };
}
