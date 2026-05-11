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
- `src/hooks/use-mock-data.ts` — Mock data for development without backend

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `/api` | Backend REST API base URL |
| `VITE_WS_URL` | `ws://localhost/ws/events` | WebSocket event stream URL |

The Vite dev server proxies `/api` and `/ws` to `localhost:8080` by default.
