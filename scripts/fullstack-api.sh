#!/bin/sh
# Starts the real API for the full-stack browser suite (web/playwright.fullstack.config.ts)
# on a fresh, throwaway ato_e2e database in the local Docker Postgres. Never touches
# the hosted database or your local `ato` data.
set -eu
cd "$(dirname "$0")/.."
docker compose up -d --wait db >/dev/null
docker compose exec -T db psql -q -U ato -d ato -c "drop database if exists ato_e2e with (force)" -c "create database ato_e2e"
DB="postgres://ato:ato@localhost:5432/ato_e2e?sslmode=disable"
MIGRATION_DATABASE_URL="$DB" go run ./cmd/migrate
exec env DATABASE_URL="$DB" PORT=3202 ATO_MODE=enforce \
  INGEST_TOKEN=fullstack-ingest-token ANALYST_TOKEN=fullstack-analyst-token \
  go run ./cmd/server
