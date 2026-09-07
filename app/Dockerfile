# ---- build stage: compile TypeScript -------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage --------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOME=/home/node \
    PORT=8080 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# ca-certificates: outbound HTTPS (page reading + Anthropic API)
# git: the Claude CLI probes for it at startup; harmless but avoids warnings
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

# /data: settings + overview cache. /home/node: Claude CLI state and, if you
# prefer `claude login` over a setup-token, its credentials.
RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /home/node /app
USER node
VOLUME ["/data", "/home/node"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "dist/server.js"]
