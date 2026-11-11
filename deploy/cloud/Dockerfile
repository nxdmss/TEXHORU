# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV NODE_OPTIONS=--max-old-space-size=1024
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json ./server/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund && npm --prefix server ci --no-audit --no-fund
COPY . .
RUN npm --prefix server run prisma:local:generate && npm run build:all

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
LABEL org.opencontainers.image.title="TEXHORU"
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./server/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm --prefix server ci --omit=dev --no-audit --no-fund && \
    cd server && npx playwright install --with-deps --only-shell chromium && \
    rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/server/node_modules/.prisma ./server/node_modules/.prisma
COPY --from=build /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/dist ./dist
COPY server/prisma/schema.local.prisma ./server/prisma/schema.local.prisma
COPY deploy/cloud/init.mjs deploy/cloud/import.mjs deploy/cloud/data-files.mjs deploy/cloud/entrypoint.sh ./deploy/cloud/
RUN mkdir -p /data /uploads && chown node:node /data /uploads && \
    chmod 0755 deploy/cloud/entrypoint.sh && \
    chmod 0644 deploy/cloud/init.mjs deploy/cloud/import.mjs deploy/cloud/data-files.mjs server/package.json server/package-lock.json server/prisma/schema.local.prisma
USER node
WORKDIR /app/server
EXPOSE 3000
ENTRYPOINT ["/app/deploy/cloud/entrypoint.sh"]
