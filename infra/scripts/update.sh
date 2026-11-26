#!/usr/bin/env bash
# Update NOIR: back up first, pull code, rebuild, restart. Migrations run automatically at app start.
set -euo pipefail
cd "$(dirname "$0")/../.."
./infra/scripts/backup.sh
git pull --ff-only
docker compose -f infra/docker-compose.yml --env-file .env up -d --build
docker compose -f infra/docker-compose.yml --env-file .env ps
