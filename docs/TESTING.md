# Testing

This file records what has actually been run and what the results were. Nothing here is projected or estimated.
If a row says "not run", it has not been run.

Test environment for every result below: a cloud Linux VM (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GB RAM), Node 22.23.5,
PostgreSQL 16 on the same VM, Chromium for browser tests. **This is not the target i5-7th-gen home server**, so timings
here do not transfer directly; rerun the suites on the real machine after deployment (commands below).

## How to run

| Suite | Command | Needs |
|---|---|---|
| Engine unit + property tests | `pnpm --filter @noir/engine test` | nothing |
| Server integration + security | `pnpm --filter @noir/server test` | Postgres with a `noir_test` database (dropped and recreated by the tests) |
| Web unit (browser fairness verifier) | `pnpm --filter @noir/web test` | nothing |
| Browser end-to-end | `pnpm e2e` | Postgres with a `noir_e2e` database; Chromium (`PW_CHROMIUM=/path/to/chrome` to use a system one) |
| Load | `pnpm load <players> <seconds>` | Postgres with a `noir_load` database |
| Backup and restore | `infra/scripts/backup.sh` then `infra/scripts/restore-test.sh <file>` | `age`, `pg_dump` |

The e2e, load and server suites each refuse to run against a database whose name does not mark it as a test database.

## Results

### Engine (`packages/engine`) — ENGINE_COUNT tests, all passing

- Hand evaluator checked against **all 2,598,960 five-card hands** (category counts match the known totals), and 7-card evaluation against brute force over 20,000 random hands.
- Shuffle: chi-square uniformity of card positions over 104,000 shuffles; a test asserts production code never references `Math.random`.
- Rules: blinds (including heads-up button-is-small-blind), raise-to semantics, minimum raise, incomplete all-in not reopening action, side pots with 3+ all-ins, uncalled bet refund, odd chip, split pots, showdown order, timeouts.
- Property test: **10,000 random hands** with 2–9 players, random stacks and random actions; chips are conserved in every hand.
- Fairness protocol: Merkle proofs verify, any tampered card/salt/proof fails, entropy mixing is order-independent and changes the deal.

### Server (`apps/server`) — 37 integration tests on real PostgreSQL, all passing

Auth (12): login, generic errors, lockout after 5 failures, CSRF / client-header / Origin enforcement, logout revocation,
TOTP required and replay rejected, MFA enrolment with session rotation, **single-use recovery codes**, invitation-only
registration, strict body validation, SQL-injection inertness, security headers, login rate limit (429 after 10/min).

Admin and ledger (14): RBAC for every role, MFA-required staff, step-up for high-risk actions, owner protection,
append-only ledger with before/after balances, idempotency keys, negative-balance prevention, 25 concurrent grants
serialized into a gap-free chain, no player path to change balances, CSV formula-injection neutralization, audit chain
verification and tamper detection, user creation without exposing passwords, suspension revoking sessions,
**maintenance mode** (blocks player sign-in and seating, staff still sign in, audited, reversible).

Multiplayer (8): socket auth and origin rejection, ledger-backed buy-in, entropy contribution, each player receives only
their own hole cards with valid proofs and no public event leaks them, out-of-turn / stale / forged actions rejected,
duplicate `actionId` idempotent, a hand completes with chips conserved, stats/XP updated and the event chain verified, a disconnected player times out and reconnects to a private-safe snapshot, two tables run concurrently, leaving cashes out the exact stack.

Recovery and chat (3): a server restart mid-hand voids the hand and restores pre-hand stacks with the ledger intact;
chat sanitization (control characters, links, word filter); real-time lobby chat with rate limits and mutes.

### Web unit — 1 test, passing

The browser verifier (`apps/web/src/lib/fairness.ts`, Web Crypto) produces identical results to the server engine for
commitments, entropy mixing, permutation and card proofs.

### Browser end-to-end (Playwright, Chromium) — 9 of 9 passing

Run against a real server and database seeded by `apps/server/test/e2e-server.ts`, in three viewports:
desktop 1440×900, tablet (iPad gen 7 profile), phone (Pixel 7 profile).

1. Login rejects a wrong password, accepts the right one, lobby lists the table.
2. Two separate browser sessions sit at a table, a hand is dealt, each sees only their own cards face up, actions are
   taken through the UI until the flop, and the fairness panel reports every revealed card as verified on the device (no failures).
3. Owner signs in with TOTP and opens the admin dashboard.

These tests found and fixed one real bug: the fairness panel showed no commitment for the current hand on some timings.

### Load — simulated players over real HTTP + Socket.IO

`apps/server/test/load.ts`: every simulated player logs in over HTTP (Argon2id), opens its own Socket.IO connection,
sits 6 per table, contributes entropy, and plays real hands with 150–800 ms think time (mostly check/call, some
folds and min-raises). After the run all players leave and the script checks that every credit is accounted for
and every ledger chain verifies.

**Important caveat:** the server and all simulated clients ran in the same Node process on the same VM, so CPU, memory
and event-loop figures include the clients' own work. They are an upper bound on server cost, not a measurement of it.

LOAD_RESULTS_TABLE

"Rejected during wind-down" are actions that arrived after the player had already left (leaving folds a player who is
to act), which is expected. "Ack latency" is the time from sending an action to receiving the server's acknowledgement,
which happens after the action is validated, persisted and broadcast.

What this does and does not show: it shows the code handles these player counts on this VM with no lost or duplicated
credits. It does not prove the same on the target i5 home server, over home internet, or with real phones on mobile
networks. **Do not treat 100 concurrent players as guaranteed on the production machine until `pnpm load 100 300` has
been run there.**

### Backup and restore — passed (direct mode)

`backup.sh` produced an `age`-encrypted `pg_dump`; `restore-test.sh` restored it into a scratch database and verified
row counts and every user's ledger chain: 6 users, 3 hands, 13 ledger entries, 0 violations.

## Not yet verified

| Item | Status |
|---|---|
| Docker Compose deployment, Caddy TLS, Cloudflare Tunnel | Not run: no Docker daemon in the build environment. Must be done on the real server following DEPLOYMENT.md. |
| `harden-host.sh`, systemd backup timer | Not run (would modify a host). |
| Performance on the i5 7th gen target | Not run. |
| Tournaments (Sit & Go) | **Not implemented.** Schema tables exist; there is no tournament gameplay or UI. |
| Direct messages | **Not implemented.** Lobby and table chat exist. |
| Integrity alerts | Admin view exists but nothing generates alerts yet. |
| QR code during MFA setup | Not implemented; the setup screen shows the key and an `otpauth://` link to enter manually. |
| In-app reset of a user's two-factor | Not implemented; see TROUBLESHOOTING.md for the database procedure. |
| Safari / Firefox browser tests | Not run; only Chromium. |
| Accessibility audit with a screen reader | Not run. Components use semantic roles and labels, which the e2e tests rely on, but no manual audit was done. |
| Penetration test by a third party | Not done. |

The project should not be called production-ready until the Docker deployment, backups on the real host, and a load
run on the target machine have been verified.
