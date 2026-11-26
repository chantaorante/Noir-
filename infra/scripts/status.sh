#!/usr/bin/env bash
# Quick operator status: containers, readiness, disk, last backup.
set -uo pipefail
cd "$(dirname "$0")/../.."
C=(docker compose -f infra/docker-compose.yml --env-file .env)
"${C[@]}" ps
echo; echo "Readiness:"; "${C[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text()).then(console.log)"
echo; df -h / | tail -1
echo; echo "Last backups:"; "${C[@]}" exec -T postgres psql -U noir -d noir -c "SELECT kind, ok, finished_at, file, pg_size_pretty(bytes) FROM backup_runs ORDER BY id DESC LIMIT 5"
