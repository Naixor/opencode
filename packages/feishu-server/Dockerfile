# ============================================================================
# Feishu Auth Server — Multi-runtime Dockerfile
#
# Build:
#   docker build -t feishu-server .
#
# Run:
#   docker run -d --name feishu-server \
#     --env-file .env \
#     -p 3456:3456 \
#     feishu-server
#
# The image uses Bun for best performance.
# To use Node.js instead:
#   docker build --build-arg RUNTIME=node -t feishu-server .
# ============================================================================

ARG RUNTIME=bun

# --------------------------------------------------------------------------
# Stage: bun
# --------------------------------------------------------------------------
FROM oven/bun:1-alpine AS bun-base
WORKDIR /app
COPY package.json ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production
COPY src ./src
EXPOSE 3456
CMD ["bun", "run", "src/index.ts"]

# --------------------------------------------------------------------------
# Stage: node
# --------------------------------------------------------------------------
FROM node:22-alpine AS node-base
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 3456
CMD ["npx", "--yes", "tsx", "src/index.ts"]

# --------------------------------------------------------------------------
# Final: pick based on RUNTIME arg
# --------------------------------------------------------------------------
FROM ${RUNTIME}-base AS final
