# hadrontool-mcp — generic MCP conduit tool.
#
# Built by Komodo from this repo's `main`, pushed to GHCR, deployed on the
# `komodo_default` network. The service is INTERNAL-ONLY — hadron-server
# reaches it by container name at http://hadrontool-mcp:8080, and the
# conduit initiates every upstream connection itself, so NO route needs
# public ingress (the hadrontool-pdf deployment shape, not ms-exchange's).
#
# Secrets are injected at runtime by Doppler (`doppler run --`), matching
# the other Hadron services — Komodo sets only DOPPLER_TOKEN.
FROM node:22-slim

WORKDIR /app

# Doppler CLI for runtime secret injection (same pattern as the other services).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -sLf --retry 3 --tlsv1.2 --proto '=https' 'https://cli.doppler.com/install.sh' | sh \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080

# Reproducible install from the committed lockfile, then compile and drop
# dev deps. --include=dev because NODE_ENV=production would otherwise skip
# typescript and the build would fail.
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

USER node

EXPOSE 8080
# Doppler injects MCP_TOOL_TOKEN (and optional MCP_*_TIMEOUT_MS overrides)
# via DOPPLER_TOKEN. MCP_ALLOW_PRIVATE_NETWORKS must stay UNSET in prod.
CMD ["doppler", "run", "--", "node", "dist/index.js"]
