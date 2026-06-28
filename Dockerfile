# Multi-stage build. Yields a slim runtime image without dev deps or sources.
#
# We `COPY` the SDK and vendor tarball alongside the backend so the
# `file:../sdk` and `file:../vendor/arlex-client-0.3.1.tgz` references in
# package.json resolve. CI must produce a build context with the parent
# `areal.newera/` directory mounted; run from `areal.newera/`:
#
#   docker build -f backend/Dockerfile -t areal-backend:$(git rev-parse --short HEAD) .

# Stage 0: build @areal/sdk. Its `dist/` is gitignored and it has no `prepare`
# script, so the backend build needs the SDK pre-built. Building it in-image
# makes the whole build self-contained — no host-side `npm run build` / rsync of
# `sdk/dist` required (which is what made manual deploys fragile).
FROM node:22-alpine AS sdk-builder
WORKDIR /workspace
# @areal/sdk dev-depends on @arlex/client (file:../vendor/arlex-client-*.tgz),
# so the vendor sibling must be present for the SDK's own `npm ci`.
COPY vendor ./vendor
COPY sdk/package.json sdk/package-lock.json* ./sdk/
WORKDIR /workspace/sdk
RUN npm ci
COPY sdk ./
RUN npm run build && rm -rf node_modules

FROM node:22-alpine AS builder
WORKDIR /workspace
# Copy the pre-built SDK (from sdk-builder, dist/ included) + vendor first so
# changes to backend/src/** don't bust this layer.
COPY --from=sdk-builder /workspace/sdk ./sdk
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
# The backend (ESM) imports @areal/sdk via a `file:../sdk` symlink in
# node_modules. @areal/sdk's ESM dist (.mjs) imports @solana/web3.js /
# @solana/spl-token / @arlex/client as EXTERNALS, and ESM resolves those from
# the SDK's REAL path (/sdk) — not the backend's node_modules. So point
# /sdk/node_modules at the backend's hoisted node_modules. (CJS used to resolve
# these via the symlink's logical path; the SDK's move to ESM `import`
# conditions broke that, crashing runtime with ERR_MODULE_NOT_FOUND.)
RUN ln -s /app/node_modules /sdk/node_modules
USER areal
EXPOSE 3010
CMD ["node", "dist/main.js"]
