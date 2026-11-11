import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { checkTokenBudget } from "../../billing/budget-check.js";

// ── Token Budget Middleware ─────────────────────────────────────────
// Enforces per-user token budget limits. Runs after auth middleware.
// - Hard cap → 429 with usage info
// - Soft cap → attach degraded flag + override model to request
// - Under cap → pass through

export interface BudgetAwareRequest extends AuthenticatedRequest {
  budgetDegraded?: boolean;
  overrideModel?: string;
}

export function tokenBudget() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const { uid } = req as AuthenticatedRequest;
    if (!uid) {
      next();
      return;
    }

    try {
      const result = await checkTokenBudget(uid);

      if (!result.allowed) {
        res.status(429).json({
          error: "Token budget exceeded",
          usage: {
            current: result.currentUsage,
            limit: result.limit,
            tier: result.tier,
          },
          reason: result.reason,
          upgradeUrl: "/billing/upgrade",
        });
        return;
      }

      if (result.degraded) {
        (req as BudgetAwareRequest).budgetDegraded = true;
        (req as BudgetAwareRequest).overrideModel = result.overrideModel;
      }

      next();
    } catch (err) {
      console.error("[token-budget] Check failed:", err);
      // Fail closed in production: an unreachable budget store must not
      // become unlimited free inference. TOKEN_BUDGET_FAIL_OPEN=true
      // restores the old availability-first behaviour.
      if (process.env.NODE_ENV === "production" && process.env.TOKEN_BUDGET_FAIL_OPEN !== "true") {
        res.status(503).json({ error: "Usage limits are temporarily unavailable. Please retry." });
        return;
      }
      next();
    }
  };
}
