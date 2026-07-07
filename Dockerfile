# syntax=docker/dockerfile:1
# Build stage: compile TypeScript with dev deps, then prune to production.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: slim Node + Chromium so the server can drive a real browser in-container.
# Running as root in Docker → the launcher auto-applies --no-sandbox (see src/session.ts).
FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./

# MCP server on stdio.
ENTRYPOINT ["node", "dist/index.js"]
