# The market SERVER only. The DSH client plugin is distributed separately
# (build it with tools/pack-dist.mjs) and reaches this service through MARKET_SERVICE_URL.
#
# Zero runtime dependencies: server/ imports Node built-ins and local modules
# only, so there is no npm install layer and nothing to compile.
#
# NODE_IMAGE is overridable so a restricted network can point it at a mirror:
#   docker build --build-arg NODE_IMAGE=<mirror>/library/node:24-alpine -t dsh-plugin-market-selfhosted .
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="dsh-plugin-market-selfhosted" \
      org.opencontainers.image.description="Self-hosted DSH plugin marketplace server (accounts, permissions, catalog, artifacts, statistics)"

WORKDIR /app

# Container defaults: listen on every interface and keep all state on /data.
# Start-market.sh itself still defaults to 127.0.0.1 outside the container.
ENV NODE_ENV=production \
    MARKET_HOST=0.0.0.0 \
    MARKET_PORT=8787 \
    MARKET_DATA_DIR=/data

COPY package.json ./
COPY server ./server
COPY web ./web
COPY start-market.sh ./

# `sed` strips CRLF in case the checkout was made on Windows with
# core.autocrlf=true — a CRLF shebang would make the ENTRYPOINT unrunnable.
RUN sed -i 's/\r$//' start-market.sh \
 && chmod 755 start-market.sh \
 && mkdir -p /data \
 && chown -R node:node /app /data

# The SQLite database lives on /data and is created on first start, together
# with the admin account whose initial password is printed to the log.
# With a host bind mount instead of a named volume, the directory must be
# writable by uid 1000 (the `node` user): chown -R 1000:1000 ./market-data
USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MARKET_PORT||8787)+'/dsh-market/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/app/start-market.sh"]
