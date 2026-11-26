# Backup and Recovery

## What is backed up

| Item | How |
|---|---|
| PostgreSQL (all game, ledger, audit data) | `infra/scripts/backup.sh`: `pg_dump -Fc` streamed into `age` (never on disk unencrypted) |
| `.env` (secrets) | **Manually**, once, into a password manager. It is not in the automated backup on purpose, so a stolen backup does not carry the keys. |
| Caddy data (local CA) | Re-creatable. Back up `caddy_data` only if you want to avoid re-installing the LAN root cert. |
| Code and configuration | The Git repository |

## Keys

```bash
# On your laptop, NOT on the server:
age-keygen -o noir-backup-key.txt          # PRIVATE key → password manager + offline USB
age-keygen -y noir-backup-key.txt          # prints the public key (age1…)
# On the server:
sudo mkdir -p /etc/noir && echo 'age1…' | sudo tee /etc/noir/backup-recipient.txt
```

The server can encrypt but **cannot decrypt** its own backups. Compromising the server does not expose past backups.

## Schedule and rotation

The systemd timer runs daily at 04:15. It keeps the newest 14 daily backups and 8 weekly backups (Sundays) in `/var/backups/noir`, about 15 MB each early on.
Each run is recorded in `backup_runs` and shown on the admin dashboard. **Copy backups off the machine**: a USB drive weekly, or
`rclone` to any storage. They are already encrypted.

## Restore test (do this monthly)

```bash
# Copy a backup + your private key to any machine with PostgreSQL client tools, then:
./infra/scripts/restore-test.sh noir-YYYYMMDDTHHMMSSZ.dump.age noir-backup-key.txt postgres://user:pass@localhost:5432/postgres
```

It restores into a scratch database, verifies migrations, checks **every user's ledger chain** (gap-free sequence, before/after
arithmetic, no negative balances), prints row counts, and drops the scratch database.

**Verified in development (2026-11-26):** a backup of the integration-test database (6 users, 3 hands, 13 ledger entries) was
encrypted, checksum-verified, decrypted, restored and passed the integrity checks. That run used `BACKUP_MODE=direct`. The Docker-mode backup
on the real server is still **not yet tested** and is a Phase 10 acceptance item.

## Full recovery after disk failure

1. Install Ubuntu and Docker again (DEPLOYMENT.md §2–3). Restore `/opt/noir` from Git and `.env` from your password manager.
2. Start only Postgres: `docker compose -f infra/docker-compose.yml --env-file .env up -d postgres`.
3. Restore the newest backup (this overwrites the empty DB):
   ```bash
   docker compose -f infra/docker-compose.yml exec -T postgres sh -c 'cat > /tmp/r.dump' < <(age -d -i noir-backup-key.txt noir-….dump.age)
   docker compose -f infra/docker-compose.yml exec -T postgres pg_restore -U noir -d noir --clean --if-exists --no-owner /tmp/r.dump
   docker compose -f infra/docker-compose.yml exec -T postgres rm /tmp/r.dump
   ```
4. Start everything: `docker compose -f infra/docker-compose.yml --env-file .env up -d`.
5. Log in as Owner, check the dashboard, and run a restore test on the next backup.

Data loss window: up to 24 h (since the last nightly backup). If that is too much, add an hourly timer (the cost is CPU and disk only).

## Data retention

* `hand_secrets` (committed decks and salts) are purged after `HAND_SECRET_RETENTION_DAYS` (default 90). The commitment root and public events remain.
* Login events and security events: keep for 180 days (configurable cleanup job, Phase 9).
* Account deletion: `users.deleted_at` is set and personal fields (email, display name, bio) are cleared. Ledger and hand records stay, pseudonymised by user ID,
  because they are audit records.
