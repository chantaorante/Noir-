# API and WebSocket Contracts

The source of truth is `packages/shared/src/index.ts`: zod schemas that the server enforces on every input. Objects are strict, so
unknown fields are rejected.

## Conventions

* Base path `/api`, JSON only, bodies of 64 KB or less. Amounts are integers in whole credits (display "ALL", non-redeemable).
* Auth uses the `noir_sid` cookie (HttpOnly, Secure, SameSite=Lax).
* Every `POST/PUT/PATCH/DELETE` requires the `X-Noir-Client: 1` header and a same-origin `Origin`. When signed in, it also requires
  `X-CSRF-Token: <csrf>`; the token is returned by `/auth/login`, `/auth/register` and `/auth/me`.
* Errors are `{ "error": "Human-readable message", "code": "MACHINE_CODE" }` with the appropriate status. A 500 includes `requestId`.

## HTTP endpoints

### Auth (`/api/auth`)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/login` | `{username, password, totp?}` | 401 `MFA_REQUIRED` when 2FA is on. 423 `LOCKED` after 5 failures. 10/min/IP. |
| POST | `/logout` | – | Revokes the session and disconnects its sockets |
| GET | `/me` | – | User, permissions, csrf, credits `{wallet,onTables}`, progress |
| POST | `/register` | `{inviteCode, username, displayName, password}` | Invitation only |
| POST | `/password` | `{currentPassword, newPassword}` | Revokes other sessions |
| POST | `/password-reset` | `{token, newPassword}` | Single-use admin-issued link token |
| POST | `/mfa/setup` → `/mfa/enable` | `{code}` | Returns 10 recovery codes once. Rotates the session. |
| POST | `/step-up` | `{code}` | Opens a 5-minute window for high-risk admin actions. Rotates the token. |
| GET/DELETE | `/sessions`, `/sessions/:id` | – | Device/session overview and revocation |
| GET | `/login-history` | – | Last 50 attempts |

### Player (`/api`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/tables` | Lobby list (public tables plus private ones you may view) |
| POST | `/tables` | Create a table. Players may create **private** tables (max 3 open). Public tables need `tables.manage`. |
| POST | `/tables/:id/invite`, `/tables/:id/close` | Host controls |
| GET | `/hands/:id`, `/me/hands` | Own hand history with fairness data (others' cards only if shown) |
| GET | `/profiles/:id` | Profile, stats, achievement gallery, gifts received |
| PATCH | `/me/profile` | Display name, avatar (catalogue), bio, equipped cosmetics you own |
| GET | `/leaderboards`, `/leaderboards/:key` | `level, xp, hands_played, hands_won, tournament_points, weekly, monthly`. Dense ranking. |
| GET | `/me/quests`, `/me/xp`, `/me/credits`, `/me/inventory` | Progress and history views |
| GET/POST | `/notifications`, `/notifications/read`, `/announcements` | Notification centre |
| GET/POST/DELETE | `/friends`, `/friends/requests`, `/friends/requests/:id/accept\|decline`, `/friends/:id` | Friends |
| POST/DELETE | `/blocks/:id`, `/mutes/:id` | Block and mute |
| POST | `/reports` | Report a user |
| GET/POST | `/gifts/catalog`, `/gifts` | Cosmetic gifts, per-item daily allowance. No credit value. |

### Admin (`/api/admin`; every route needs `admin.access` and staff MFA; **bold** = step-up required)
`GET /dashboard` · `GET /users` · `GET /users/:id` · **`POST /users`** · `POST /users/:id/status` · **`POST /users/:id/role`** ·
**`POST /users/:id/reset-password`** · `POST /users/:id/revoke-sessions` · `POST /users/:id/mute` · **`PUT /users/:id/limits`** ·
**`POST /invitations`** · `GET /invitations` · **`POST /credits`** `{userId, amount, kind: grant|correction, reason, idempotencyKey}` ·
`GET /credits/ledger?userId&type&from&to&adminId` · **`GET /credits/export`** (CSV) · `GET /tables` · `POST /tables/:id/status` ·
`GET /reports` · `POST /reports/:id` · `POST /chat/messages/:id/hide` · `GET /integrity-alerts` · `GET /audit` (with chain check) ·
`GET /security-events` · **`GET /hands/:id/investigate`** · `GET /config` · `PUT /config/:key` · `POST /announcements` · `GET /backups`

### Health
`GET /healthz` (liveness), `GET /readyz` (DB and migrations; blocked at Caddy from outside), `GET /api/status` (maintenance, denomination).

## WebSocket (Socket.IO, path `/ws`)

The handshake authenticates with the session cookie and checks `Origin` against `PUBLIC_ORIGINS`. Messages are 4 KB or less, with a token bucket of
20 msg/s (burst 40) per socket. Repeated abuse disconnects the socket. Every client→server event takes an ack callback that receives `{ok:true,data?}`
or `{ok:false,error,code}`.

### Client → server
| Event | Payload | Notes |
|---|---|---|
| `lobby:subscribe` | – | Ack contains table list. Then `lobby:tables` pushes (coalesced, at most 2/s). |
| `table:watch` | `{tableId, accessCode?}` | Joins the room. Ack carries a **per-viewer snapshot**. |
| `table:unwatch` | `{tableId}` | |
| `table:sit` | `{tableId, seat, buyIn, accessCode?}` | Ledger `TABLE_BUY_IN` in the same transaction as the seat |
| `table:leave` | `{tableId}` | Folds if it is your turn. Cashes out after the hand (`TABLE_CASH_OUT`). |
| `table:sitout` | `{tableId, sitOut}` | |
| `table:rebuy` | `{tableId, amount}` | Between hands only, up to the max buy-in |
| `table:entropy` | `{tableId, commitId, entropy(64 hex)}` | Fairness contribution for the announced next hand |
| `table:action` | `{tableId, handId, actionId(uuid), expectedSeq, type, amount?}` | `amount` = "raise to". Duplicate `actionId` returns the first result. A wrong `expectedSeq` gives `STALE` plus a fresh `table:snapshot`. |
| `table:snapshot` | `{tableId}` | Resync on demand |
| `chat:send` | `{channel: 'lobby' \| 'table:<id>', body}` | Table chat only while watching. 12/min plus burst control. |
| `chat:history` | `{channel}` | Last 50, excluding blocked and muted users |

### Server → client
| Event | Audience | Payload |
|---|---|---|
| `table:commitment` | table room | `{tableId, handId, commitId, root}`, the next hand's deck commitment |
| `table:handStarted` | table room | `{handId, handNo, fairness:{root, mix, contributions}}` |
| `table:event` | table room | `{tableId, handId, seq, eventSeq, hash, event, reveals?, deadline?}`. Engine events: `HAND_STARTED, ANTE_POSTED, BLIND_POSTED, HOLE_CARDS_DEALT, PLAYER_ACTED, TURN, STREET_DEALT, POTS_UPDATED, UNCALLED_RETURNED, SHOWDOWN, POT_AWARDED, HAND_ENDED` |
| `table:private` | **owner only** (`user:<id>` room) | `{event: HOLE_CARDS, reveals}`, your cards with Merkle proofs |
| `table:seats` | table room | Seat list (name, avatar, level, stack, sitting out, connected) |
| `table:timeout` | table room | `{seat, action}` |
| `table:gift` | table room | Gift animation trigger |
| `table:left` | user | `{cashOut, reason}` |
| `table:status` | table room | `open / paused / closed` |
| `chat:message` | lobby or table room | `{id, channel, userId, displayName, body, createdAt}` |
| `notify` | user | Level-up, achievement, mission, gift |
| `credits:changed` | user | `{balance}` after an admin grant |
| `session:revoked` | user's sockets of that session | Followed by disconnect |
