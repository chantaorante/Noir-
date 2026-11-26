#!/usr/bin/env bash
# Restore a NOIR backup into a target database.
# Usage: restore.sh <backup.dump.age> <age-identity-file> <target DATABASE_URL> [--i-understand-this-overwrites]
# The target database is DROPPED AND RECREATED (schema public). Without the confirmation flag the
# script only verifies decryption + archive integrity and exits.
set -euo pipefail
FILE="${1:?backup file}"; KEY="${2:?age identity (private key) file}"; TARGET="${3:?target DATABASE_URL}"; CONFIRM="${4:-}"
[[ -f "$FILE.sha256" ]] && sha256sum -c "$FILE.sha256" >/dev/null && echo "checksum ok"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
age -d -i "$KEY" -o "$TMP/db.dump" "$FILE"
pg_restore --list "$TMP/db.dump" > "$TMP/toc.txt"
echo "archive ok: $(grep -c 'TABLE DATA' "$TMP/toc.txt") tables with data"
if [[ "$CONFIRM" != "--i-understand-this-overwrites" ]]; then
  echo "Dry run only. Re-run with --i-understand-this-overwrites to replace the contents of the target database."
  exit 0
fi
psql "$TARGET" -v ON_ERROR_STOP=1 -qc "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$TMP/db.dump"
echo "restore complete"
