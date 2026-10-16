# syntax=docker/dockerfile:1

# ---- build: compile TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime: compiled JS + the static page, no dev tooling, non-root ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
# A new named volume mounted here copies this directory's owner, so the node user can write it.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
# Run node directly (not via npm) so SIGTERM reaches the shutdown handler.
CMD ["node", "dist/server.js"]
