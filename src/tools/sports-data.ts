// ── Sports Data Tool ────────────────────────────────────────────────
// Fetches real sports data from ESPN's public API and The Odds API.
// Supports scores, standings, news, transactions, and betting odds
// for NBA, NHL, MLB, MLS, NFL, and EPL.

import { z } from "zod";
import { registerTool } from "./registry.js";

const LeagueEnum = z.enum(["nba", "nhl", "mlb", "mls", "nfl", "epl"]);
const DataTypeEnum = z.enum(["scores", "standings", "news", "transactions", "odds"]);

const SportsDataParams = z.object({
  league: LeagueEnum.describe("Sports league to query"),
  dataType: DataTypeEnum.describe("Type of data to fetch: scores, standings, news, transactions, or odds"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional()
    .describe("Date in YYYY-MM-DD format (defaults to today)"),
});

type League = z.infer<typeof LeagueEnum>;

// ── ESPN path mapping ───────────────────────────────────────────────

const ESPN_PATHS: Record<League, string> = {
  nba: "basketball/nba",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  mls: "soccer/usa.1",
  nfl: "football/nfl",
  epl: "soccer/eng.1",
};

// ── Odds API sport key mapping ──────────────────────────────────────

const ODDS_KEYS: Record<League, string> = {
  nba: "basketball_nba",
  nhl: "icehockey_nhl",
  mlb: "baseball_mlb",
  mls: "soccer_usa_mls",
  nfl: "americanfootball_nfl",
  epl: "soccer_epl",
};

// ── Helpers ─────────────────────────────────────────────────────────

function todayESPN(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function dateToESPN(date: string): string {
  return date.replace(/-/g, "");
}

async function fetchJSON(url: string, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── ESPN Data Parsers ───────────────────────────────────────────────

interface ScoreResult {
  home: string;
  away: string;
  homeScore: string;
  awayScore: string;
  status: string;
  venue: string;
  headline: string;
}

function parseScores(data: any): ScoreResult[] {
  const events = data?.events ?? [];
  return events.map((ev: any) => {
    const comps = ev.competitions?.[0] ?? {};
    const teams = comps.competitors ?? [];
    const home = teams.find((t: any) => t.homeAway === "home");
    const away = teams.find((t: any) => t.homeAway === "away");
    return {
      home: home?.team?.displayName ?? "Unknown",
      away: away?.team?.displayName ?? "Unknown",
      homeScore: home?.score ?? "0",
      awayScore: away?.score ?? "0",
      status: ev.status?.type?.description ?? "Unknown",
      venue: comps.venue?.fullName ?? "",
      headline: ev.name ?? "",
    };
  });
}

interface NewsResult {
  headline: string;
  description: string;
  published: string;
  source: string;
  link: string;
}

function parseNews(data: any): NewsResult[] {
  const articles = data?.articles ?? [];
  return articles.slice(0, 10).map((a: any) => ({
    headline: a.headline ?? "",
    description: a.description ?? "",
    published: a.published ?? "",
    source: a.byline ?? a.source ?? "ESPN",
    link: a.links?.web?.href ?? a.links?.api?.news?.href ?? "",
  }));
}

interface StandingsEntry {
  team: string;
  wins: string;
  losses: string;
  ties: string;
  points: string;
  pct: string;
  streak: string;
  divisionRank: string;
  conference: string;
}

function parseStandings(data: any): StandingsEntry[] {
  const results: StandingsEntry[] = [];
  const children = data?.children ?? [];
  for (const group of children) {
    const conference = group.name ?? group.abbreviation ?? "";
    const standings = group.standings?.entries ?? group.children?.flatMap((d: any) => d.standings?.entries ?? []) ?? [];
    for (const entry of standings) {
      const stats = entry.stats ?? [];
      const getStat = (name: string) => stats.find((s: any) => s.name === name)?.displayValue ?? "";
      results.push({
        team: entry.team?.displayName ?? "",
        wins: getStat("wins"),
        losses: getStat("losses"),
        ties: getStat("ties"),
        points: getStat("points"),
        pct: getStat("winPercent") || getStat("gamesBehind") || "",
        streak: getStat("streak"),
        divisionRank: getStat("playoffSeed") || getStat("rank") || "",
        conference,
      });
    }
  }
  return results;
}

interface TransactionResult {
  date: string;
  team: string;
  description: string;
  type: string;
}

function parseTransactions(data: any): TransactionResult[] {
  const results: TransactionResult[] = [];
  const items = data?.items ?? data?.transactions ?? [];
  for (const item of items) {
    const transactions = item.transactions ?? [item];
    for (const tx of transactions) {
      results.push({
        date: tx.date ?? item.date ?? "",
        team: tx.team?.displayName ?? item.team?.displayName ?? "",
        description: tx.text ?? tx.description ?? tx.longDescription ?? "",
        type: tx.type?.text ?? tx.type ?? "",
      });
    }
  }
  return results;
}

// ── Odds API Parser ─────────────────────────────────────────────────

interface OddsResult {
  home: string;
  away: string;
  homeSpread: string;
  total: string;
  homeMoneyline: string;
  awayMoneyline: string;
  bookmaker: string;
}

function parseOdds(data: any): OddsResult[] {
  if (!Array.isArray(data)) return [];
  return data.map((game: any) => {
    const book = game.bookmakers?.[0];
    const markets = book?.markets ?? [];
    const h2h = markets.find((m: any) => m.key === "h2h");
    const spreads = markets.find((m: any) => m.key === "spreads");
    const totals = markets.find((m: any) => m.key === "totals");

    const homeOutcome = (market: any) =>
      market?.outcomes?.find((o: any) => o.name === game.home_team) ??
      market?.outcomes?.[0];
    const awayOutcome = (market: any) =>
      market?.outcomes?.find((o: any) => o.name === game.away_team) ??
      market?.outcomes?.[1];

    return {
      home: game.home_team ?? "",
      away: game.away_team ?? "",
      homeSpread: spreads ? `${homeOutcome(spreads)?.point ?? ""}` : "",
      total: totals ? `${totals.outcomes?.[0]?.point ?? ""}` : "",
      homeMoneyline: h2h ? `${homeOutcome(h2h)?.price ?? ""}` : "",
      awayMoneyline: h2h ? `${awayOutcome(h2h)?.price ?? ""}` : "",
      bookmaker: book?.title ?? "",
    };
  });
}

// ── Tool Registration ───────────────────────────────────────────────

registerTool({
  name: "sports_data",
  description:
    "Fetch real sports data from ESPN and The Odds API. " +
    "Returns scores, standings, news, transactions, or betting odds " +
    "for NBA, NHL, MLB, MLS, NFL, and EPL. All data is live and verified.",
  parameters: SportsDataParams,

  async execute(params) {
    const { league, dataType, date } = params;
    const espnPath = ESPN_PATHS[league];
    const espnDate = date ? dateToESPN(date) : todayESPN();

    try {
      switch (dataType) {
        case "scores": {
          const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDate}`;
          const data = await fetchJSON(url);
          const scores = parseScores(data);
          return {
            league,
            date: date ?? new Date().toISOString().split("T")[0],
            games: scores,
            count: scores.length,
          };
        }

        case "news": {
          const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/news`;
          const data = await fetchJSON(url);
          const articles = parseNews(data);
          return {
            league,
            articles,
            count: articles.length,
          };
        }

        case "standings": {
          const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/standings`;
          const data = await fetchJSON(url);
          const entries = parseStandings(data);
          return {
            league,
            standings: entries,
            count: entries.length,
          };
        }

        case "transactions": {
          const url = `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/transactions?dates=${espnDate}`;
          const data = await fetchJSON(url);
          const txns = parseTransactions(data);
          return {
            league,
            date: date ?? new Date().toISOString().split("T")[0],
            transactions: txns,
            count: txns.length,
          };
        }

        case "odds": {
          const apiKey = process.env.ODDS_API_KEY;
          if (!apiKey) {
            return {
              error: "ODDS_API_KEY environment variable is not set. Cannot fetch betting odds.",
            };
          }
          const sportKey = ODDS_KEYS[league];
          const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals`;
          const data = await fetchJSON(url);
          const odds = parseOdds(data);
          return {
            league,
            odds,
            count: odds.length,
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort")) {
        return { error: `Request timed out fetching ${dataType} for ${league}` };
      }
      return { error: `Failed to fetch ${dataType} for ${league}: ${msg}` };
    }
  },
});
