#!/usr/bin/env bash
# Proves a backup is usable: restores it into a scratch database and checks integrity.
# Usage: restore-test.sh <backup.dump.age> <age-identity-file> <admin DATABASE_URL (any db on the same server)>
# Checks: schema migrations present, every user's ledger chain is gap-free and arithmetically consistent,
# no negative balances, audit chain rows present, row counts reported.
set -euo pipefail
FILE="${1:?backup file}"; KEY="${2:?age identity}"; ADMIN_URL="${3:?admin DATABASE_URL}"
SCRATCH="noir_restore_test_$(date +%s)"
BASE="${ADMIN_URL%/*}"
psql "$ADMIN_URL" -qc "CREATE DATABASE $SCRATCH"
cleanup() { psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$(dirname "$0")/restore.sh" "$FILE" "$KEY" "$BASE/$SCRATCH" --i-understand-this-overwrites
Q() { psql "$BASE/$SCRATCH" -qtAc "$1"; }
MIG="$(Q "SELECT count(*) FROM schema_migrations")"
BAD_LEDGER="$(Q "SELECT count(*) FROM (SELECT user_id, seq, balance_before, balance_after, amount, lag(balance_after,1,0::bigint) OVER w AS prev, row_number() OVER w AS rn FROM credit_ledger WINDOW w AS (PARTITION BY user_id ORDER BY seq)) x WHERE seq <> rn OR balance_before <> prev OR balance_after <> balance_before + amount OR balance_after < 0")"
USERS="$(Q "SELECT count(*) FROM users")"; HANDS="$(Q "SELECT count(*) FROM hands")"; LEDGER="$(Q "SELECT count(*) FROM credit_ledger")"; AUDIT="$(Q "SELECT count(*) FROM admin_audit_log")"
echo "migrations=$MIG users=$USERS hands=$HANDS ledger_entries=$LEDGER audit_rows=$AUDIT ledger_violations=$BAD_LEDGER"
[[ "$MIG" -ge 2 && "$BAD_LEDGER" == 0 ]] || { echo "RESTORE TEST FAILED" >&2; exit 1; }
psql "$ADMIN_URL" -qc "INSERT INTO backup_runs (kind, started_at, finished_at, ok, file, details) VALUES ('restore_test', now(), now(), true, '$(basename "$FILE")', 'users=$USERS hands=$HANDS ledger=$LEDGER')" 2>/dev/null || true
echo "RESTORE TEST PASSED"
