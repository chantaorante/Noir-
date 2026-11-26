# NOIR

A private, self-hosted, invitation-only No-Limit Texas Hold'em platform for a small community.
It runs on one home server (designed against an Intel i5 7th gen, 16 GB RAM, 256 GB SSD on Ubuntu Server 24.04).

**NOIR uses game credits only.** Credits are denominated "ALL" for display, have no cash value, cannot be bought,
withdrawn, redeemed, or transferred between players, and are issued only by administrators through an append-only ledger.
There is no payment, deposit, or withdrawal code anywhere in this repository.

## What is in the box

| Area | Summary |
|---|---|
| Poker engine | Pure TypeScript state machine (`packages/engine`): 2 to 9 seats, blinds, antes, raise-to semantics, incomplete all-in rules, side pots, odd-chip rule, showdown order, timeouts. |
| Shuffle and fairness | Node CSPRNG Fisher–Yates for the deck secret, plus the NOIR-CARD-v1 commit–reveal protocol: every card a player sees is verified in their browser against a commitment published before the hand. See `docs/FAIRNESS_AND_AUDIT.md` for exactly what it does and does not prove. |
| Server | Fastify + Socket.IO (`apps/server`). One serialized actor per table, events persisted before broadcast, hole cards sent only to their owner. |
| Database | PostgreSQL 16, 52 tables, append-only credit and XP ledgers and hand events enforced by triggers, hash-chained admin audit log. |
| Security | Argon2id, TOTP two-factor (required for staff), step-up re-authentication for sensitive admin actions, CSRF and Origin checks, rate limits, lockout, strict CSP. See `docs/SECURITY.md`. |
| Web client | Plain HTML, CSS and JavaScript modules in `apps/web/static`, no framework and no build step: lobby, tables with an animated dealer, chat, profiles, leaderboards, missions, achievements, cosmetic gifts, settings, admin panel. Works on phone, tablet and desktop. |
| Operations | Docker Compose + Caddy (automatic HTTPS), optional Cloudflare Tunnel, encrypted `age` backups with an automated restore test, host hardening script. |

## Quick start (development)

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createdb noir            # or use docker compose's postgres
cp .env.example apps/server/.env   # fill in DATABASE_URL, NOIR_DATA_KEY (openssl rand -hex 32), PUBLIC_ORIGINS=http://localhost:3000, STATIC_DIR=../web/static
pnpm build
pnpm dev:server          # migrations run automatically on start
# open http://localhost:3000 (the server also serves the web client)
node apps/server/dist/cli/create-owner.js owner "Your Name"   # prints a one-time setup link
```

## Production

Follow `docs/DEPLOYMENT.md` end to end. In short: harden the host, write `.env` with generated secrets,
`docker compose up -d --build`, create the owner, enable two-factor, then set up and test backups (`docs/BACKUP_AND_RECOVERY.md`).

## Tests

```bash
pnpm test                 # engine + server integration (needs a local Postgres test database) + web unit tests
pnpm e2e                  # Playwright browser tests at desktop, tablet and phone sizes
pnpm load 50 120          # 50 simulated players for 120 s against a disposable database
```

`docs/TESTING.md` lists what has actually been run, the results, and what has not been verified yet.

## Documentation

| Document | Contents |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, data flow, table actors, failure handling |
| [SECURITY](docs/SECURITY.md) | Threat model and ASVS L2 control mapping |
| [DATABASE](docs/DATABASE.md) | Schema, invariants, retention |
| [API](docs/API.md) | HTTP and WebSocket contract |
| [POKER_ENGINE](docs/POKER_ENGINE.md) | Rules as implemented |
| [FAIRNESS_AND_AUDIT](docs/FAIRNESS_AND_AUDIT.md) | Shuffle, commit–reveal protocol, audit chain, limits |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Ubuntu install to running service |
| [BACKUP_AND_RECOVERY](docs/BACKUP_AND_RECOVERY.md) | Encrypted backups and tested restore |
| [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | Running the community day to day |
| [TESTING](docs/TESTING.md) | Test strategy and the honest results |
| [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) | Symptoms and fixes |

## Status

This is not yet declared production-ready. See the "Not yet verified" section of `docs/TESTING.md`.
