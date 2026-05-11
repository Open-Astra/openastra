import type { Request, Response, NextFunction } from "express";
import type { WorkspaceAwareRequest } from "./workspace.js";

interface QueueEntry {
  priority: number;
  enqueuedAt: number;
  resolve: () => void;
}

const queue: QueueEntry[] = [];
let activeRequests = 0;

const DEFAULT_MAX_DEPTH = 200;
const DEFAULT_MAX_CONCURRENT = 50;

export interface PriorityQueueOpts {
  maxDepth?: number;
  maxConcurrent?: number;
}

export function getQueueStats() {
  const byPriority: Record<number, number> = {};
  for (const entry of queue) {
    byPriority[entry.priority] = (byPriority[entry.priority] ?? 0) + 1;
  }
  const totalWait = queue.reduce((s, e) => s + (Date.now() - e.enqueuedAt), 0);
  return {
    depth: queue.length,
    maxDepth: DEFAULT_MAX_DEPTH,
    activeRequests,
    pendingByPriority: byPriority,
    avgWaitMs: queue.length > 0 ? Math.round(totalWait / queue.length) : 0,
  };
}

function processQueue(maxConcurrent: number): void {
  while (activeRequests < maxConcurrent && queue.length > 0) {
    queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    const next = queue.shift();
    if (next) {
      activeRequests++;
      next.resolve();
    }
  }
}

export function priorityQueue(opts?: PriorityQueueOpts) {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConcurrent = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

  return (req: Request, res: Response, next: NextFunction) => {
    const headerPriority = parseInt(String(req.headers["x-priority"] ?? ""), 10);
    let priority = Number.isFinite(headerPriority) && headerPriority >= 1 && headerPriority <= 5
      ? headerPriority
      : 3;

    // Boost premium workspaces
    try {
      const ws = (req as unknown as WorkspaceAwareRequest).workspace;
      if (ws?.workspaceId) priority = Math.max(1, priority - 1);
    } catch {
      // No workspace context
    }

    if (activeRequests < maxConcurrent) {
      activeRequests++;
      res.on("finish", () => {
        activeRequests--;
        processQueue(maxConcurrent);
      });
      return next();
    }

    if (queue.length >= maxDepth) {
      res.setHeader("Retry-After", "5");
      return res.status(429).json({ error: "Queue full", depth: queue.length, maxDepth });
    }

    const entry: QueueEntry = {
      priority,
      enqueuedAt: Date.now(),
      resolve: () => {
        res.on("finish", () => {
          activeRequests--;
          processQueue(maxConcurrent);
        });
        next();
      },
    };

    queue.push(entry);
    processQueue(maxConcurrent);
  };
}
