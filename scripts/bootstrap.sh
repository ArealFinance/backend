#!/usr/bin/env bash
# bootstrap.sh — bring a fresh checkout to "ready to run" state.
#
# Steps:
#   1. Verify .env exists (copy from .env.example if not).
#   2. Install npm dependencies.
#   3. Bring up local Postgres + Redis via docker-compose.
#   4. Wait for Postgres to accept connections.
#   5. Run migrations.
#   6. Print next-step hint.
#
# Idempotent — safe to re-run after a pull.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "==> .env not found — copying from .env.example. Edit secrets before running in any non-local context."
  cp .env.example .env
fi

echo "==> installing dependencies"
npm install --no-audit --no-fund

echo "==> bringing up local infra (postgres + redis)"
docker compose up -d postgres redis

echo "==> waiting for postgres to be ready"
for _ in {1..30}; do
  if docker compose exec -T postgres pg_isready -U areal -d areal >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> running migrations"
npm run migration:run

echo
echo "✓ Bootstrap complete."
echo "  Run:    npm run start:dev"
echo "  Docs:   http://127.0.0.1:3010/api/docs"
echo "  Health: http://127.0.0.1:3010/health"
