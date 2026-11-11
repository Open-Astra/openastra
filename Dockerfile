FROM node:25-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ─────────────────────────────────────────────────

# Pin by digest for reproducible production builds, e.g.
#   FROM node:20-slim@sha256:<digest>   (docker buildx imagetools inspect node:20-slim)
# Dependabot (.github/dependabot.yml, "docker" ecosystem) keeps the tag current.
FROM node:25-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Runtime config read from the working directory at startup:
#   SOUL.md      — ethical-constraint prompt prefix (context/assembler.ts)
#   astra.yml    — agent team + system config (override with a volume mount)
#   prompts/     — system prompts referenced from astra.yml via !include
COPY SOUL.md astra.yml ./
COPY prompts/ ./prompts/

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Run as the unprivileged "node" user (uid/gid 1000) shipped with the base image.
RUN chown -R node:node /app
USER node

# node:20-slim ships neither curl nor wget — probe with node itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/gateway/index.js"]
