# Admin guide

This guide is for the Owner and for Administrators and Moderators running a NOIR community.

## Roles

| Role | Can do |
|---|---|
| Owner | Everything, including changing roles and system configuration. Exactly one is created at install. |
| Admin | Users, invitations, credits, tables, moderation, audit views, announcements. Cannot promote anyone to Owner. |
| Moderator | Reports, chat moderation (hide messages, mute players), view users and tables. No credit or role changes. |
| Player | Play, chat, social features. |

All staff accounts must enable two-factor authentication (Settings → Security) before the admin panel opens.
Sensitive actions also ask for a fresh authenticator code ("step-up") if you have not given one in the last 5 minutes.
Step-up is required for: creating users, changing roles, password-reset links, credit grants and corrections,
credit limits, invitations, ledger export, and hand investigations.

## First day

1. Run `create-owner` (see DEPLOYMENT.md), open the printed link, set a strong password.
2. Settings → Security → enable two-factor. Store the recovery codes offline.
3. Admin → Configuration: review the configuration values (each is a JSON value; changes are audited).
4. Admin → Tables: create one or two public tables with sensible blinds and buy-ins.
5. Admin → Invitations: create invitations. Each has a code, an optional expiry and a use count. Send the link to the person yourself.

## Credits

Credits are game-only and non-redeemable. Never accept money, goods or favours in exchange for credits, and do not
let players arrange that among themselves: it would turn NOIR into something it is not designed or licensed to be.

- **Grant**: adds credits to a player's wallet. Requires a reason, which is stored permanently.
- **Correction**: a negative or positive adjustment to fix a mistake. Also requires a reason. The original entry is never edited.
- **Limits**: optional per-player caps on buy-ins.
- **Ledger** (Admin → Credits): every entry with its before/after balance. "Export CSV" downloads it (step-up required).
- The user detail page shows "Ledger intact". If it ever shows broken, stop granting credits and see TROUBLESHOOTING.md.

Every grant, correction and limit change also lands in the audit log with your account, time and IP address.

## Users

Admin → Users lets you search, open a player, and:
- suspend (cannot log in, sessions revoked) or ban (permanent), and restore;
- mute in chat for a period;
- revoke all sessions (forces re-login everywhere);
- create a password-reset link (24 hours, single use) and send it to the player yourself;
- change role (step-up required).

## Moderation

Admin → Moderation shows player reports. Mark a report "reviewing" while you look into it, take any action needed
from the user page (mute, suspend, ban) or hide the offending chat message, then mark the report "actioned" or "dismissed".
Hidden messages disappear from chat for everyone but stay in the database for the audit trail.

## Tables

Admin → Tables lists every table with players and status. You can pause (no new hands; the current hand finishes),
resume, or close a table (players are cashed out to their wallets after the current hand).
A server restart voids any hand in progress and returns each player to their stack before that hand; this is recorded.

## Audit and security

- **Audit log**: every staff action, hash-chained. The header shows whether the chain verifies.
- **Security events**: failed logins, lockouts, MFA changes, session revocations.
- **Hand investigation** (step-up): full event history of a hand including all hole cards, for dispute resolution.
  Use it only for a real dispute; the lookup itself is audited.

## Announcements

Admin → Announcements posts a message to the lobby for everyone, with an optional end date.

## Backups

Admin → Dashboard shows the last recorded backup. Backups run nightly via systemd (see BACKUP_AND_RECOVERY.md).
Run `infra/scripts/restore-test.sh` at least monthly; an untested backup is not a backup.

## Things NOIR deliberately does not do

- No real-money features of any kind, and no credit transfers between players.
- No way for staff to see a player's hole cards during a live hand.
- No editing or deleting of ledger entries, hand events, or audit records.
