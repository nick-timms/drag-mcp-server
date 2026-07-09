# Multi-stage build for the hosted MCP HTTP endpoint.
# Build with dev deps → ship a lean runtime image with prod deps only.

# ── Build stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# package.json is read at runtime for the version string (see src/server.ts),
# so it must be present alongside dist/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Documentational; the real port is MCP_PORT (default 3001).
EXPOSE 3001

# Health check hits the app's own /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/http.js"]
