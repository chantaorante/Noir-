#!/usr/bin/env bash
# NOIR encrypted database backup.
#   - pg_dump (custom format, compressed) streamed straight into `age` (never written unencrypted)
#   - rotation: keep N daily + M weekly (Sunday) backups
#   - records the run in backup_runs
# Modes:
#   docker (default): runs pg_dump inside the compose postgres container
#   direct:           uses $DATABASE_URL with local pg_dump (development/testing)
set -euo pipefail
umask 077

MODE="${BACKUP_MODE:-docker}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/noir}"
RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-/etc/noir/backup-recipient.txt}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
COMPOSE=(docker compose -f "$(dirname "$0")/../docker-compose.yml" --env-file "${ENV_FILE:-$(dirname "$0")/../../.env}")

[[ -s "$RECIPIENT_FILE" ]] || { echo "age recipient file missing: $RECIPIENT_FILE" >&2; exit 1; }
command -v age >/dev/null || { echo "age is not installed (sudo apt install age)" >&2; exit 1; }
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

run_sql() {
  if [[ "$MODE" == docker ]]; then "${COMPOSE[@]}" exec -T postgres psql -U noir -d noir -qtAc "$1"; else psql "$DATABASE_URL" -qtAc "$1"; fi
}
dump() {
  if [[ "$MODE" == docker ]]; then "${COMPOSE[@]}" exec -T postgres pg_dump -U noir -d noir -Fc -Z 6; else pg_dump "$DATABASE_URL" -Fc -Z 6; fi
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/daily/noir-$STAMP.dump.age"
START="$(date -u +%FT%TZ)"
RUN_ID="$(run_sql "INSERT INTO backup_runs (kind, started_at) VALUES ('backup', '$START') RETURNING id" | head -1)"

if dump | age -R "$RECIPIENT_FILE" -o "$OUT.partial"; then
  mv "$OUT.partial" "$OUT"
  sha256sum "$OUT" > "$OUT.sha256"
  BYTES="$(stat -c %s "$OUT")"
  run_sql "UPDATE backup_runs SET finished_at = now(), ok = true, file = '$(basename "$OUT")', bytes = $BYTES WHERE id = $RUN_ID" >/dev/null
  echo "backup ok: $OUT ($BYTES bytes)"
else
  rm -f "$OUT.partial"
  run_sql "UPDATE backup_runs SET finished_at = now(), ok = false, details = 'pg_dump or age failed' WHERE id = $RUN_ID" >/dev/null || true
  echo "backup FAILED" >&2
  exit 1
fi

# Weekly copy on Sundays.
if [[ "$(date -u +%u)" == 7 ]]; then cp "$OUT" "$OUT.sha256" "$BACKUP_DIR/weekly/"; fi

# Rotation (newest first, delete beyond limits).
ls -1t "$BACKUP_DIR"/daily/*.dump.age 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | while read -r f; do rm -f "$f" "$f.sha256"; done || true
ls -1t "$BACKUP_DIR"/weekly/*.dump.age 2>/dev/null | tail -n +"$((KEEP_WEEKLY + 1))" | while read -r f; do rm -f "$f" "$f.sha256"; done || true
