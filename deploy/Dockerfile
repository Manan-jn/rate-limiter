# Stage 1: Install production dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Stage 2: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json tsup.config.ts ./
RUN npm ci
COPY src ./src
RUN npm run build

# Stage 3: Minimal runtime image
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# Lua scripts are loaded from disk at startup — must be in the correct path
COPY --from=builder /app/src/store/lua ./dist/lua

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  CMD wget -qO- http://localhost:${PORT:-8080}/healthz || exit 1

# cluster.ts forks workers based on WORKERS env var (defaults to os.cpus().length)
CMD ["node", "dist/cluster.js"]
