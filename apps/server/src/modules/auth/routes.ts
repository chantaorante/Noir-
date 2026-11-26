import { getMaintenance } from '../system/maintenance.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ChangePasswordBody, LoginBody, MfaEnableBody, RegisterBody, ResetPasswordBody, StepUpBody, UUID } from '@noir/shared';
import { withTx } from '../../db/pool.js';
import { clientIp, parse, requireAuth, type AppDeps } from '../../http/context.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../../http/errors.js';
import { securityEvent } from '../audit/audit.js';
import { balanceOf, onTables } from '../ledger/ledger.js';
import { decryptSecret, encryptSecret, getDummyHash, hashPassword, newToken, newTotpSecret, otpauthUrl, passwordProblem, sha256, verifyPassword, verifyTotp } from './crypto.js';
import { ABSOLUTE_MS, createSession, revokeAllForUser, revokeSession, SESSION_COOKIE, isUserActive } from './sessions.js';
import { insertUser } from './users.js';
import { disconnectSessions } from '../../realtime/registry.js';

const LOCK_THRESHOLD = 5;
const BASE_LOCK_MIN = 15;

export function authRoutes({ db, config }: AppDeps) {
  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: ABSOLUTE_MS / 1000 });

  return async (app: FastifyInstance) => {
    const loginLimit = { config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.ip } } };

    app.post('/login', loginLimit, async (req, reply) => {
      const body = parse(LoginBody, req.body);
      const ip = clientIp(req);
      const ua = req.headers['user-agent'] ?? null;
      const r = await db.query(
        `SELECT u.id, u.username, u.status, u.suspended_until, (SELECT key FROM roles WHERE id = u.role_id) AS role, c.password_hash, c.failed_logins, c.locked_until, c.totp_enabled, c.totp_secret_enc, c.totp_last_step, c.recovery_codes
           FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.username = $1 AND u.deleted_at IS NULL`,
        [body.username],
      );
      const row = r.rows[0];
      const fail = async (reason: string, userId: string | null) => {
        await db.query('INSERT INTO login_events (user_id, username_attempted, success, reason, ip, user_agent) VALUES ($1,$2,false,$3,$4,$5)', [userId, body.username, reason, ip, ua]);
      };
      if (!row) {
        await verifyPassword(await getDummyHash(), body.password);
        await fail('unknown_user', null);
        throw unauthorized('Incorrect username or password.');
      }
      if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
        await fail('locked', row.id);
        throw new HttpError(423, 'LOCKED', 'This account is temporarily locked after too many failed attempts. Try again later.');
      }
      if (!(await verifyPassword(row.password_hash, body.password))) {
        const failed = row.failed_logins + 1;
        const lockMinutes = failed >= LOCK_THRESHOLD ? Math.min(BASE_LOCK_MIN * 2 ** (failed - LOCK_THRESHOLD), 24 * 60) : 0;
        await db.query(`UPDATE user_credentials SET failed_logins = $2, locked_until = CASE WHEN $3 > 0 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE user_id = $1`, [row.id, failed, lockMinutes]);
        await fail('bad_password', row.id);
        if (lockMinutes) await securityEvent(db, 'account_locked', 'warn', { failed, lockMinutes }, row.id, ip);
        throw unauthorized('Incorrect username or password.');
      }
      if (!isUserActive(row.status, row.suspended_until)) {
        await fail(`status_${row.status}`, row.id);
        throw forbidden(row.status === 'suspended' ? 'This account is suspended.' : 'This account is not active.', 'ACCOUNT_INACTIVE');
      }
      if (getMaintenance().enabled && row.role === 'player') {
        await fail('maintenance', row.id);
        throw new HttpError(503, 'MAINTENANCE', getMaintenance().message || 'NOIR is in maintenance. Please try again later.');
      }
      let mfa = false;
      if (row.totp_enabled) {
        if (body.recoveryCode) {
          // Single use: remove the hash atomically; a concurrent second use finds nothing to remove.
          const used = await db.query('UPDATE user_credentials SET recovery_codes = array_remove(recovery_codes, $2) WHERE user_id = $1 AND $2 = ANY(recovery_codes) RETURNING cardinality(recovery_codes) AS left', [row.id, sha256(body.recoveryCode).toString('hex')]);
          if (!used.rowCount) {
            await fail('bad_recovery_code', row.id);
            throw unauthorized('That recovery code is not valid.');
          }
          await securityEvent(db, 'recovery_code_used', 'warn', { remaining: used.rows[0].left }, row.id, ip);
        } else {
          if (!body.totp) {
            return reply.status(401).send({ error: 'Enter the code from your authenticator app.', code: 'MFA_REQUIRED' });
          }
          const step = verifyTotp(decryptSecret(config.dataKey, row.totp_secret_enc), body.totp);
          if (step === null || (row.totp_last_step !== null && step <= row.totp_last_step)) {
            await fail('bad_totp', row.id);
            throw unauthorized('That code is not valid.');
          }
          await db.query('UPDATE user_credentials SET totp_last_step = $2 WHERE user_id = $1', [row.id, step]);
        }
        mfa = true;
      }
      await db.query('UPDATE user_credentials SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [row.id]);
      await db.query('INSERT INTO login_events (user_id, username_attempted, success, ip, user_agent) VALUES ($1,$2,true,$3,$4)', [row.id, body.username, ip, ua]);
      // Session fixation defence: any pre-existing cookie session is revoked and a fresh one issued.
      if (req.auth) await revokeSession(db, req.auth.session.id, 'relogin');
      const s = await createSession(db, row.id, ip, ua, mfa);
      setCookie(reply, s.token);
      return { csrf: s.csrf };
    });

    app.post('/logout', async (req, reply) => {
      const a = requireAuth(req);
      await revokeSession(db, a.session.id, 'logout');
      disconnectSessions([a.session.id]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/me', async (req) => {
      const a = requireAuth(req);
      const [bal, tables, prog] = await Promise.all([
        balanceOf(db, a.user.id),
        onTables(db, a.user.id),
        db.query('SELECT p.xp_total, p.level, l.rank_key, (SELECT xp_required FROM levels WHERE level = p.level + 1) AS next_xp, l.xp_required AS level_xp FROM user_progress p JOIN levels l ON l.level = p.level WHERE p.user_id = $1', [a.user.id]),
      ]);
      const pr = prog.rows[0];
      return {
        csrf: a.session.csrf,
        user: {
          id: a.user.id, publicId: a.user.publicId, username: a.user.username, displayName: a.user.displayName, role: a.user.role,
          mfaEnabled: a.user.mfaEnabled, mustChangePassword: a.user.mustChangePassword, permissions: [...a.user.permissions],
          staffMfaRequired: a.user.rank >= 50 && !a.user.mfaEnabled,
        },
        credits: { wallet: bal, onTables: tables, denomination: 'ALL' },
        progress: pr ? { xp: pr.xp_total, level: pr.level, rank: pr.rank_key, levelXp: pr.level_xp, nextLevelXp: pr.next_xp } : null,
      };
    });

    app.post('/register', loginLimit, async (req, reply) => {
      const body = parse(RegisterBody, req.body);
      const problem = passwordProblem(body.password, body.username);
      if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
      const user = await withTx(db, async (tx) => {
        const inv = await tx.query(
          `SELECT i.id, r.key AS role FROM invitations i JOIN roles r ON r.id = i.role_id
            WHERE i.code_hash = $1 AND i.revoked_at IS NULL AND i.expires_at > now() AND i.uses < i.max_uses FOR UPDATE OF i`,
          [sha256(body.inviteCode)],
        );
        if (!inv.rows[0]) throw badRequest('This invitation code is invalid or has expired.', 'BAD_INVITE');
        await tx.query('UPDATE invitations SET uses = uses + 1 WHERE id = $1', [inv.rows[0].id]);
        const u = await insertUser(tx, { username: body.username, displayName: body.displayName, role: inv.rows[0].role, password: body.password });
        return u;
      });
      const s = await createSession(db, user.id, clientIp(req), req.headers['user-agent'] ?? null, false);
      setCookie(reply, s.token);
      return { csrf: s.csrf };
    });

    app.post('/password', async (req) => {
      const a = requireAuth(req);
      const body = parse(ChangePasswordBody, req.body);
      const cred = (await db.query('SELECT password_hash FROM user_credentials WHERE user_id = $1', [a.user.id])).rows[0];
      if (!(await verifyPassword(cred.password_hash, body.currentPassword))) throw unauthorized('Current password is incorrect.');
      const problem = passwordProblem(body.newPassword, a.user.username);
      if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
      await db.query('UPDATE user_credentials SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE user_id = $1', [a.user.id, await hashPassword(body.newPassword)]);
      const revoked = await revokeAllForUser(db, a.user.id, 'password_changed', a.session.id);
      disconnectSessions(revoked);
      return { ok: true };
    });

    app.post('/password-reset', loginLimit, async (req) => {
      const body = parse(ResetPasswordBody, req.body);
      await withTx(db, async (tx) => {
        const t = (await tx.query('SELECT t.id, t.user_id, u.username FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() FOR UPDATE OF t', [sha256(body.token)])).rows[0];
        if (!t) throw badRequest('This reset link is invalid or has expired.', 'BAD_TOKEN');
        const problem = passwordProblem(body.newPassword, t.username);
        if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
        await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [t.id]);
        await tx.query('UPDATE user_credentials SET password_hash = $2, password_changed_at = now(), must_change_password = false, failed_logins = 0, locked_until = NULL WHERE user_id = $1', [t.user_id, await hashPassword(body.newPassword)]);
        disconnectSessions(await revokeAllForUser(tx, t.user_id, 'password_reset'));
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ MFA
    app.post('/mfa/setup', async (req) => {
      const a = requireAuth(req);
      if (a.user.mfaEnabled) throw badRequest('Two-factor authentication is already enabled.');
      const secret = newTotpSecret();
      await db.query('UPDATE user_credentials SET totp_secret_enc = $2 WHERE user_id = $1', [a.user.id, encryptSecret(config.dataKey, secret)]);
      return { secret, otpauthUrl: otpauthUrl(secret, a.user.username) };
    });

    app.post('/mfa/enable', async (req, reply) => {
      const a = requireAuth(req);
      const body = parse(MfaEnableBody, req.body);
      const c = (await db.query('SELECT totp_secret_enc, totp_enabled FROM user_credentials WHERE user_id = $1', [a.user.id])).rows[0];
      if (c.totp_enabled || !c.totp_secret_enc) throw badRequest('Start setup first.');
      const step = verifyTotp(decryptSecret(config.dataKey, c.totp_secret_enc), body.code);
      if (step === null) throw badRequest('That code is not valid. Check the time on your phone and try again.', 'BAD_TOTP');
      const codes = Array.from({ length: 10 }, () => newToken(8).replace(/[-_]/g, 'x').slice(0, 10));
      await db.query('UPDATE user_credentials SET totp_enabled = true, totp_last_step = $2, recovery_codes = $3 WHERE user_id = $1', [a.user.id, step, codes.map((x) => sha256(x).toString('hex'))]);
      // Privilege change → rotate the session.
      await revokeSession(db, a.session.id, 'rotated_mfa_enabled');
      disconnectSessions(await revokeAllForUser(db, a.user.id, 'mfa_enabled'));
      const s = await createSession(db, a.user.id, clientIp(req), req.headers['user-agent'] ?? null, true);
      setCookie(reply, s.token);
      return { csrf: s.csrf, recoveryCodes: codes };
    });

    app.post('/step-up', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
      const a = requireAuth(req);
      const body = parse(StepUpBody, req.body);
      const c = (await db.query('SELECT totp_secret_enc, totp_enabled, totp_last_step FROM user_credentials WHERE user_id = $1', [a.user.id])).rows[0];
      if (!c.totp_enabled) throw forbidden('Enable two-factor authentication first.', 'MFA_REQUIRED');
      const step = verifyTotp(decryptSecret(config.dataKey, c.totp_secret_enc), body.code);
      if (step === null || (c.totp_last_step !== null && step <= c.totp_last_step)) {
        await securityEvent(db, 'step_up_failed', 'warn', {}, a.user.id, clientIp(req));
        throw unauthorized('That code is not valid.');
      }
      await db.query('UPDATE user_credentials SET totp_last_step = $2 WHERE user_id = $1', [a.user.id, step]);
      // Rotate token in place on privilege elevation.
      const token = newToken(32);
      await db.query('UPDATE sessions SET token_hash = $2, mfa_at = now() WHERE id = $1', [a.session.id, sha256(token)]);
      setCookie(reply, token);
      return { ok: true, csrf: a.session.csrf };
    });

    // ------------------------------------------------------------ sessions & history
    app.get('/sessions', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC', [a.user.id]);
      return { sessions: r.rows.map((s) => ({ ...s, current: s.id === a.session.id })) };
    });

    app.delete('/sessions/:id', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      const r = await db.query('UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, a.user.id, 'user_revoked']);
      if (!r.rowCount) throw notFound();
      disconnectSessions([id]);
      return { ok: true };
    });

    app.get('/login-history', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT success, reason, ip, user_agent, created_at FROM login_events WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [a.user.id]);
      return { events: r.rows };
    });
  };
}
