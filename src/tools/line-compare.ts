import { z } from "zod";
import { registerTool } from "./registry.js";
import { searchPlayerProps } from "../data/odds-api.js";

// ── line_compare ────────────────────────────────────────────────────
// Compares lines across sportsbooks for a given prop using The Odds API.
// Returns the best available number and flags significant discrepancies.

const LineCompareParams = z.object({
  playerName: z.string().describe("Player name"),
  market: z.string().describe("Prop market type, e.g. 'points', 'rebounds'"),
  sport: z
    .enum(["nba", "nfl", "mlb", "nhl", "ncaab", "ncaaf"])
    .optional()
    .describe("Sport to filter by"),
});

registerTool({
  name: "line_compare",
  description:
    "Compare a player prop line across all available sportsbooks. Returns the best line, worst line, and any significant discrepancies that may indicate value.",
  parameters: LineCompareParams,

  async execute(params) {
    try {
      const result = await searchPlayerProps(
        params.playerName,
        params.sport ?? "nba",
        params.market,
      );

      if (result.props.length === 0) {
        return {
          player: params.playerName,
          market: params.market,
          books: [],
          bestOver: null,
          bestUnder: null,
          lineSpread: 0,
          hasDiscrepancy: false,
          message: `No lines found for ${params.playerName} ${params.market}. No games with this prop available today.`,
        };
      }

      const books = result.props.map((p) => ({
        book: p.book,
        line: p.line,
        overOdds: p.overOdds,
        underOdds: p.underOdds,
      }));

      const lines = books.map((b) => b.line);
      const bestOver = books.reduce((best, b) => (b.line < best.line ? b : best));
      const bestUnder = books.reduce((best, b) => (b.line > best.line ? b : best));
      const spread = Math.max(...lines) - Math.min(...lines);

      return {
        player: params.playerName,
        market: params.market,
        event: result.event,
        books,
        bestOver: { book: bestOver.book, line: bestOver.line, odds: bestOver.overOdds },
        bestUnder: { book: bestUnder.book, line: bestUnder.line, odds: bestUnder.underOdds },
        lineSpread: spread,
        hasDiscrepancy: spread >= 1.0,
        message: spread >= 1.0
          ? `Significant line discrepancy of ${spread} points across books — potential value.`
          : `Lines are tight across books (spread: ${spread}).`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        player: params.playerName,
        market: params.market,
        books: [],
        bestOver: null,
        bestUnder: null,
        lineSpread: 0,
        hasDiscrepancy: false,
        message: `Error comparing lines: ${message}`,
      };
    }
  },
});
