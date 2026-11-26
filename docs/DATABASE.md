# Database Design

PostgreSQL 16. Schema: `db/migrations/0001_init.sql`; reference data: `0002_reference_data.sql`. 52 tables.
Migrations are forward-only. Each one is applied in a transaction under an advisory lock, and its SHA-256 is recorded in
`schema_migrations`, so editing an applied migration stops the app at boot instead of drifting silently.

## Conventions

* UUID primary keys (`gen_random_uuid()`). Users also get a short sequential `public_id`, shown as the "Player ID".
* Credits are `BIGINT` whole units. The app maps int8 to JS numbers and refuses anything beyond 2^53.
* `CITEXT` for usernames and emails (case-insensitive uniqueness).
* Every foreign key is declared. `CHECK` constraints encode the business rules, so the database rejects impossible states even if
  application code has a bug.
* **Append-only tables** (`credit_ledger`, `xp_ledger`, `hand_events`, `admin_audit_log`) have a `BEFORE UPDATE OR DELETE` trigger
  that raises an exception.

## Entity groups and relationships

```
roles ─< role_permissions >─ permissions
roles ─< users ─┬─ user_credentials (1:1)      sessions >─ users          login_events >─ users
                ├─ user_profiles (1:1)          invitations >─ roles        password_reset_tokens >─ users
                ├─ user_progress (1:1) ── levels      xp_ledger >─ users     level_history >─ users
                ├─ player_stats (1:1)           user_achievements >─ achievements      quest_progress >─ quests
                ├─ credit_ledger (1:N, seq)     account_limits (1:1)
                ├─ friendships / friend_requests / user_blocks / user_mutes (self-relations)
                └─ user_inventory >─ items ─< gift_history
poker_tables ─< table_sessions >─ users          poker_tables ─< table_invites
poker_tables ─< hands ─┬─ hand_secrets (1:1, restricted)   ├─ hand_entropy   ├─ hand_players >─ users
                       ├─ hand_events (hash chain)          ├─ player_actions └─ hand_pots
tournaments >─ tournament_structures      tournaments ─< tournament_participants >─ users     poker_tables >─ tournaments
chat_channels ─< chat_messages >─ users   notifications >─ users   announcements   reports ─< moderation_actions
integrity_alerts   admin_audit_log (hash chain)   security_events   app_config   backup_runs
```

## The most important tables

**`credit_ledger`** is the only source of truth for balances. Each row has `seq` (per user), `amount`, `balance_before` and `balance_after`,
with the constraint `CHECK (balance_after = balance_before + amount)`, `CHECK (balance_after >= 0)` and `UNIQUE (user_id, seq)`. Writers lock
the user row (`SELECT … FOR UPDATE`), read the latest entry and append the next `seq`, so two concurrent writers can never produce the
same `seq` (verified with 25 concurrent grants). `ADMIN_GRANT` and `ADMIN_CORRECTION` require `admin_id` and a reason of at least 5 characters.
Optional `idempotency_key UNIQUE` makes retried admin requests safe. Entry types deliberately exclude deposits, withdrawals and transfers.
The balance is the `balance_after` of the latest entry. `verifyUserLedger()` and `restore-test.sh` re-verify the whole chain.

**`table_sessions`** records a player's time at a seat. The buy-in moves credits wallet → stack (ledger debit) and leaving moves them back (credit).
`stack` is updated in the hand-completion transaction, so a crash mid-hand reverts to the last completed hand. Partial unique indexes
stop a seat being double-booked and a user taking two seats at one table.

**`hands` / `hand_players` / `hand_events` / `hand_pots`**: one row per hand with the public fairness commitment (`deck_root`,
`entropy_mix`). The per-seat outcome and hole cards are kept for the owner's history and disputes. Events are the hash-chained, append-only log of
every engine event with its visibility. Pots record final awards.

**`hand_secrets`** holds the committed deck order and salts. Only `fairness.investigate` (with step-up and audit) can read it, and it is purged after 90 days.

**`player_actions`**: every submitted action (accepted or rejected) with the client `action_id` as primary key (idempotency) and
`decision_ms`, which feeds bot and collusion analytics.

**`xp_ledger`**: append-only, with `UNIQUE (user_id, source, reference_id)`, so a hand, quest or achievement can award XP only once even if
processing is retried. `user_progress` is a derived cache and can be rebuilt from it.

**`admin_audit_log`**: hash-chained (`prev_hash`, `hash`) and append-only. It is written in the same transaction as the change it describes.

## Indexes (main query paths)

Ledger by user (`user_id, seq DESC`), by time, and by admin. Open sessions per user. Active table sessions. Running hands.
Hand players by user. Chat by channel (`channel_id, id DESC`). Notifications by user. Reports by status. Security events by time.

## Personal data

Stored: username, display name, optional email, IPs and user agents in sessions and login history (security purpose, 180-day retention),
and chat messages. No real names, addresses, dates of birth or payment data. See BACKUP_AND_RECOVERY.md for retention and deletion.
