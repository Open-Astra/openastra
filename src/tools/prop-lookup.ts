import { z } from "zod";
import { registerTool } from "./registry.js";
import { searchPlayerProps } from "../data/odds-api.js";

// ── prop_lookup ─────────────────────────────────────────────────────
// Queries The Odds API for live player props across sportsbooks.

const PropLookupParams = z.object({
  playerName: z.string().describe("Player name to search for"),
  sport: z
    .enum(["nba", "nfl", "mlb", "nhl", "ncaab", "ncaaf"])
    .optional()
    .describe("Sport to filter by"),
  market: z
    .string()
    .optional()
    .describe("Prop market type, e.g. 'points', 'rebounds', 'passing_yards'"),
  book: z
    .enum(["draftkings", "fanduel", "betmgm", "caesars"])
    .optional()
    .describe("Specific sportsbook to query"),
});

registerTool({
  name: "prop_lookup",
  description:
    "Look up player prop lines across sportsbooks. Returns available props, current lines, and odds for a given player.",
  parameters: PropLookupParams,

  async execute(params) {
    try {
      const result = await searchPlayerProps(
        params.playerName,
        params.sport ?? "nba",
        params.market,
        params.book,
      );

      if (result.props.length === 0) {
        return {
          player: result.player,
          sport: result.sport,
          props: [],
          message: `No props found for ${params.playerName}. The player may not have props available today, or check the spelling.`,
        };
      }

      return {
        player: result.player,
        sport: result.sport,
        event: result.event,
        props: result.props.map((p) => ({
          market: p.market,
          book: p.book,
          line: p.line,
          overOdds: p.overOdds,
          underOdds: p.underOdds,
          lastUpdated: p.lastUpdated,
        })),
        message: `Found ${result.props.length} prop(s) for ${params.playerName}${result.event ? ` in ${result.event}` : ""}.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        player: params.playerName,
        sport: params.sport ?? "nba",
        props: [],
        message: `Error looking up props: ${message}`,
      };
    }
  },
});
