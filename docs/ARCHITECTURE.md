# NOIR — System Architecture (Technical Blueprint)

Status: Phase 1 deliverable. This document is the master blueprint. Detailed designs live in the
companion documents referenced in each section.

| Topic | Document |
|---|---|
| Database schema | [DATABASE.md](DATABASE.md) |
| HTTP + WebSocket contracts | [API.md](API.md) |
| Poker engine and state machine | [POKER_ENGINE.md](POKER_ENGINE.md) |
| Randomness, fairness, audit | [FAIRNESS_AND_AUDIT.md](FAIRNESS_AND_AUDIT.md) |
| Threat model and controls | [SECURITY.md](SECURITY.md) |
| Hosting on the home server | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Backups and restore | [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md) |
| Operating the platform | [ADMIN_GUIDE.md](ADMIN_GUIDE.md) |
| Test strategy and report | [TESTING.md](TESTING.md) |

---

## 1. System architecture diagram

```
                         Internet (optional)
                               │  HTTPS (443, Cloudflare edge)
                               ▼
                    ┌─────────────────────┐
                    │  Cloudflare Tunnel  │   outbound-only connection from the server,
                    │   (cloudflared)     │   no inbound port forwarding on the router
                    └──────────┬──────────┘
 LAN clients ─── HTTPS 443 ───┐│ http://caddy:80 (docker network)
 (browsers)                   ▼▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ Ubuntu Server 24.04 LTS — Docker Engine + Compose                            │
 │                                                                              │
 │  ┌────────────┐   ┌──────────────────────────────────────────────────────┐   │
 │  │   Caddy    │──▶│ noir-app (Node.js 22 LTS, single process, non-root)  │   │
 │  │ TLS, HTTP/2│   │                                                      │   │
 │  │ headers,   │   │  Fastify HTTP API  ──┐        Socket.IO gateway      │   │
 │  │ static SPA │   │  /api/*              │        /ws (cookie-authed)    │   │
 │  │ compression│   │                      ▼              │                │   │
 │  └────────────┘   │  ┌────────── Domain modules ───────▼─────────────┐  │   │
 │                   │  │ auth · users · ledger · tables · lobby · chat │  │   │
 │                   │  │ progression · gifts · tournaments · admin     │  │   │
 │                   │  │ moderation · notifications · audit · health   │  │   │
 │                   │  └───────────────┬───────────────────────────────┘  │   │
 │                   │                  │                                  │   │
 │                   │  ┌───────────────▼────────────┐  ┌───────────────┐  │   │
 │                   │  │ Table actors (1 per table) │──│ @noir/engine  │  │   │
 │                   │  │ serialized command queue,  │  │ pure, no I/O  │  │   │
 │                   │  │ timers, private fan-out    │  │ deterministic │  │   │
 │                   │  └───────────────┬────────────┘  └───────────────┘  │   │
 │                   └──────────────────┼──────────────────────────────────┘   │
 │                                      │ pg pool (parameterized SQL)          │
 │                   ┌──────────────────▼───────────┐   ┌───────────────────┐  │
 │                   │ PostgreSQL 16 (internal net  │◀──│ backup job        │  │
 │                   │ only, no published port)     │   │ pg_dump → age     │  │
 │                   └──────────────────────────────┘   │ encrypted, rotated│  │
 │                                                      └───────────────────┘  │
 └──────────────────────────────────────────────────────────────────────────────┘
 Host: UFW (22 LAN-only, 80/443 LAN), SSH keys only, fail2ban, unattended-upgrades
```

### Data flow of one poker action

```
Browser ──emit("table:action",{tableId,handId,seq,actionId,type,amount})──▶ Socket.IO gateway
  gateway: session already authenticated at handshake → zod-validate payload → per-socket rate limit
        ──▶ TableActor.enqueue(cmd)            (one queue per table: no concurrent mutation)
  actor: idempotency check on actionId → engine.applyAction(state, seat, action)
        engine returns {state', events[]} or a typed rejection
  actor: persist events (hash-chained) in one DB transaction → then fan-out:
        public events  → room "table:<id>"
        private events → only the socket(s) of the owning user ("user:<id>")
  browser: renders events; dealer animation plays them; it never decides anything.
```

---

## 2. Components and why each was chosen

| Component | Version (verified 2026-11-26) | Role | Why |
|---|---|---|---|
| Ubuntu Server | 24.04 LTS | Host OS | Supported to 2029 (2034 with Pro, free for personal use). Runs well on 7th-gen i5. Hardware compatibility is verified at install time (see DEPLOYMENT.md §1). |
| Docker Engine + Compose v2 | distro/Docker CE current | Packaging | One-command start/stop/update, isolated non-root containers, reproducible. |
| Node.js | 22 LTS (dev env has 22.x) | Runtime | Active LTS; same language as frontend; fast WebSocket I/O. |
| TypeScript | 5.9 (strict) | Language | TS 7.0 (native compiler) is out, but 5.9 is chosen because Vite, Vitest and typescript-eslint all still rely on the 5.x compiler API. Re-evaluate in Phase 10. |
| Fastify | 5.x | HTTP API | Fastest mainstream Node framework, schema-first, mature plugins (cookie, helmet, rate-limit, static). |
| Socket.IO | 4.8 | Real-time | Rooms, acks, automatic reconnection, transport fallback for flaky mobile networks. Raw `ws` would need all of that rebuilt. |
| zod | 4.x | Validation | One schema shared by client and server for every HTTP body and WS message. |
| PostgreSQL | 16 | Database | Ubuntu 24.04's packaged major; transactional, strong constraints, JSONB for event payloads. |
| node-postgres (`pg`) | 8.x | DB driver | Parameterized SQL only. No ORM: the schema is hand-designed and critical paths (ledger) need exact SQL. |
| @node-rs/argon2 | 2.x | Password hashing | Argon2id with prebuilt binaries (no native toolchain needed in the container). |
| otplib | 13.x | TOTP MFA | RFC 6238; works with any authenticator app; no paid SMS. |
| pino | (Fastify built-in) | Logging | Structured JSON, low overhead, rotated by Docker's local log driver. |
| React | 19.x | UI | Requested; mature ecosystem. |
| Vite | 8.x | Build | Fast builds, output is static files served by Caddy. |
| Framer Motion | current | UI motion | Layout/route transitions, toasts, modals. |
| SVG + Web Animations API | browser-native | Dealer & card animation | See §10: vector dealer with articulated hands; zero runtime licence cost; GPU-composited transforms. |
| lucide-react | current | Icons | Single consistent icon set (rule: no mixing). |
| Caddy | 2.x | Reverse proxy | Automatic HTTPS (local CA on LAN, real certs on a domain), HTTP/2/3, security headers, static SPA serving. |
| cloudflared | current | Remote access (optional) | Outbound-only tunnel; no router port forwarding; hides home IP. Requires a domain on Cloudflare (see §14). |
| age | 1.x | Backup encryption | Simple, modern, public-key encryption: the server only needs the public key to encrypt backups. |

**Rejected on purpose:** Redis (one process holds all live state; Postgres handles persistence; add Redis
only if a second app process is ever needed), Kafka, Kubernetes, microservices, an ORM, any paid SaaS.

### Modular monolith boundaries

Each module under `apps/server/src/modules/<name>` owns its routes, socket handlers, repository (SQL) and
service. Modules talk through service interfaces, never through each other's tables. The poker engine is
a separate package with **no I/O at all**, so it can be extracted into its own process (worker thread or
service) later without code changes. Game variants plug in via a `GameVariant` interface (deal pattern,
hand evaluator, betting structure), so Omaha is an added variant, not a rewrite.

---

## 3. Repository structure

```
noir/
├── package.json, pnpm-workspace.yaml, tsconfig.base.json
├── packages/
│   ├── shared/         # zod schemas, WS event contracts, DTO types, constants (no secrets)
│   └── engine/         # pure poker engine: cards, CSPRNG shuffle, evaluator, betting, pots,
│       ├── src/        #   fairness commitments + verifier
│       └── test/       #   rules + edge-case tests
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── config/        # env parsing (zod), fails fast on missing secrets
│   │   │   ├── db/            # pool, migration runner, transaction helper
│   │   │   ├── http/          # Fastify app, security plugins, error handler
│   │   │   ├── realtime/      # Socket.IO gateway, socket auth, rate limits
│   │   │   ├── modules/       # auth, users, ledger, tables, lobby, chat, progression,
│   │   │   │                  # gifts, tournaments, admin, moderation, notifications, audit
│   │   │   └── main.ts
│   │   └── test/              # integration + security tests (real Postgres)
│   └── web/
│       ├── src/
│       │   ├── design/        # tokens.css, primitives (Button, Input, Modal, Toast…)
│       │   ├── features/      # auth, lobby, table, dealer, chat, profile, admin…
│       │   └── net/           # API + socket clients
│       └── test/              # Playwright UI tests
├── db/migrations/             # 0001_init.sql … forward-only, checksummed
├── infra/
│   ├── docker-compose.yml, Dockerfile, Caddyfile
│   ├── scripts/               # install, backup, restore, healthcheck, update
│   └── systemd/               # backup timer units
├── tests/load/                # 10/25/50/100 simulated-client harness
└── docs/                      # the 12 required documents
```

---

## 4–7. Database, engine, multiplayer, fairness

Summaries; the full designs are in the linked documents.

* **Database ([DATABASE.md](DATABASE.md))**: around 45 tables in 3NF. Money-like values are `BIGINT` minor units
  (1 ALL = 100 qindarka; the UI shows whole lek). The credit ledger is append-only: `UPDATE`/`DELETE` are
  blocked by a trigger, and every entry stores `balance_before`/`balance_after`, chained per user with a
  unique `(user_id, seq)` index, so concurrent writers cannot fork a balance.
* **Engine ([POKER_ENGINE.md](POKER_ENGINE.md))**: a state machine
  `WAITING → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → COMPLETE`, with an all-in runout shortcut. It is a
  pure function, `apply(state, command) → {state, events} | Rejection`, and is fully unit-tested.
* **Multiplayer**: each table is an in-process **actor** with a FIFO command queue. It is the single writer for
  that table's state, so simultaneous requests cannot race. Every client action carries `actionId` (UUID,
  idempotency) and `expectedSeq` (optimistic concurrency): duplicates are acknowledged without
  re-applying, and stale actions are rejected. Private data is emitted only to the `user:<id>` room.
  Reconnection sends a **per-viewer snapshot** built by `projectForViewer(state, userId)`, which strips
  every card the viewer may not see.
* **Fairness ([FAIRNESS_AND_AUDIT.md](FAIRNESS_AND_AUDIT.md))**: a CSPRNG Fisher–Yates shuffle
  (`crypto.randomInt`). A per-card salted commitment Merkle tree is published *before* the next hand. Players
  contribute entropy *after* seeing the commitment, and that entropy permutes the deal order. Each card
  shown to a player comes with its Merkle proof. Mucked and undealt cards are never revealed. Hand events are
  hash-chained.

## 8. Security and threat model

See [SECURITY.md](SECURITY.md). The target is the OWASP ASVS 4.0.3 Level 2 baseline, with stricter controls for
admin, ledger and game integrity.

## 9. Administrator and credit-ledger architecture

* The admin UI lives at `/admin`, a separate route bundle (code-split) that loads only for staff roles. Every admin API is
  under `/api/admin/*` and guarded server-side by **permission** checks (not role-name checks).
* Roles are Owner, Administrator, Moderator and Player, built from permissions such as `credits.grant`, `users.suspend`,
  `chat.moderate` and `config.security`. Moderators get moderation permissions only.
* **High-risk actions** (credit grant/correction, role change, password reset, security config) need a
  permission, MFA enrolled, and a **step-up re-authentication** (TOTP code within the last 5 minutes).
  They write an `admin_audit_log` row in the *same transaction* as the change.
* **Credit flow:** `wallet ⇄ table stack`. A buy-in is a ledger debit (`TABLE_BUY_IN`) and leaving is a credit
  (`TABLE_CASH_OUT`). Hand results change table stacks, which are persisted per hand. Admin grants and
  corrections are separate entry types that must have a reason. No entry type exists for deposits,
  withdrawals or user-to-user transfers. **Credits are non-redeemable game credits; "ALL" is a display
  label only.**

## 10. Frontend design system and dealer animation

* **Tokens** (CSS custom properties): obsidian `#0B0B0D`, charcoal `#16171A`, raised `#1E2024`,
  felt `#0F3B2E→#0A2A21`, champagne gold `#C9A96A`, silver `#B8BCC6`, and danger, success and info colours that
  pass WCAG AA contrast on dark surfaces. Type: "Cormorant Garamond" for display (only brand moments) and
  "Inter" for UI, both self-hosted (no Google request at runtime). The spacing scale is 4px-based, with radii of 6/10/16 and
  three elevation shadows.
* **Primitives:** Button (primary/secondary/ghost/danger), Input, Select, Modal, Toast, Badge, Tooltip,
  Card, Skeleton, EmptyState, ErrorState.
* **Responsive table:** seat coordinates come from an ellipse parameterised by viewport aspect. On portrait
  phones the table becomes a tall oval, the hero seat is pinned bottom-centre with large cards, the action bar sits in the
  thumb zone, and chat is a bottom sheet.
* **Dealer:** a layered **SVG character** (torso, head, two arms, each a 3-segment rig: upper arm, forearm,
  hand) animated with the Web Animations API on `transform` only (GPU-composited). Each server event maps
  to a choreography: `HAND_STARTED → collect+shuffle+cut`, `HOLE_DEALT → n deal motions` (card sprite travels from
  the dealer's hand to the seat), `STREET → burn+place`, `POT → sweep`, `SHOWDOWN → reveal gesture`, and between
  hands `idle` (breathing, card squaring). The animation **queue never blocks input**: the action bar
  is driven directly by state, and if animations fall behind the queue fast-forwards. `prefers-reduced-motion`
  or a low-power device swaps the choreography for instant placement with fades. Rive was considered and
  rejected for v1: it needs a commissioned `.riv` asset and its runtime is about 150 KB, while the SVG rig is fully owned and
  tweakable in code.

## 11. Deployment on the dedicated computer

See [DEPLOYMENT.md](DEPLOYMENT.md). In short: Ubuntu 24.04 → Docker → `infra/docker-compose.yml` (caddy, app,
postgres, backup), with Postgres on an internal network and no host port. LAN access uses `https://noir.lan` via Caddy's
internal CA. Remote access uses an optional Cloudflare Tunnel container.

## 12. Capacity assessment (100 concurrent users) — estimate, not a measurement

Back-of-envelope figures, to be **verified in Phase 9 by the load harness**; no benchmark is claimed yet:

* **Connections:** a Socket.IO socket costs roughly 20–50 KB of heap, so 100 sockets is about 5 MB.
* **Game traffic:** 100 players at 6 per table is about 17 tables. One hand is about 60 events at roughly 300 B each, and one hand every 60 s per table
  gives roughly 17 × 60 × 300 B / 60 s ≈ 5 KB/s, times a fan-out of about 6, so under 50 KB/s total.
* **Database:** about 20 writes per hand (batched per action transaction), so 17 tables need under 10 writes/s. Postgres on an SSD handles
  thousands.
* **CPU:** hand evaluation is a few µs, and a showdown with 9 players is far below 1 ms. Argon2id logins, at about 50–100 ms each with
  64 MiB, are the heaviest operation, so login concurrency is capped (a semaphore of 4).
* **Memory budget (16 GB):** Postgres about 1–2 GB (`shared_buffers=1GB`), the app about 300 MB, Caddy under 50 MB, and the OS about 1 GB. That leaves
  ample headroom.
* **Expected conclusion:** the hardware is very likely more than sufficient for 100 users, and the limiting factor is
  more likely the **home upload bandwidth and its stability** than CPU or RAM. This remains a hypothesis until measured.

## 13. Phased implementation plan

The 10 phases from the brief, executed in that order with one adjustment: the engine (Phase 3) is
built immediately after the blueprint, because every later phase depends on its correctness. Each phase
ends with its tests recorded in [TESTING.md](TESTING.md), marked passed, failed or not yet run.

## 14. External dependencies and costs

| Item | Required? | Cost |
|---|---|---|
| All software (Ubuntu, Docker, Node, Postgres, Caddy, npm packages) | Yes | Free / open source (MIT, Apache-2.0, PostgreSQL licence, ISC) |
| Electricity for 24/7 host | Yes | About 25–40 W idle for a 7th-gen i5 desktop, roughly 220–350 kWh a year |
| Domain name | Only for remote access with real HTTPS | About €10 a year (.com). LAN-only use needs none. |
| Cloudflare account + Tunnel | Optional | Free plan. Dependency: Cloudflare terminates TLS at its edge, so it can technically see traffic. |
| SMTP for password reset / verification | Optional | Free tiers exist. Without SMTP, admins issue one-time reset links. |
| UPS (recommended) | Optional | About €50–100. Protects against power-loss corruption. |
| Off-site backup copy | Recommended | A USB drive (one-off) or any storage; backups are encrypted with age before leaving the box. |

## Assumptions to verify

1. **Exact CPU model** (`lscpu`) and SSD health (`smartctl -a`) at install (DEPLOYMENT.md §1).
2. **Upload bandwidth** of the home connection (`speedtest`). It sets the real remote capacity.
3. **Whether a domain will be bought.** Until then, remote access is not configured and LAN works fully.
4. **SMTP availability.** Without it, email verification is disabled and resets are admin-issued.
5. **Legal:** credits stay non-redeemable. Any real-money element requires an Albanian legal and regulatory
   assessment first and is **not implemented**.
