import type { Db, Queryable } from '../../db/pool.js';
import { newToken, sha256 } from './crypto.js';

export const SESSION_COOKIE = 'noir_sid';
export const IDLE_MS = 7 * 24 * 3600_000;
export const ABSOLUTE_MS = 30 * 24 * 3600_000;
export const STEP_UP_MS = 5 * 60_000;

export interface AuthUser {
  id: string;
  publicId: number;
  username: string;
  displayName: string;
  role: string;
  rank: number;
  status: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  permissions: Set<string>;
  chatMutedUntil: Date | null;
}

export interface AuthSession {
  id: string;
  csrf: string;
  mfaAt: Date | null;
  createdAt: Date;
}

export interface AuthContext { user: AuthUser; session: AuthSession }

export async function createSession(q: Queryable, userId: string, ip: string | null, ua: string | null, mfa: boolean): Promise<{ token: string; csrf: string; id: string }> {
  const token = newToken(32);
  const csrf = newToken(24);
  const r = await q.query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, ip, user_agent, mfa_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, CASE WHEN $7 THEN now() END) RETURNING id`,
    [userId, sha256(token), csrf, ABSOLUTE_MS / 1000, ip, ua?.slice(0, 300) ?? null, mfa],
  );
  return { token, csrf, id: r.rows[0]!.id };
}

/** Resolve a cookie token to an active session + user. Touches last_seen at most once per minute. */
export async function resolveSession(db: Db, token: string | undefined): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const r = await db.query(
    `SELECT s.id AS sid, s.csrf_token, s.mfa_at, s.created_at AS s_created, s.last_seen_at,
            u.id, u.public_id, u.username, u.status, u.suspended_until, u.chat_muted_until,
            p.display_name, r.key AS role, r.rank, c.totp_enabled, c.must_change_password,
            COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       JOIN user_profiles p ON p.user_id = u.id
       JOIN user_credentials c ON c.user_id = u.id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2) AND u.deleted_at IS NULL
      GROUP BY s.id, u.id, p.display_name, r.key, r.rank, c.totp_enabled, c.must_change_password`,
    [sha256(token), IDLE_MS / 1000],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!isUserActive(row.status, row.suspended_until)) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.sid]);
  }
  return {
    session: { id: row.sid, csrf: row.csrf_token, mfaAt: row.mfa_at, createdAt: row.s_created },
    user: {
      id: row.id, publicId: row.public_id, username: row.username, displayName: row.display_name, role: row.role, rank: row.rank,
      status: row.status, mfaEnabled: row.totp_enabled, mustChangePassword: row.must_change_password, permissions: new Set(row.perms), chatMutedUntil: row.chat_muted_until,
    },
  };
}

export function isUserActive(status: string, suspendedUntil: Date | null): boolean {
  if (status === 'active') return true;
  if (status === 'suspended' && suspendedUntil && suspendedUntil.getTime() < Date.now()) return true;
  return false;
}

export async function revokeSession(q: Queryable, sessionId: string, reason: string): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
}

export async function revokeAllForUser(q: Queryable, userId: string, reason: string, exceptSessionId?: string): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3) RETURNING id',
    [userId, reason, exceptSessionId ?? null],
  );
  return r.rows.map((x) => x.id);
}

export const isStaff = (u: AuthUser) => u.rank >= 50;
export const hasRecentMfa = (s: AuthSession) => !!s.mfaAt && Date.now() - s.mfaAt.getTime() < STEP_UP_MS;
