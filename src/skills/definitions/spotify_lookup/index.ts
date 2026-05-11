import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Spotify Lookup Skill ──────────────────────────────────────────
// Search Spotify for tracks and artists, or get details by ID.
// Uses client credentials flow (SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET).

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

const SpotifyParams = z.object({
  operation: z
    .enum(["search_tracks", "search_artists", "get_artist", "get_track"])
    .describe("Spotify operation to perform"),
  query: z
    .string()
    .optional()
    .describe("Search query. Required for search_tracks and search_artists."),
  artistId: z
    .string()
    .optional()
    .describe("Spotify artist ID. Required for get_artist."),
  trackId: z
    .string()
    .optional()
    .describe("Spotify track ID. Required for get_track."),
});

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string | { error: string }> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await safeFetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    ssrfProtection: false,
  });

  if (!response.ok) {
    return { error: `Spotify auth failed: ${response.status} ${response.statusText}` };
  }

  const body = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };

  return body.access_token;
}

async function spotifyFetch(path: string, token: string) {
  const response = await safeFetch(`${SPOTIFY_API}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    ssrfProtection: false,
  });

  if (!response.ok) {
    const text = await response.text();
    return { error: `Spotify API ${response.status}: ${text}` };
  }

  return response.json();
}

const spotifyLookupSkill: SkillDefinition = {
  name: "spotify_lookup",
  version: "1.0.0",

  manifest: {
    id: "spotify_lookup",
    name: "Spotify Lookup",
    description:
      "Search Spotify for tracks and artists, or get details by ID. Uses client credentials flow.",
    category: "search",
    tools: ["spotify_lookup"],
    configFields: [
      {
        name: "clientId",
        type: "string",
        required: true,
        description: "Spotify application client ID",
        envVar: "SPOTIFY_CLIENT_ID",
      },
      {
        name: "clientSecret",
        type: "string",
        required: true,
        description: "Spotify application client secret",
        envVar: "SPOTIFY_CLIENT_SECRET",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "spotify_lookup",
      description:
        "Search Spotify for tracks or artists, or get details by ID. Operations: search_tracks, search_artists, get_artist, get_track.",
      parameters: SpotifyParams,

      async execute(params) {
        const clientId = process.env.SPOTIFY_CLIENT_ID;
        const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return {
            error:
              "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables must both be set.",
          };
        }

        const tokenResult = await getAccessToken(clientId, clientSecret);
        if (typeof tokenResult !== "string") return tokenResult;
        const token = tokenResult;

        const { operation } = params;

        switch (operation) {
          case "search_tracks": {
            if (!params.query)
              return { error: "query is required for search_tracks." };
            const q = encodeURIComponent(params.query);
            const data = (await spotifyFetch(
              `/search?q=${q}&type=track&limit=10`,
              token,
            )) as { tracks?: { items?: Array<Record<string, unknown>> }; error?: string };
            if (data.error) return data;
            const items = (data.tracks?.items ?? []) as Array<{
              name: string;
              id: string;
              artists: Array<{ name: string; id: string }>;
              album: { name: string };
              duration_ms: number;
              external_urls: { spotify: string };
            }>;
            return {
              query: params.query,
              resultCount: items.length,
              tracks: items.map((t) => ({
                name: t.name,
                trackId: t.id,
                artists: t.artists.map((a) => ({
                  name: a.name,
                  id: a.id,
                })),
                album: t.album.name,
                durationMs: t.duration_ms,
                url: t.external_urls.spotify,
              })),
            };
          }

          case "search_artists": {
            if (!params.query)
              return { error: "query is required for search_artists." };
            const q = encodeURIComponent(params.query);
            const data = (await spotifyFetch(
              `/search?q=${q}&type=artist&limit=10`,
              token,
            )) as { artists?: { items?: Array<Record<string, unknown>> }; error?: string };
            if (data.error) return data;
            const items = (data.artists?.items ?? []) as Array<{
              name: string;
              id: string;
              genres: string[];
              followers: { total: number };
              popularity: number;
              external_urls: { spotify: string };
            }>;
            return {
              query: params.query,
              resultCount: items.length,
              artists: items.map((a) => ({
                name: a.name,
                artistId: a.id,
                genres: a.genres,
                followers: a.followers.total,
                popularity: a.popularity,
                url: a.external_urls.spotify,
              })),
            };
          }

          case "get_artist": {
            if (!params.artistId)
              return { error: "artistId is required for get_artist." };
            return spotifyFetch(`/artists/${params.artistId}`, token);
          }

          case "get_track": {
            if (!params.trackId)
              return { error: "trackId is required for get_track." };
            return spotifyFetch(`/tracks/${params.trackId}`, token);
          }

          default:
            return { error: `Unknown operation: ${operation}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "spotify_lookup",
      instructions:
        "You can search Spotify using the `spotify_lookup` tool. Operations: search_tracks (by query), search_artists (by query), get_artist (by artistId), get_track (by trackId).",
    };
  },
};

export default spotifyLookupSkill;
