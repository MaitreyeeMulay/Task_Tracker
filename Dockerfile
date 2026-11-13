# node:24-alpine, pinned by digest (Dependabot keeps it current)
ARG NODE_IMAGE=node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: dependencies cannot run code at install time.
RUN npm ci --ignore-scripts --no-fund --no-audit

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Worker, migration and demo-seed scripts (M6). Node runs the TypeScript
# directly, with production dependencies only.
FROM ${NODE_IMAGE} AS tools
WORKDIR /tools
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Owned by root, so the app user can't change them at runtime.
COPY --from=tools /tools ./tools
# Public Amazon RDS root certificates, to verify the database's TLS (DB_CA_FILE).
COPY certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -T 5 -O /dev/null http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
