import type { FastifyInstance, FastifyRequest } from 'fastify';
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { AdminCreateUserBody, AdminCreditBody, AdminInviteBody, AdminLimitsBody, AdminMuteBody, AdminRoleBody, AdminUserStatusBody, UUID } from '@noir/shared';
import { z } from 'zod';
import { withTx, type Queryable } from '../../db/pool.js';
import { clientIp, guard, parse, requireAuth, type AppDeps } from '../../http/context.js';
import { badRequest, forbidden, notFound } from '../../http/errors.js';
import { audit, verifyAuditChain } from '../audit/audit.js';
import { newToken, sha256 } from '../auth/crypto.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { insertUser } from '../auth/users.js';
import { balanceOf, onTables, postEntry, verifyUserLedger } from '../ledger/ledger.js';
import { disconnectSessions } from '../../realtime/registry.js';

const idParam = (req: FastifyRequest) => parse(UUID, (req.params as { id: string }).id);

/** Staff may only manage accounts of strictly lower rank (an Administrator cannot touch the Owner). */
async function target(q: Queryable, id: string, actorRank: number) {
  const r = await q.query('SELECT u.id, u.username, u.status, r.key AS role, r.rank FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1 AND u.deleted_at IS NULL', [id]);
  const t = r.rows[0];
  if (!t) throw notFound('User not found.');
  if (t.rank >= actorRank) throw forbidden('You cannot manage an account with an equal or higher role.');
  return t as { id: string; username: string; status: string; role: string; rank: number };
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV formula-injection guard
  return `"${s.replace(/"/g, '""')}"`;
};

export function adminRoutes({ db, tables, live }: AppDeps) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', guard('admin.access'));

    // ------------------------------------------------------------ dashboard
    app.get('/dashboard', { preHandler: guard('system.view') }, async () => {
      const q = (sql: string) => db.query(sql).then((r) => r.rows[0]);
      const [users, active, hands, recent, sec, acts, dbSize, backup] = await Promise.all([
        q(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`),
        q(`SELECT count(DISTINCT user_id)::int AS n FROM sessions WHERE last_seen_at > now() - interval '24 hours'`),
        q(`SELECT count(*)::int AS n FROM hands WHERE status = 'complete'`),
        db.query(`SELECT u.id, u.username, u.created_at FROM users u ORDER BY created_at DESC LIMIT 5`).then((r) => r.rows),
        db.query(`SELECT kind, severity, created_at FROM security_events ORDER BY id DESC LIMIT 10`).then((r) => r.rows),
        db.query(`SELECT a.action, a.target_type, a.created_at, p.display_name AS actor FROM admin_audit_log a LEFT JOIN user_profiles p ON p.user_id = a.actor_id ORDER BY a.id DESC LIMIT 10`).then((r) => r.rows),
        q(`SELECT pg_database_size(current_database())::bigint AS bytes`),
        q(`SELECT kind, ok, finished_at, bytes FROM backup_runs ORDER BY id DESC LIMIT 1`),
      ]);
      let disk: { total: number; free: number } | null = null;
      try {
        const s = await statfs('/');
        disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
      } catch { /* not available */ }
      const tl = tables.list();
      return {
        users: users.n, activeUsers24h: active.n, online: live.online(), activeTables: tl.filter((t) => t.summary().seated > 0).length, tables: tl.length,
        activeTournaments: 0, handsPlayed: hands.n, recentRegistrations: recent, recentSecurityEvents: sec, recentAdminActivity: acts,
        server: { uptimeSec: Math.round(process.uptime()), load: os.loadavg(), cpus: os.cpus().length, memTotal: os.totalmem(), memFree: os.freemem(), rss: process.memoryUsage().rss, disk },
        database: { ok: true, bytes: dbSize.bytes },
        backup: backup ?? null,
      };
    });

    // ------------------------------------------------------------ users
    app.get('/users', { preHandler: guard('users.view') }, async (req) => {
      const { q = '', page = '0' } = req.query as { q?: string; page?: string };
      const p = Math.max(0, Math.min(1000, Number(page) || 0));
      const r = await db.query(
        `SELECT u.id, u.public_id, u.username, u.status, u.created_at, r.key AS role, p.display_name, up.level,
                (SELECT balance_after FROM credit_ledger l WHERE l.user_id = u.id ORDER BY seq DESC LIMIT 1) AS balance
           FROM users u JOIN roles r ON r.id = u.role_id JOIN user_profiles p ON p.user_id = u.id JOIN user_progress up ON up.user_id = u.id
          WHERE u.deleted_at IS NULL AND ($1 = '' OR u.username ILIKE '%' || $1 || '%' OR p.display_name ILIKE '%' || $1 || '%' OR u.public_id::text = $1)
          ORDER BY u.created_at DESC LIMIT 50 OFFSET $2`,
        [String(q).slice(0, 40).replace(/[%_\\]/g, ''), p * 50],
      );
      return { users: r.rows.map((u) => ({ ...u, balance: u.balance ?? 0 })) };
    });

    app.get('/users/:id', { preHandler: guard('users.view') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const u = (await db.query(`SELECT u.id, u.public_id, u.username, u.email, u.status, u.suspended_until, u.chat_muted_until, u.created_at, r.key AS role, p.display_name, up.level, up.xp_total, c.totp_enabled, c.locked_until FROM users u JOIN roles r ON r.id = u.role_id JOIN user_profiles p ON p.user_id = u.id JOIN user_progress up ON up.user_id = u.id JOIN user_credentials c ON c.user_id = u.id WHERE u.id = $1`, [id])).rows[0];
      if (!u) throw notFound('User not found.');
      const [stats, sessions, logins, reports, ach, limits] = await Promise.all([
        db.query('SELECT * FROM player_stats WHERE user_id = $1', [id]).then((r) => r.rows[0]),
        db.query('SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC', [id]).then((r) => r.rows),
        db.query('SELECT success, reason, ip, created_at FROM login_events WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [id]).then((r) => r.rows),
        db.query('SELECT id, category, details, status, created_at FROM reports WHERE target_id = $1 ORDER BY created_at DESC LIMIT 20', [id]).then((r) => r.rows),
        db.query('SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = $1 AND unlocked_at IS NOT NULL', [id]).then((r) => r.rows),
        db.query('SELECT max_buy_in, max_daily_buy_in FROM account_limits WHERE user_id = $1', [id]).then((r) => r.rows[0] ?? null),
      ]);
      const credits = a.user.permissions.has('credits.view') ? { wallet: await balanceOf(db, id), onTables: await onTables(db, id), ledgerIntact: (await verifyUserLedger(db, id)) === null } : null;
      return { user: u, stats, sessions, logins, reports, achievements: ach, limits, credits };
    });

    app.post('/users', { preHandler: guard('users.create', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const b = parse(AdminCreateUserBody, req.body);
      if (b.role === 'admin' && a.user.role !== 'owner') throw forbidden('Only the Owner can create administrators.');
      // A random temporary password nobody sees; the user sets their own via the one-time link.
      const resetToken = newToken(32);
      const user = await withTx(db, async (tx) => {
        const u = await insertUser(tx, { username: b.username, displayName: b.displayName, email: b.email ?? null, role: b.role, password: newToken(24), mustChangePassword: true });
        await tx.query(`INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '72 hours')`, [u.id, sha256(resetToken), a.user.id]);
        await audit(tx, { actorId: a.user.id, action: 'user.create', targetType: 'user', targetId: u.id, details: { username: b.username, role: b.role }, ip: clientIp(req) });
        return u;
      });
      return { user, setupPath: `/reset-password#${resetToken}`, expiresInHours: 72 };
    });

    app.post('/users/:id/status', { preHandler: guard('users.suspend') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const b = parse(AdminUserStatusBody, req.body);
      await withTx(db, async (tx) => {
        const t = await target(tx, id, a.user.rank);
        await tx.query('UPDATE users SET status = $2, suspended_until = $3, updated_at = now() WHERE id = $1', [id, b.status, b.status === 'suspended' ? b.until ?? null : null]);
        if (b.status !== 'active') disconnectSessions(await revokeAllForUser(tx, id, `status_${b.status}`));
        if (b.status === 'suspended' || b.status === 'banned' || b.status === 'active') {
          await tx.query('INSERT INTO moderation_actions (target_id, moderator_id, action, reason, until) VALUES ($1,$2,$3,$4,$5)', [id, a.user.id, b.status === 'active' ? 'unban' : b.status === 'banned' ? 'ban' : 'suspend', b.reason, b.until ?? null]);
        }
        await audit(tx, { actorId: a.user.id, action: 'user.status', targetType: 'user', targetId: id, details: { from: t.status, to: b.status, reason: b.reason, until: b.until ?? null }, ip: clientIp(req) });
      });
      return { ok: true };
    });

    app.post('/users/:id/role', { preHandler: guard('roles.assign', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const b = parse(AdminRoleBody, req.body);
      await withTx(db, async (tx) => {
        const t = await target(tx, id, a.user.rank);
        const newRank = (await tx.query('SELECT rank FROM roles WHERE key = $1', [b.role])).rows[0].rank;
        if (newRank >= a.user.rank) throw forbidden('You cannot grant a role equal to or above your own.');
        await tx.query('UPDATE users SET role_id = (SELECT id FROM roles WHERE key = $2), updated_at = now() WHERE id = $1', [id, b.role]);
        disconnectSessions(await revokeAllForUser(tx, id, 'role_changed'));
        await audit(tx, { actorId: a.user.id, action: 'user.role', targetType: 'user', targetId: id, details: { from: t.role, to: b.role }, ip: clientIp(req) });
      });
      return { ok: true };
    });

    app.post('/users/:id/reset-password', { preHandler: guard('users.reset_password', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const token = newToken(32);
      await withTx(db, async (tx) => {
        await target(tx, id, a.user.rank);
        await tx.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [id]);
        await tx.query(`INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')`, [id, sha256(token), a.user.id]);
        await audit(tx, { actorId: a.user.id, action: 'user.reset_password_link', targetType: 'user', targetId: id, ip: clientIp(req) });
      });
      return { resetPath: `/reset-password#${token}`, expiresInMinutes: 60 };
    });

    app.post('/users/:id/revoke-sessions', { preHandler: guard('users.revoke_sessions') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const n = await withTx(db, async (tx) => {
        await target(tx, id, a.user.rank);
        const revoked = await revokeAllForUser(tx, id, 'admin_revoked');
        await audit(tx, { actorId: a.user.id, action: 'user.revoke_sessions', targetType: 'user', targetId: id, details: { count: revoked.length }, ip: clientIp(req) });
        return revoked;
      });
      disconnectSessions(n);
      return { revoked: n.length };
    });

    app.post('/users/:id/mute', { preHandler: guard('chat.moderate') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const b = parse(AdminMuteBody, req.body);
      await withTx(db, async (tx) => {
        await target(tx, id, a.user.rank);
        await tx.query(`UPDATE users SET chat_muted_until = now() + make_interval(mins => $2) WHERE id = $1`, [id, b.minutes]);
        await tx.query(`INSERT INTO moderation_actions (target_id, moderator_id, action, reason, until) VALUES ($1,$2,'chat_mute',$3, now() + make_interval(mins => $4))`, [id, a.user.id, b.reason, b.minutes]);
        await audit(tx, { actorId: a.user.id, action: 'user.mute', targetType: 'user', targetId: id, details: b, ip: clientIp(req) });
      });
      return { ok: true };
    });

    app.put('/users/:id/limits', { preHandler: guard('credits.limits', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const b = parse(AdminLimitsBody, req.body);
      await withTx(db, async (tx) => {
        await target(tx, id, a.user.rank + 1); // limits may be set on anyone up to the actor's own rank
        await tx.query(`INSERT INTO account_limits (user_id, max_buy_in, max_daily_buy_in, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET max_buy_in = $2, max_daily_buy_in = $3, updated_by = $4, updated_at = now()`, [id, b.maxBuyIn, b.maxDailyBuyIn, a.user.id]);
        await audit(tx, { actorId: a.user.id, action: 'credits.limits', targetType: 'user', targetId: id, details: b, ip: clientIp(req) });
      });
      return { ok: true };
    });

    // ------------------------------------------------------------ invitations
    app.post('/invitations', { preHandler: guard('users.create', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const b = parse(AdminInviteBody, req.body);
      const code = newToken(12);
      await withTx(db, async (tx) => {
        const r = await tx.query(`INSERT INTO invitations (code_hash, created_by, role_id, max_uses, expires_at, note) VALUES ($1,$2,(SELECT id FROM roles WHERE key = $3),$4, now() + make_interval(hours => $5), $6) RETURNING id`, [sha256(code), a.user.id, b.role, b.maxUses, b.expiresInHours, b.note ?? null]);
        await audit(tx, { actorId: a.user.id, action: 'invitation.create', targetType: 'invitation', targetId: r.rows[0].id, details: { role: b.role, maxUses: b.maxUses }, ip: clientIp(req) });
      });
      return { code, expiresInHours: b.expiresInHours };
    });
    app.get('/invitations', { preHandler: guard('users.view') }, async () => {
      const r = await db.query(`SELECT i.id, r.key AS role, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.note, i.created_at FROM invitations i JOIN roles r ON r.id = i.role_id ORDER BY i.created_at DESC LIMIT 100`);
      return { invitations: r.rows };
    });

    // ------------------------------------------------------------ credits
    app.post('/credits', { preHandler: guard('credits.grant', { stepUp: true }), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      const a = requireAuth(req);
      const b = parse(AdminCreditBody, req.body);
      if (b.kind === 'grant' && b.amount < 0) throw badRequest('Use a correction to remove credits.');
      if (b.userId === a.user.id && a.user.role !== 'owner') throw forbidden('You cannot change your own balance.');
      const entry = await withTx(db, async (tx) => {
        if (b.userId !== a.user.id) await target(tx, b.userId, a.user.rank + 1);
        const e = await postEntry(tx, { userId: b.userId, amount: b.amount, type: b.kind === 'grant' ? 'ADMIN_GRANT' : 'ADMIN_CORRECTION', reason: b.reason, adminId: a.user.id, idempotencyKey: b.idempotencyKey, metadata: { ip: clientIp(req) } });
        await audit(tx, { actorId: a.user.id, action: `credits.${b.kind}`, targetType: 'user', targetId: b.userId, details: { amount: b.amount, reason: b.reason, entryId: e.id, balanceAfter: e.balance_after }, ip: clientIp(req) });
        return e;
      });
      live.toUser(b.userId, 'credits:changed', { balance: entry.balance_after });
      return { entry };
    });

    const ledgerFilter = (query: Record<string, string | undefined>) => {
      const f = z.object({ userId: UUID.optional(), type: z.string().max(40).optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), adminId: UUID.optional() }).parse(query);
      return { sql: `WHERE ($1::uuid IS NULL OR l.user_id = $1) AND ($2::text IS NULL OR l.entry_type = $2) AND ($3::timestamptz IS NULL OR l.created_at >= $3) AND ($4::timestamptz IS NULL OR l.created_at < $4) AND ($5::uuid IS NULL OR l.admin_id = $5)`, params: [f.userId ?? null, f.type ?? null, f.from ?? null, f.to ?? null, f.adminId ?? null] };
    };
    app.get('/credits/ledger', { preHandler: guard('credits.view') }, async (req) => {
      const f = ledgerFilter(req.query as Record<string, string>);
      const r = await db.query(`SELECT l.id, l.user_id, u.username, l.seq, l.amount, l.denomination, l.entry_type, l.balance_before, l.balance_after, l.reason, l.admin_id, ap.display_name AS admin_name, l.reference_type, l.reference_id, l.created_at FROM credit_ledger l JOIN users u ON u.id = l.user_id LEFT JOIN user_profiles ap ON ap.user_id = l.admin_id ${f.sql} ORDER BY l.created_at DESC LIMIT 200`, f.params);
      return { entries: r.rows };
    });
    app.get('/credits/export', { preHandler: guard('credits.export', { stepUp: true }) }, async (req, reply) => {
      const a = requireAuth(req);
      const f = ledgerFilter(req.query as Record<string, string>);
      const r = await db.query(`SELECT l.id, u.username, l.seq, l.amount, l.denomination, l.entry_type, l.balance_before, l.balance_after, l.reason, ap.username AS admin, l.reference_type, l.reference_id, l.created_at FROM credit_ledger l JOIN users u ON u.id = l.user_id LEFT JOIN users ap ON ap.id = l.admin_id ${f.sql} ORDER BY l.created_at LIMIT 100000`, f.params);
      await audit(db, { actorId: a.user.id, action: 'credits.export', details: { rows: r.rowCount, filter: req.query as Record<string, unknown> }, ip: clientIp(req) });
      const head = ['id', 'username', 'seq', 'amount', 'denomination', 'type', 'balance_before', 'balance_after', 'reason', 'admin', 'reference_type', 'reference_id', 'created_at'];
      const body = [head.join(','), ...r.rows.map((x) => Object.values(x).map(csvCell).join(','))].join('\n');
      reply.header('Content-Disposition', 'attachment; filename="noir-ledger.csv"').type('text/csv; charset=utf-8');
      return body;
    });

    // ------------------------------------------------------------ tables
    app.get('/tables', { preHandler: guard('tables.manage') }, async () => ({ tables: tables.list().map((t) => t.summary()) }));
    app.post('/tables/:id/status', { preHandler: guard('tables.manage') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const { status } = parse(z.strictObject({ status: z.enum(['open', 'paused', 'closed']) }), req.body);
      await tables.get(id).setStatus(status);
      await audit(db, { actorId: a.user.id, action: 'table.status', targetType: 'table', targetId: id, details: { status }, ip: clientIp(req) });
      return { ok: true };
    });

    // ------------------------------------------------------------ moderation
    app.get('/reports', { preHandler: guard('chat.moderate') }, async () => {
      const r = await db.query(`SELECT r.id, r.category, r.details, r.context, r.status, r.created_at, rp.display_name AS reporter, tp.display_name AS target, r.target_id FROM reports r JOIN user_profiles rp ON rp.user_id = r.reporter_id JOIN user_profiles tp ON tp.user_id = r.target_id ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100`);
      return { reports: r.rows };
    });
    app.post('/reports/:id', { preHandler: guard('chat.moderate') }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const { status } = parse(z.strictObject({ status: z.enum(['reviewing', 'actioned', 'dismissed']) }), req.body);
      await withTx(db, async (tx) => {
        const r = await tx.query(`UPDATE reports SET status = $2, handled_by = $3, resolved_at = CASE WHEN $2 IN ('actioned','dismissed') THEN now() END WHERE id = $1`, [id, status, a.user.id]);
        if (!r.rowCount) throw notFound();
        await audit(tx, { actorId: a.user.id, action: 'report.update', targetType: 'report', targetId: id, details: { status }, ip: clientIp(req) });
      });
      return { ok: true };
    });
    app.post('/chat/messages/:id/hide', { preHandler: guard('chat.moderate') }, async (req) => {
      const a = requireAuth(req);
      const id = parse(z.coerce.number().int().positive(), (req.params as { id: string }).id);
      await withTx(db, async (tx) => {
        const r = await tx.query('UPDATE chat_messages SET hidden_at = now(), hidden_by = $2 WHERE id = $1 RETURNING user_id', [id, a.user.id]);
        if (!r.rowCount) throw notFound();
        await tx.query(`INSERT INTO moderation_actions (target_id, moderator_id, action, reason) VALUES ($1,$2,'hide_message',$3)`, [r.rows[0].user_id, a.user.id, `message ${id}`]);
        await audit(tx, { actorId: a.user.id, action: 'chat.hide', targetType: 'chat_message', targetId: String(id), ip: clientIp(req) });
      });
      return { ok: true };
    });
    app.get('/integrity-alerts', { preHandler: guard('audit.view') }, async () => ({ alerts: (await db.query(`SELECT * FROM integrity_alerts ORDER BY created_at DESC LIMIT 100`)).rows }));

    // ------------------------------------------------------------ audit & security
    app.get('/audit', { preHandler: guard('audit.view') }, async () => {
      const r = await db.query(`SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.ip, a.created_at, p.display_name AS actor FROM admin_audit_log a LEFT JOIN user_profiles p ON p.user_id = a.actor_id ORDER BY a.id DESC LIMIT 200`);
      const broken = await verifyAuditChain(db);
      return { entries: r.rows, chainIntact: broken === null, firstBrokenId: broken };
    });
    app.get('/security-events', { preHandler: guard('audit.view') }, async () => ({ events: (await db.query(`SELECT id, kind, severity, user_id, ip, details, created_at FROM security_events ORDER BY id DESC LIMIT 200`)).rows }));

    // ------------------------------------------------------------ fairness investigation
    app.get('/hands/:id/investigate', { preHandler: guard('fairness.investigate', { stepUp: true }) }, async (req) => {
      const a = requireAuth(req);
      const id = idParam(req);
      const hand = (await db.query('SELECT * FROM hands WHERE id = $1', [id])).rows[0];
      if (!hand) throw notFound();
      const [secret, players, events, actions] = await Promise.all([
        db.query('SELECT deck, salts FROM hand_secrets WHERE hand_id = $1', [id]).then((r) => r.rows[0] ?? null),
        db.query('SELECT * FROM hand_players WHERE hand_id = $1 ORDER BY seat', [id]).then((r) => r.rows),
        db.query('SELECT seq, type, visibility, payload, prev_hash, hash, created_at FROM hand_events WHERE hand_id = $1 ORDER BY seq', [id]).then((r) => r.rows),
        db.query('SELECT * FROM player_actions WHERE hand_id = $1 ORDER BY server_ts', [id]).then((r) => r.rows),
      ]);
      await audit(db, { actorId: a.user.id, action: 'fairness.investigate', targetType: 'hand', targetId: id, ip: clientIp(req) });
      return { hand, secret, players, events, actions };
    });

    // ------------------------------------------------------------ configuration
    const EDITABLE: Record<string, { perm: string; schema: z.ZodType }> = {
      maintenance: { perm: 'system.maintenance', schema: z.strictObject({ enabled: z.boolean(), message: z.string().max(300) }) },
      xp_rules: { perm: 'progression.manage', schema: z.strictObject({ version: z.number().int().min(1), handPlayed: z.number().int().min(0).max(100), handWon: z.number().int().min(0).max(100), showdownWon: z.number().int().min(0).max(100), dailyHandXpCap: z.number().int().min(0).max(100000), minPotForWinXp: z.number().int().min(0).optional() }) },
      chat: { perm: 'chat.moderate', schema: z.strictObject({ allowLinks: z.boolean(), maxLength: z.number().int().min(20).max(300), perMinute: z.number().int().min(1).max(60), dmEnabled: z.boolean(), bannedWords: z.array(z.string().max(40)).max(500) }) },
      leaderboards: { perm: 'progression.manage', schema: z.strictObject({ enabled: z.array(z.enum(['level', 'xp', 'hands_played', 'hands_won', 'tournament_points', 'weekly', 'monthly'])) }) },
    };
    app.get('/config', { preHandler: guard('system.view') }, async () => ({ config: (await db.query('SELECT key, value, updated_at FROM app_config ORDER BY key')).rows }));
    app.put('/config/:key', async (req) => {
      const a = requireAuth(req);
      const key = (req.params as { key: string }).key;
      const def = EDITABLE[key];
      if (!def) throw notFound('Unknown setting.');
      await guard(def.perm, { stepUp: key === 'maintenance' })(req, undefined as never);
      const value = parse(def.schema, req.body);
      await withTx(db, async (tx) => {
        const prev = (await tx.query('SELECT value FROM app_config WHERE key = $1', [key])).rows[0]?.value ?? null;
        await tx.query('INSERT INTO app_config (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()', [key, value, a.user.id]);
        await audit(tx, { actorId: a.user.id, action: 'config.update', targetType: 'config', targetId: key, details: { from: prev, to: value }, ip: clientIp(req) });
      });
      return { ok: true };
    });

    app.post('/announcements', { preHandler: guard('announcements.manage') }, async (req) => {
      const a = requireAuth(req);
      const b = parse(z.strictObject({ title: z.string().trim().min(3).max(120), body: z.string().trim().min(1).max(2000), expiresAt: z.iso.datetime().optional() }), req.body);
      const r = await db.query('INSERT INTO announcements (title, body, published_at, expires_at, created_by) VALUES ($1,$2, now(), $3, $4) RETURNING id', [b.title, b.body, b.expiresAt ?? null, a.user.id]);
      await audit(db, { actorId: a.user.id, action: 'announcement.publish', targetType: 'announcement', targetId: r.rows[0].id, ip: clientIp(req) });
      return { id: r.rows[0].id };
    });

    app.get('/backups', { preHandler: guard('system.view') }, async () => ({ runs: (await db.query('SELECT * FROM backup_runs ORDER BY id DESC LIMIT 30')).rows }));
  };
}
