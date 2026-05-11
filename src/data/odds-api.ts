// ── The Odds API Client ─────────────────────────────────────────────
// Shared client for The Odds API (https://the-odds-api.com).
// Provides player prop odds from DraftKings, FanDuel, BetMGM, Caesars.
// Includes in-memory cache to avoid burning API quota.

const BASE_URL = "https://api.the-odds-api.com/v4";

// ── Sport Key Mapping ───────────────────────────────────────────────

const SPORT_KEYS: Record<string, string> = {
  nba: "basketball_nba",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaab: "basketball_ncaab",
  ncaaf: "americanfootball_ncaaf",
};

// ── Market Key Mapping ──────────────────────────────────────────────
// Maps our short market names to The Odds API player prop market keys.

const MARKET_KEYS: Record<string, string> = {
  // NBA
  points: "player_points",
  rebounds: "player_rebounds",
  assists: "player_assists",
  threes: "player_threes",
  blocks: "player_blocks",
  steals: "player_steals",
  pts_reb_ast: "player_points_rebounds_assists",
  // NFL
  passing_yards: "player_pass_yds",
  passing_tds: "player_pass_tds",
  rushing_yards: "player_rush_yds",
  receiving_yards: "player_reception_yds",
  receptions: "player_receptions",
  anytime_td: "player_anytime_td",
  // MLB
  hits: "player_hits",
  total_bases: "player_total_bases",
  home_runs: "player_home_runs",
  strikeouts: "player_strikeouts",
  // NHL
  goals: "player_goals",
  shots_on_goal: "player_shots_on_goal",
};

// ── Bookmaker Mapping ───────────────────────────────────────────────

const BOOKMAKER_KEYS: Record<string, string> = {
  draftkings: "draftkings",
  fanduel: "fanduel",
  betmgm: "betmgm",
  caesars: "williamhill_us",
};

const ALL_BOOKMAKERS = Object.values(BOOKMAKER_KEYS).join(",");

// ── Cache ───────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 60_000).unref();

// ── API Response Types ──────────────────────────────────────────────

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface OddsOutcome {
  name: string; // player name or "Over"/"Under"
  description?: string; // player name for props
  price: number; // American odds
  point?: number; // the line
}

export interface OddsMarket {
  key: string;
  last_update: string;
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  title: string;
  markets: OddsMarket[];
}

export interface OddsEventWithOdds extends OddsEvent {
  bookmakers: OddsBookmaker[];
}

// ── Normalized Output Types ─────────────────────────────────────────

export interface PlayerProp {
  market: string;
  book: string;
  bookTitle: string;
  line: number;
  overOdds: number;
  underOdds: number;
  lastUpdated: string;
}

export interface PlayerPropsResult {
  player: string;
  sport: string;
  event?: string;
  props: PlayerProp[];
}

// ── API Calls ───────────────────────────────────────────────────────

let _apiKey: string | null = null;

export function initOddsApi(apiKey: string): void {
  _apiKey = apiKey;
}

function getApiKey(): string {
  if (!_apiKey) throw new Error("Odds API not initialized — call initOddsApi first");
  return _apiKey;
}

async function apiFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("apiKey", getApiKey());
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Odds API ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── Get Events for a Sport ──────────────────────────────────────────

export async function getEvents(sport: string): Promise<OddsEvent[]> {
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) throw new Error(`Unknown sport: ${sport}`);

  const cacheKey = `events:${sportKey}`;
  const cached = getCached<OddsEvent[]>(cacheKey);
  if (cached) return cached;

  const events = await apiFetch<OddsEvent[]>(`/sports/${sportKey}/events`);
  setCache(cacheKey, events, 5 * 60_000); // 5 min cache
  return events;
}

// ── Get Player Props for an Event ───────────────────────────────────

export async function getEventPlayerProps(
  sport: string,
  eventId: string,
  markets: string[],
  bookmaker?: string,
): Promise<OddsEventWithOdds> {
  const sportKey = SPORT_KEYS[sport];
  if (!sportKey) throw new Error(`Unknown sport: ${sport}`);

  const marketKeys = markets
    .map((m) => MARKET_KEYS[m] || m)
    .join(",");

  const bookmakers = bookmaker
    ? (BOOKMAKER_KEYS[bookmaker] || bookmaker)
    : ALL_BOOKMAKERS;

  const cacheKey = `props:${sportKey}:${eventId}:${marketKeys}:${bookmakers}`;
  const cached = getCached<OddsEventWithOdds>(cacheKey);
  if (cached) return cached;

  const data = await apiFetch<OddsEventWithOdds>(
    `/sports/${sportKey}/events/${eventId}/odds`,
    {
      regions: "us",
      markets: marketKeys,
      bookmakers,
      oddsFormat: "american",
    },
  );
  setCache(cacheKey, data, 2 * 60_000); // 2 min cache
  return data;
}

// ── Search Player Props Across Events ───────────────────────────────
// The main function used by prop_lookup and line_compare.
// Fetches today's events, gets player props, filters by player name.

export async function searchPlayerProps(
  playerName: string,
  sport: string = "nba",
  market?: string,
  bookmaker?: string,
): Promise<PlayerPropsResult> {
  const events = await getEvents(sport);

  if (events.length === 0) {
    return { player: playerName, sport, props: [] };
  }

  // Default markets based on sport
  const markets = market
    ? [market]
    : getDefaultMarkets(sport);

  const playerLower = playerName.toLowerCase();
  const allProps: PlayerProp[] = [];
  let matchedEvent: string | undefined;

  // Search across events (limit to 8 to preserve API quota)
  const eventsToSearch = events.slice(0, 8);

  for (const event of eventsToSearch) {
    let eventOdds: OddsEventWithOdds;
    try {
      eventOdds = await getEventPlayerProps(sport, event.id, markets, bookmaker);
    } catch {
      continue; // skip events that fail (no props available)
    }

    for (const bm of eventOdds.bookmakers) {
      for (const mkt of bm.markets) {
        // Group outcomes by player — props come as Over/Under pairs
        const playerOutcomes = mkt.outcomes.filter(
          (o) => o.description?.toLowerCase().includes(playerLower),
        );

        if (playerOutcomes.length === 0) continue;
        matchedEvent = `${event.away_team} @ ${event.home_team}`;

        const over = playerOutcomes.find((o) => o.name === "Over");
        const under = playerOutcomes.find((o) => o.name === "Under");

        if (over?.point != null) {
          allProps.push({
            market: reverseMarketKey(mkt.key),
            book: reverseBookmakerKey(bm.key),
            bookTitle: bm.title,
            line: over.point,
            overOdds: over.price,
            underOdds: under?.price ?? 0,
            lastUpdated: mkt.last_update,
          });
        }
      }
    }

    // If we found the player, no need to search more events
    if (allProps.length > 0) break;
  }

  return {
    player: playerName,
    sport,
    event: matchedEvent,
    props: allProps,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function getDefaultMarkets(sport: string): string[] {
  switch (sport) {
    case "nba": return ["points", "rebounds", "assists"];
    case "nfl": return ["passing_yards", "rushing_yards", "receiving_yards"];
    case "mlb": return ["hits", "strikeouts", "total_bases"];
    case "nhl": return ["goals", "assists", "shots_on_goal"];
    default: return ["points"];
  }
}

function reverseMarketKey(apiKey: string): string {
  for (const [short, full] of Object.entries(MARKET_KEYS)) {
    if (full === apiKey) return short;
  }
  return apiKey.replace("player_", "");
}

function reverseBookmakerKey(apiKey: string): string {
  for (const [short, full] of Object.entries(BOOKMAKER_KEYS)) {
    if (full === apiKey) return short;
  }
  return apiKey;
}

export { SPORT_KEYS, MARKET_KEYS, BOOKMAKER_KEYS };
