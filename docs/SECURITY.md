# Security Architecture and Threat Model

No system is unhackable. NOIR uses defence in depth against a documented threat model. The baseline target is
**OWASP ASVS 4.0.3 Level 2**, with stricter controls for admin, ledger and game integrity.

## Assets

1. Hidden game information: hole cards, the deck and salts.
2. Credit balances and the ledger.
3. Accounts, especially Owner and Administrator.
4. Integrity of results, XP and tournaments.
5. Personal data (usernames, emails, IPs in login history).

## Adversaries

| Adversary | Capability | Main controls |
|---|---|---|
| Curious or cheating player | Modifies the client, replays or forges WS messages, scripts actions | Server-authoritative engine, zod validation, per-viewer projection, idempotency + seq, rate limits, bot heuristics |
| Colluding players | Share cards out of band, chip-dump | Cannot be fully prevented. Integrity alerts (same-IP seating, soft-play and chip-dump patterns) go to human review. |
| Credential attacker | Stuffing, brute force | Argon2id, lockout with backoff, per-IP and per-account limits, MFA mandatory for staff |
| Web attacker | XSS, CSRF, clickjacking, injection | React escaping + no `dangerouslySetInnerHTML`, strict CSP, SameSite cookies + CSRF token + Origin check, `frame-ancestors 'none'`, parameterized SQL |
| Malicious or compromised moderator | Abuses moderation tools | Least privilege: no credit, security or fairness permissions. All actions are audit-logged and hash-chained. |
| Network attacker | Sniffing, MITM | TLS everywhere (Caddy / Cloudflare), HSTS, `Secure` cookies |
| Host-level attacker | Exploits exposed services | Only 443 exposed (or none, with the tunnel). DB not published. SSH keys only, LAN-only. Non-root containers. Updates. |

## Application controls

**Authentication**
* Argon2id (`m=64 MiB, t=3, p=1`) via `@node-rs/argon2`. Passwords are 10–128 characters and checked against a common-password list.
  At most 4 hashes run at once, as a DoS guard.
* Login failures increase `failed_logins`. After 5 the account locks for 15 min, doubling up to 24 h. Failures are recorded per IP and per account in `login_events`.
  Error messages do not reveal whether a username exists.
* Sessions use an opaque 256-bit random token in cookie `noir_sid`, which is `HttpOnly; Secure; SameSite=Lax; Path=/`. Only its SHA-256 is stored.
  The idle timeout is 7 days and the absolute limit 30 days. The session ID **rotates** on login and on privilege change (MFA step-up). Logout and admin revocation delete or mark rows,
  and sockets of revoked sessions are disconnected immediately.
* **MFA (TOTP, RFC 6238)** is optional for players and **mandatory** for owner/admin/moderator: staff cannot use `/api/admin/*`
  until enrolled. Each time step is accepted once (`totp_last_step`). Recovery codes are single use and stored hashed. The TOTP secret
  is encrypted at rest with AES-256-GCM using `NOIR_DATA_KEY`.
* **Step-up.** High-risk permissions need `sessions.mfa_at` within the last 5 minutes (`POST /api/auth/step-up`).
* Accounts are created by invitation code (hashed, expiring, limited uses) or directly by an admin. Admin password resets issue a single-use
  link that expires in 1 hour. Admins never see or set passwords.

**Authorization**
* Every route declares a required permission. Checks run in a Fastify `preHandler` against the DB-loaded role.
  Staff cannot act on users of equal or higher rank, so an Admin cannot demote the Owner.
* WebSocket handlers check seat ownership: the user ID always comes from the session, never from the payload.

**Input and output**
* Every HTTP body, query and WS payload is parsed by a zod schema (strict objects, length and range limits). Unknown fields are rejected.
* Bodies are limited to 64 KB and WS messages to 4 KB (`maxHttpBufferSize`).
* SQL uses only `$1` placeholders. No string concatenation of user input.
* Chat is stored raw and rendered as text by React, which escapes it. Control characters are stripped, links blocked by default (configurable), and a word filter applied.

**CSRF.** Cookie auth plus `SameSite=Lax`, plus a per-session CSRF token required in the `X-CSRF-Token` header on every
state-changing request, plus a strict `Origin` check. The Socket.IO handshake also checks `Origin`.

**Headers** (set by the app; Caddy adds HSTS):
`Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` (camera, mic and geolocation off), `Cross-Origin-Opener-Policy: same-origin`.

**Rate limits.** Login is limited to 10/min per IP and 5/min per username, the general API to 300/min per session, and the WS to 20 events/s per socket (burst 40).
Chat allows 12 messages/min and table actions 5/s. Excess WS traffic is dropped and then disconnects the socket, with a security event logged.

**Replay and duplicates.** Each table action has a client `actionId` (UUID v4) and `expectedSeq`. A repeated `actionId` returns the
original result without re-applying. A stale `expectedSeq` is rejected. Timestamps come only from the server clock.

**Errors.** Clients get generic messages with a correlation ID. Stack traces are logged server-side only.

**Secrets.** Secrets live in `.env` on the server (mode 600, not in git) and are injected as container env. Nothing secret enters the Vite bundle,
because only `VITE_`-prefixed variables are exposed and none are secret. The app refuses to start with missing or default secrets.

## Game-integrity and anti-cheat

* Authoritative engine, CSPRNG, commitments (see FAIRNESS_AND_AUDIT.md).
* Decision time per action is stored, and bot heuristics flag very low variance in decision times or 24/7 activity.
* Collusion indicators: repeated co-seating, the same IP or device at one table (blocked by default for public tables), chip-dump patterns
  (large folds into one player), and soft-play. These create `integrity_alerts` with evidence, and **no automatic bans**.

## Infrastructure controls

See DEPLOYMENT.md. UFW denies all incoming except 443 (LAN), and 22 only from the LAN subnet. SSH accepts keys only, with root login off and fail2ban.
Postgres has no published port and lives on the internal Docker network. Containers run as a non-root user with `read_only` root filesystems,
`no-new-privileges` and `cap_drop: [ALL]`. Unattended security upgrades are on. Backups are age-encrypted.

## Dependency hygiene

Versions are pinned via the lockfile. `pnpm audit --prod` runs in CI and before each release. There are no post-install scripts except allow-listed ones.

## Legal boundary (product rule)

Credits are **non-redeemable game credits**. There are no deposits, withdrawals, user-to-user transfers or cash prizes. "ALL" is a display label.
Enabling any real-money element requires an Albanian legal and regulatory assessment first.
