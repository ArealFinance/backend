# Multi-stage build. Yields a slim runtime image without dev deps or sources.
#
# We `COPY` the SDK and vendor tarball alongside the backend so the
# `file:../sdk` and `file:../vendor/arlex-client-0.3.1.tgz` references in
# package.json resolve. CI must produce a build context with the parent
# `areal.newera/` directory mounted; run from `areal.newera/`:
#
#   docker build -f backend/Dockerfile -t areal-backend:$(git rev-parse --short HEAD) .

FROM node:22-alpine AS builder
WORKDIR /workspace
# Copy SDK + vendor first so changes to backend/src/** don't bust this layer.
COPY sdk ./sdk
COPY vendor ./vendor
COPY backend/package.json backend/package-lock.json* ./backend/
WORKDIR /workspace/backend
RUN npm ci
COPY backend ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S areal && adduser -S areal -G areal
COPY --from=builder --chown=areal:areal /workspace/backend/dist ./dist
COPY --from=builder --chown=areal:areal /workspace/backend/node_modules ./node_modules
COPY --from=builder --chown=areal:areal /workspace/backend/package.json ./
# SDK + vendor live alongside so `file:../sdk` resolves at runtime.
COPY --from=builder --chown=areal:areal /workspace/sdk ../sdk
COPY --from=builder --chown=areal:areal /workspace/vendor ../vendor
USER areal
EXPOSE 3010
CMD ["node", "dist/main.js"]
