# OpenAstra Dashboard v2

Modern, real-time control dashboard for the OpenAstra agent runtime.

## Tech Stack

- **React 19** + TypeScript + Vite 6
- **Tailwind CSS 4** with custom dark theme
- **TanStack Query v5** for data fetching
- **Zustand** for lightweight state management
- **Recharts** for sparklines and charts
- **cmdk** for command palette (Ctrl+K)
- **Sonner** for toast notifications
- **Lucide** for icons

## Setup

```bash
cd dashboard
cp .env.example .env    # configure API_URL if needed
npm install
npm run dev             # http://localhost:5173
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Overview dashboard with KPIs, system health, live event feed |
| `/chat` | Chat playground to talk directly to agents |
| `/agents` | Agent & swarm management with detail panel |
| `/sessions` | Session history with filtering and detail view |
| `/memory` | 5-tier memory explorer with search |
| `/system` | Inference providers, channels, runtime info |
| `/settings` | API keys, theme, notifications, advanced config |

## Architecture

- `src/lib/api.ts` — REST API client with typed endpoints
- `src/hooks/use-websocket.ts` — WebSocket connection for live events
- `src/stores/` — Zustand stores for events and app state
- `src/types/api.ts` — Full TypeScript types matching the backend
- `src/hooks/use-mock-data.ts` — Sample data, exported empty outside demo mode
- `src/lib/demo.ts` — Demo-mode flag; `src/components/DemoOnly.tsx` — placeholder + banner

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/api` | Gateway REST base URL. `/api` is a same-origin prefix that must be stripped by your reverse proxy (the Vite dev proxy does this); the gateway itself serves `/auth`, `/agents`, … at the root. Set to the gateway origin to call it directly. |
| `VITE_WS_URL` | `ws(s)://<page host>/ws` | Gateway WebSocket URL (`wss` on HTTPS pages). |
| `VITE_DEMO_MODE` | unset | `true` shows sample data in a production build, with a visible "Demo mode" banner. |

The Vite dev server proxies `/api` (prefix stripped) and `/ws` to `localhost:8080`.

## Authentication

- Sign-in calls `POST /auth/login` and stores the returned access token. A
  failed login never creates a session — there is no offline fallback.
- On load, a stored token is checked for expiry and verified against the
  gateway before the app treats the user as signed in.
- The WebSocket authenticates with the `bearer.<jwt>` subprotocol, so the
  token is not placed in the URL.
- "Continue in dev mode" exists only under `npm run dev` and is compiled out
  of production builds.

## Demo mode and sample data

Sample data is shown only in demo mode (`npm run dev`, or a build with
`VITE_DEMO_MODE=true`). In a normal production build:

- Views backed by the gateway show live data, and empty states if a request
  fails — never sample data.
- Actions (approve/reject, pipeline runs) report failure if the gateway
  rejects them; they are never simulated.
- Views not yet wired to the gateway render a "Not connected yet" placeholder:
  `/agents/compare`, `/costs`, `/webhooks`, `/activity`, `/steering`,
  `/spawns`, `/model-router`, `/playground`, `/memory-graph`,
  `/token-heatmap`, `/audit-log`, `/guardrails`, `/user-profile`,
  `/agent-wizard`, `/ops-console`, `/approval-queue`, `/audit-viewer`,
  `/billing`, `/skill-marketplace`.

## Known gaps

- The dashboard is not served by the gateway image, Compose stack or Helm
  chart; host the `dist/` build behind the same reverse proxy as the gateway.
- Several API paths used by live views (`/dashboard/stats`, `/swarms`,
  `/providers`, `/channels`, `/memory`, `/chat`) have no matching gateway
  route yet and will show empty states.
- The access token is kept in `localStorage`; there is no refresh-token flow,
  so sessions end when the access token expires.
