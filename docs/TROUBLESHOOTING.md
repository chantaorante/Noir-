# Troubleshooting

Start with `infra/scripts/status.sh`: it shows container health, disk, memory, the last backup and recent errors.
Logs: `docker compose logs --tail=200 app` (or `caddy`, `postgres`).

## The app container will not start

| Log message | Cause | Fix |
|---|---|---|
| `Invalid configuration: NOIR_DATA_KEY must be 64 hex chars` | Missing or malformed key | `openssl rand -hex 32`, put it in `.env`. **Never change it on a running install**: it encrypts two-factor secrets, so a new key locks out every MFA user. |
| `Refusing to start: database password is missing or weak` | Production guard | Set a long random `POSTGRES_PASSWORD` in `.env` before first start. |
| `migration checksum mismatch` | A migration file was edited after it ran | Restore the original file from Git. Never edit applied migrations; add a new one. |
| `ECONNREFUSED ... 5432` | Postgres not healthy yet or crashed | `docker compose ps`, then `docker compose logs postgres`. Disk full is the usual cause. |

## The site does not load

- **Browser says certificate not trusted (LAN)**: install Caddy's local root CA on that device (DEPLOYMENT.md §6), or use the Tunnel.
- **"Forbidden origin" / every request returns 403**: the address in the browser is not listed in `PUBLIC_ORIGINS`. Add the exact origin (scheme + host + port), restart the app.
- **Works on Wi-Fi but not remotely**: you have not configured the Cloudflare Tunnel or port forwarding; see DEPLOYMENT.md §7.

## Login problems

- **"Too many attempts"**: per-IP rate limit (10/min by default) or account lockout after 5 failures with backoff. Wait, or an admin can reset the password, which clears the lockout.
- **Authenticator code always rejected**: the device clock is off. NOIR accepts ±1 step (30 s). Fix the phone's time sync. Each code works once.
- **Lost authenticator**: sign in with one of the recovery codes shown when two-factor was enabled (each works once), then re-enrol in Settings.
- **Lost authenticator and recovery codes**: there is no in-app reset yet (a known gap, see TESTING.md). The server operator can clear two-factor directly in the database, which the app's audit log will NOT record, so write down who did it and why:
  `docker compose exec postgres psql -U noir -c "UPDATE user_credentials SET totp_enabled=false, totp_secret_enc=NULL, totp_last_step=NULL, recovery_codes='{}' WHERE user_id=(SELECT id FROM users WHERE username='THE_USERNAME');"`
  Staff accounts are then blocked from the admin panel until they enrol again.

## Table problems

- **"The table moved on" when acting**: your view was a moment behind; it refreshes automatically. Act again.
- **Stuck on "Waiting for another player"**: at least two seated, not-sitting-out players with chips are required.
- **A hand disappeared after a restart**: expected. Hands in progress are voided on restart and stacks return to their values before that hand (see ARCHITECTURE.md). The hand is marked `voided` in the database.
- **Red "FAILED" in the fairness panel**: a revealed card did not match the pre-hand commitment. This should never happen. Do not ignore it: note the hand number, open it in Admin → hand investigation, and check the server logs. Possible causes include a modified server build or a proxy altering traffic.
- **Dealer animation missing**: the device requests reduced motion (OS accessibility setting). Gameplay is unaffected.

## Credits look wrong

1. Admin → Users → the player → check "Ledger intact".
2. Remember chips on a table are not in the wallet; the header shows wallet, the lobby shows wallet and on-table.
3. If a ledger is reported broken, stop all grants, take a backup, and run `infra/scripts/restore-test.sh` on the latest backup to see if the corruption predates it. Ledger rows cannot be edited through the app or by the app's database role, so breakage implies direct database access; review the audit log and host access.

## Backups

- **`backup.sh` fails with "recipient file not found"**: create the age public key file named in `BACKUP_AGE_RECIPIENT_FILE`.
- **Restore test fails**: keep the failing backup, read the script's output (it names the check that failed), and do not delete older backups until a restore test passes.
- **Disk filling up**: lower `BACKUP_KEEP_DAILY`, check `docker system df`, and prune old images with `docker image prune` (safe: removes only unused images).

## Performance

- Check `status.sh` for CPU, memory and event-loop delay. The load-test numbers in TESTING.md show what a 4-core VM handled; a home server will differ.
- If the database is slow, check disk space first, then `docker compose exec postgres psql -U noir -c "select * from pg_stat_activity"`.
