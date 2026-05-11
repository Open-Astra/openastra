import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";

// ── Portfolio Tracker Skill ─────────────────────────────────────────
// Track investment holdings, calculate P&L, and analyze allocation.
// Persists positions to Postgres for cross-session tracking.

const AddPositionParams = z.object({
  symbol: z.string().describe("Ticker symbol (e.g. AAPL, BTC)"),
  quantity: z.number().positive().describe("Number of shares/units"),
  costBasis: z.number().positive().describe("Total cost basis for the position"),
  assetType: z.enum(["stock", "crypto", "etf", "option", "other"]).default("stock"),
  notes: z.string().optional(),
});

const UpdatePositionParams = z.object({
  symbol: z.string().describe("Ticker symbol to update"),
  currentPrice: z.number().positive().describe("Current market price per unit"),
});

const ViewPortfolioParams = z.object({});

const RemovePositionParams = z.object({
  symbol: z.string().describe("Ticker symbol to remove"),
});

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS portfolio_positions (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  symbol TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  cost_basis NUMERIC NOT NULL,
  current_price NUMERIC DEFAULT 0,
  asset_type TEXT DEFAULT 'stock',
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, symbol)
)`;

const portfolioTrackerSkill: SkillDefinition = {
  name: "portfolio_tracker",
  version: "1.0.0",

  manifest: {
    id: "portfolio_tracker",
    name: "Portfolio Tracker",
    description: "Track investment holdings with P&L calculation, allocation percentages, and persistent storage.",
    category: "analyze",
    tools: ["portfolio_add", "portfolio_update_price", "portfolio_view", "portfolio_remove"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    let tableReady = false;
    const ensureTable = async () => {
      if (tableReady) return;
      await getPool().query(ENSURE_TABLE);
      tableReady = true;
    };

    ctx.registerTool({
      name: "portfolio_add",
      description: "Add or update a position in the portfolio. If the symbol exists, it will be updated.",
      parameters: AddPositionParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const uid = toolCtx.uid;
        const symbol = params.symbol.toUpperCase();

        await getPool().query(
          `INSERT INTO portfolio_positions (uid, symbol, quantity, cost_basis, asset_type, notes, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (uid, symbol) DO UPDATE SET quantity = $3, cost_basis = $4, asset_type = $5, notes = $6, updated_at = NOW()`,
          [uid, symbol, params.quantity, params.costBasis, params.assetType, params.notes ?? null],
        );

        return {
          success: true,
          symbol,
          quantity: params.quantity,
          costBasis: params.costBasis,
          avgCost: Math.round((params.costBasis / params.quantity) * 100) / 100,
        };
      },
    });

    ctx.registerTool({
      name: "portfolio_update_price",
      description: "Update the current market price for a position to recalculate P&L.",
      parameters: UpdatePositionParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const uid = toolCtx.uid;
        const symbol = params.symbol.toUpperCase();

        const result = await getPool().query(
          `UPDATE portfolio_positions SET current_price = $3, updated_at = NOW() WHERE uid = $1 AND symbol = $2 RETURNING *`,
          [uid, symbol, params.currentPrice],
        );

        if (result.rowCount === 0) return { error: `No position found for ${symbol}` };

        const row = result.rows[0] as { quantity: number; cost_basis: number };
        const marketValue = Number(row.quantity) * params.currentPrice;
        const pnl = marketValue - Number(row.cost_basis);

        return {
          symbol,
          currentPrice: params.currentPrice,
          marketValue: Math.round(marketValue * 100) / 100,
          costBasis: Number(row.cost_basis),
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / Number(row.cost_basis)) * 10000) / 100,
        };
      },
    });

    ctx.registerTool({
      name: "portfolio_view",
      description: "View all portfolio positions with P&L, allocation percentages, and summary.",
      parameters: ViewPortfolioParams,

      async execute(_params, toolCtx) {
        await ensureTable();
        const uid = toolCtx.uid;

        const result = await getPool().query(
          `SELECT symbol, quantity, cost_basis, current_price, asset_type, notes, updated_at
           FROM portfolio_positions WHERE uid = $1 ORDER BY cost_basis DESC`,
          [uid],
        );

        const positions = result.rows as Array<{
          symbol: string; quantity: number; cost_basis: number; current_price: number;
          asset_type: string; notes: string | null; updated_at: Date;
        }>;

        let totalCost = 0;
        let totalValue = 0;

        const holdings = positions.map((p) => {
          const qty = Number(p.quantity);
          const cost = Number(p.cost_basis);
          const price = Number(p.current_price);
          const value = qty * price;
          const pnl = price > 0 ? value - cost : 0;
          totalCost += cost;
          totalValue += price > 0 ? value : cost;

          return {
            symbol: p.symbol,
            quantity: qty,
            avgCost: Math.round((cost / qty) * 100) / 100,
            currentPrice: price || "not set",
            marketValue: price > 0 ? Math.round(value * 100) / 100 : null,
            costBasis: cost,
            pnl: price > 0 ? Math.round(pnl * 100) / 100 : null,
            pnlPercent: price > 0 ? Math.round((pnl / cost) * 10000) / 100 : null,
            type: p.asset_type,
          };
        });

        // Calculate allocation percentages
        const withAllocation = holdings.map((h) => ({
          ...h,
          allocation: Math.round(((h.marketValue ?? h.costBasis) / totalValue) * 10000) / 100,
        }));

        return {
          positionCount: holdings.length,
          totalCostBasis: Math.round(totalCost * 100) / 100,
          totalMarketValue: Math.round(totalValue * 100) / 100,
          totalPnl: Math.round((totalValue - totalCost) * 100) / 100,
          totalPnlPercent: totalCost > 0 ? Math.round(((totalValue - totalCost) / totalCost) * 10000) / 100 : 0,
          positions: withAllocation,
        };
      },
    });

    ctx.registerTool({
      name: "portfolio_remove",
      description: "Remove a position from the portfolio.",
      parameters: RemovePositionParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const symbol = params.symbol.toUpperCase();
        const result = await getPool().query(
          `DELETE FROM portfolio_positions WHERE uid = $1 AND symbol = $2`,
          [toolCtx.uid, symbol],
        );
        return result.rowCount! > 0
          ? { success: true, removed: symbol }
          : { error: `No position found for ${symbol}` };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "portfolio_tracker",
      instructions: "You can track investments with `portfolio_add` (add position), `portfolio_update_price` (set current price), `portfolio_view` (see all holdings with P&L), and `portfolio_remove`. Data persists in Postgres.",
    };
  },
};

export default portfolioTrackerSkill;
