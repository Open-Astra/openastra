import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { getPool } from "../../../config/postgres.js";
import { safeFetch } from "../../helpers/http.js";

// ── OAuth Manager Skill ─────────────────────────────────────────────
// Manage OAuth2 tokens: store, refresh, and revoke.
// Persists tokens in Postgres for cross-session use.

const StoreTokenParams = z.object({
  provider: z.string().describe("OAuth provider name (e.g. google, github, slack)"),
  accessToken: z.string().describe("Access token"),
  refreshToken: z.string().optional().describe("Refresh token"),
  expiresIn: z.number().int().optional().describe("Token expiry in seconds"),
  tokenUrl: z.string().url().optional().describe("Token refresh endpoint URL"),
  clientId: z.string().optional().describe("OAuth client ID"),
  clientSecret: z.string().optional().describe("OAuth client secret"),
});

const GetTokenParams = z.object({
  provider: z.string().describe("OAuth provider name"),
  autoRefresh: z.boolean().default(true).describe("Automatically refresh if expired"),
});

const ListTokensParams = z.object({});

const RevokeTokenParams = z.object({
  provider: z.string().describe("OAuth provider to revoke"),
});

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  token_url TEXT,
  client_id TEXT,
  client_secret TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(uid, provider)
)`;

const oauthManagerSkill: SkillDefinition = {
  name: "oauth_manager",
  version: "1.0.0",

  manifest: {
    id: "oauth_manager",
    name: "OAuth Manager",
    description: "Store, refresh, and revoke OAuth2 tokens. Persistent token storage with auto-refresh.",
    category: "execute",
    tools: ["oauth_store", "oauth_get", "oauth_list", "oauth_revoke"],
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
      name: "oauth_store",
      description: "Store an OAuth2 token for a provider. Enables auto-refresh on future retrievals.",
      parameters: StoreTokenParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const expiresAt = params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null;

        await getPool().query(
          `INSERT INTO oauth_tokens (uid, provider, access_token, refresh_token, expires_at, token_url, client_id, client_secret, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (uid, provider) DO UPDATE SET
             access_token = $3, refresh_token = COALESCE($4, oauth_tokens.refresh_token),
             expires_at = $5, token_url = COALESCE($6, oauth_tokens.token_url),
             client_id = COALESCE($7, oauth_tokens.client_id),
             client_secret = COALESCE($8, oauth_tokens.client_secret),
             updated_at = NOW()`,
          [toolCtx.uid, params.provider, params.accessToken, params.refreshToken ?? null,
           expiresAt, params.tokenUrl ?? null, params.clientId ?? null, params.clientSecret ?? null],
        );

        return {
          success: true,
          provider: params.provider,
          expiresAt: expiresAt?.toISOString() ?? "never",
          hasRefreshToken: !!params.refreshToken,
        };
      },
    });

    ctx.registerTool({
      name: "oauth_get",
      description: "Get an OAuth2 token for a provider. Auto-refreshes if expired and refresh token is available.",
      parameters: GetTokenParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `SELECT * FROM oauth_tokens WHERE uid = $1 AND provider = $2`,
          [toolCtx.uid, params.provider],
        );

        if (result.rows.length === 0) return { error: `No token stored for provider "${params.provider}".` };

        const token = result.rows[0] as {
          access_token: string; refresh_token: string | null; expires_at: Date | null;
          token_url: string | null; client_id: string | null; client_secret: string | null;
        };

        // Check if expired
        const isExpired = token.expires_at && new Date(token.expires_at) < new Date();

        if (isExpired && params.autoRefresh && token.refresh_token && token.token_url && token.client_id) {
          // Attempt refresh
          try {
            const body = new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: token.refresh_token,
              client_id: token.client_id,
              ...(token.client_secret ? { client_secret: token.client_secret } : {}),
            });

            const res = await safeFetch(token.token_url, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: body.toString(),
              ssrfProtection: false,
            });

            if (res.ok) {
              const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
              const newExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;

              await getPool().query(
                `UPDATE oauth_tokens SET access_token = $3, refresh_token = COALESCE($4, refresh_token), expires_at = $5, updated_at = NOW()
                 WHERE uid = $1 AND provider = $2`,
                [toolCtx.uid, params.provider, data.access_token, data.refresh_token ?? null, newExpiry],
              );

              return {
                provider: params.provider,
                accessToken: data.access_token,
                refreshed: true,
                expiresAt: newExpiry?.toISOString() ?? null,
              };
            }
          } catch {
            // Refresh failed, return expired token
          }
        }

        return {
          provider: params.provider,
          accessToken: token.access_token,
          expired: !!isExpired,
          expiresAt: token.expires_at ? new Date(token.expires_at).toISOString() : null,
          hasRefreshToken: !!token.refresh_token,
        };
      },
    });

    ctx.registerTool({
      name: "oauth_list",
      description: "List all stored OAuth providers and their token status.",
      parameters: ListTokensParams,

      async execute(_params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `SELECT provider, expires_at, refresh_token IS NOT NULL as has_refresh, updated_at
           FROM oauth_tokens WHERE uid = $1 ORDER BY provider`,
          [toolCtx.uid],
        );

        return {
          count: result.rows.length,
          providers: (result.rows as Array<{ provider: string; expires_at: Date | null; has_refresh: boolean; updated_at: Date }>).map((r) => ({
            provider: r.provider,
            expired: r.expires_at ? new Date(r.expires_at) < new Date() : false,
            expiresAt: r.expires_at,
            hasRefreshToken: r.has_refresh,
            lastUpdated: r.updated_at,
          })),
        };
      },
    });

    ctx.registerTool({
      name: "oauth_revoke",
      description: "Remove a stored OAuth token.",
      parameters: RevokeTokenParams,

      async execute(params, toolCtx) {
        await ensureTable();
        const result = await getPool().query(
          `DELETE FROM oauth_tokens WHERE uid = $1 AND provider = $2`,
          [toolCtx.uid, params.provider],
        );

        return result.rowCount! > 0
          ? { success: true, revoked: params.provider }
          : { error: `No token found for "${params.provider}".` };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "oauth_manager",
      instructions: "You can manage OAuth tokens with `oauth_store` (save token), `oauth_get` (retrieve with auto-refresh), `oauth_list` (view all providers), and `oauth_revoke` (remove token). Tokens persist in Postgres.",
    };
  },
};

export default oauthManagerSkill;
