import { z } from "zod";
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── push_notify ────────────────────────────────────────────────────
// Sends a push notification to a user via Firebase Cloud Messaging.
// Looks up the user's FCM token from Postgres, then dispatches the
// notification via the FCM v1 HTTP API (no firebase-admin dependency).

// ── FCM v1 HTTP API Client ─────────────────────────────────────────

interface ServiceAccount {
  project_id: string;
  private_key: string;
  client_email: string;
}

let cachedServiceAccount: ServiceAccount | null = null;
let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

function getServiceAccount(): ServiceAccount | null {
  if (cachedServiceAccount) return cachedServiceAccount;

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) return null;

  try {
    const raw = readFileSync(credPath, "utf-8");
    cachedServiceAccount = JSON.parse(raw) as ServiceAccount;
    return cachedServiceAccount;
  } catch {
    return null;
  }
}

async function getFcmAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const sa = getServiceAccount();
  if (!sa) return null;

  const privateKey = await importPKCS8(sa.private_key, "RS256");

  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    console.error("[push-notify] Failed to get access token:", await res.text());
    return null;
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

async function sendFcmMessage(
  projectId: string,
  token: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<string> {
  const accessToken = await getFcmAccessToken();
  if (!accessToken) throw new Error("Failed to obtain FCM access token");

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data,
        },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`FCM send failed: ${err}`);
  }

  const result = (await res.json()) as { name: string };
  return result.name;
}

// ── Tool Registration ──────────────────────────────────────────────

const PushNotifyParams = z.object({
  uid: z.string().describe("The user ID to send the notification to"),
  title: z.string().describe("Notification title"),
  body: z.string().describe("Notification body text"),
  data: z
    .record(z.string(), z.string())
    .optional()
    .describe("Optional key-value data payload"),
});

registerTool({
  name: "push_notify",
  retryable: true,
  description:
    "Send a push notification to a user's device. Use this to alert users about important events or time-sensitive information.",
  parameters: PushNotifyParams,

  async execute(params, _ctx) {
    const sa = getServiceAccount();
    if (!sa) {
      return {
        success: false,
        message: "Push notifications not configured — no service account credentials found.",
      };
    }

    // Look up the user's FCM token from Postgres
    const pool = getPool();
    const { rows } = await pool.query<{ fcm_token: string | null }>(
      "SELECT fcm_token FROM users WHERE id = $1",
      [params.uid],
    );

    if (rows.length === 0 || !rows[0]!.fcm_token) {
      return {
        success: false,
        message: "Push notifications not enabled — no FCM token registered for this user.",
      };
    }

    const fcmToken = rows[0]!.fcm_token;

    const messageId = await sendFcmMessage(
      sa.project_id,
      fcmToken,
      params.title,
      params.body,
      params.data,
    );

    return {
      success: true,
      message: `Notification sent to user ${params.uid}`,
      messageId,
    };
  },
});
