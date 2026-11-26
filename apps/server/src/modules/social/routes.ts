import type { FastifyInstance } from 'fastify';
import { ProfileUpdateBody, ReportBody, SendGiftBody, UUID } from '@noir/shared';
import { z } from 'zod';
import { withTx } from '../../db/pool.js';
import { parse, requireAuth, type AppDeps } from '../../http/context.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../../http/errors.js';

const AVATARS = new Set(['default', 'ace', 'king', 'queen', 'jack', 'club', 'diamond', 'heart', 'spade', 'crown', 'chip', 'moon']);

export function socialRoutes({ db, tables, live }: AppDeps) {
  return async (app: FastifyInstance) => {
    const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

    // ------------------------------------------------------------ profiles
    app.get('/profiles/:id', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      const r = await db.query(
        `SELECT u.id, u.public_id, u.username, u.created_at, p.display_name, p.avatar_key, p.bio, p.favorite_mode, p.equipped_frame, p.equipped_card_back,
                up.level, up.xp_total, l.rank_key, s.hands_played, s.hands_won, s.showdowns, s.showdowns_won, s.largest_pot, s.tournaments_played, s.tournament_wins,
                s.best_streak, s.current_streak, s.folds, s.preflop_folds, s.total_pot_won, s.seconds_played
           FROM users u JOIN user_profiles p ON p.user_id = u.id JOIN user_progress up ON up.user_id = u.id JOIN levels l ON l.level = up.level
           JOIN player_stats s ON s.user_id = u.id WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
      const p = r.rows[0];
      if (!p) throw notFound('Player not found.');
      const ach = (await db.query(`SELECT a.key, a.name, a.description, a.rarity, a.icon, a.threshold, COALESCE(ua.progress,0) AS progress, ua.unlocked_at FROM achievements a LEFT JOIN user_achievements ua ON ua.achievement_key = a.key AND ua.user_id = $1 WHERE a.active ORDER BY a.threshold`, [id])).rows;
      const gifts = (await db.query(`SELECT g.item_key, i.name, i.rarity, count(*)::int AS n FROM gift_history g JOIN items i ON i.key = g.item_key WHERE g.to_user = $1 GROUP BY g.item_key, i.name, i.rarity ORDER BY n DESC`, [id])).rows;
      const online = tables.list().some((t) => t.seatOf(id));
      const isFriend = id !== a.user.id && (await db.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', pair(a.user.id, id))).rowCount! > 0;
      const st = { handsPlayed: p.hands_played, handsWon: p.hands_won, winRate: p.hands_played ? +(100 * p.hands_won / p.hands_played).toFixed(1) : 0, showdowns: p.showdowns, showdownsWon: p.showdowns_won, largestPot: p.largest_pot, avgPotWon: p.hands_won ? Math.round(p.total_pot_won / p.hands_won) : 0, folds: p.folds, preflopFolds: p.preflop_folds, tournamentsPlayed: p.tournaments_played, tournamentWins: p.tournament_wins, currentStreak: p.current_streak, bestStreak: p.best_streak };
      return {
        profile: { id: p.id, playerId: p.public_id, username: p.username, displayName: p.display_name, avatarKey: p.avatar_key, bio: p.bio, favoriteMode: p.favorite_mode ?? 'No-Limit Hold\'em', frame: p.equipped_frame, cardBack: p.equipped_card_back, level: p.level, xp: p.xp_total, rank: p.rank_key, joinedAt: p.created_at, status: online ? 'At a table' : 'Away', isFriend },
        stats: st,
        achievements: ach,
        giftsReceived: gifts,
      };
    });

    app.patch('/me/profile', async (req) => {
      const a = requireAuth(req);
      const b = parse(ProfileUpdateBody, req.body);
      if (b.avatarKey && !AVATARS.has(b.avatarKey)) throw badRequest('Unknown avatar.');
      for (const [field, kind] of [['equippedFrame', 'frame'], ['equippedCardBack', 'card_back']] as const) {
        const key = b[field];
        if (key) {
          const owned = await db.query('SELECT 1 FROM user_inventory ui JOIN items i ON i.key = ui.item_key WHERE ui.user_id = $1 AND ui.item_key = $2 AND ui.quantity > 0 AND i.kind = $3', [a.user.id, key, kind]);
          if (!owned.rowCount) throw forbidden('You do not own that item.');
        }
      }
      await db.query(
        `UPDATE user_profiles SET display_name = COALESCE($2, display_name), avatar_key = COALESCE($3, avatar_key), bio = COALESCE($4, bio), allow_dms = COALESCE($5, allow_dms),
           equipped_frame = CASE WHEN $6::boolean THEN $7 ELSE equipped_frame END, equipped_card_back = CASE WHEN $8::boolean THEN $9 ELSE equipped_card_back END WHERE user_id = $1`,
        [a.user.id, b.displayName ?? null, b.avatarKey ?? null, b.bio ?? null, b.allowDms ?? null, b.equippedFrame !== undefined, b.equippedFrame ?? null, b.equippedCardBack !== undefined, b.equippedCardBack ?? null],
      );
      return { ok: true };
    });

    // ------------------------------------------------------------ leaderboards
    const BOARDS: Record<string, { sql: string; label: string }> = {
      level: { label: 'Highest level', sql: `SELECT u.id, p.display_name, up.level AS value FROM user_progress up JOIN users u ON u.id = up.user_id JOIN user_profiles p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY up.level DESC, up.xp_total DESC, u.public_id LIMIT 50` },
      xp: { label: 'Highest XP', sql: `SELECT u.id, p.display_name, up.xp_total AS value FROM user_progress up JOIN users u ON u.id = up.user_id JOIN user_profiles p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY up.xp_total DESC, u.public_id LIMIT 50` },
      hands_played: { label: 'Most hands played', sql: `SELECT u.id, p.display_name, s.hands_played AS value FROM player_stats s JOIN users u ON u.id = s.user_id JOIN user_profiles p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY s.hands_played DESC, u.public_id LIMIT 50` },
      hands_won: { label: 'Most wins', sql: `SELECT u.id, p.display_name, s.hands_won AS value FROM player_stats s JOIN users u ON u.id = s.user_id JOIN user_profiles p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY s.hands_won DESC, u.public_id LIMIT 50` },
      tournament_points: { label: 'Tournament performance', sql: `SELECT u.id, p.display_name, s.tournament_points AS value FROM player_stats s JOIN users u ON u.id = s.user_id JOIN user_profiles p ON p.user_id = u.id WHERE u.status = 'active' ORDER BY s.tournament_points DESC, u.public_id LIMIT 50` },
      weekly: { label: 'Weekly champions (XP this week)', sql: `SELECT u.id, p.display_name, SUM(x.amount)::bigint AS value FROM xp_ledger x JOIN users u ON u.id = x.user_id JOIN user_profiles p ON p.user_id = u.id WHERE x.created_at >= date_trunc('week', now()) AND u.status = 'active' GROUP BY u.id, p.display_name, u.public_id ORDER BY value DESC, u.public_id LIMIT 50` },
      monthly: { label: 'Monthly champions (XP this month)', sql: `SELECT u.id, p.display_name, SUM(x.amount)::bigint AS value FROM xp_ledger x JOIN users u ON u.id = x.user_id JOIN user_profiles p ON p.user_id = u.id WHERE x.created_at >= date_trunc('month', now()) AND u.status = 'active' GROUP BY u.id, p.display_name, u.public_id ORDER BY value DESC, u.public_id LIMIT 50` },
    };
    app.get('/leaderboards', async (req) => {
      requireAuth(req);
      const cfg = (await db.query(`SELECT value FROM app_config WHERE key = 'leaderboards'`)).rows[0]?.value?.enabled as string[] | undefined;
      return { boards: (cfg ?? Object.keys(BOARDS)).filter((k) => BOARDS[k]).map((k) => ({ key: k, label: BOARDS[k]!.label })) };
    });
    app.get('/leaderboards/:key', async (req) => {
      requireAuth(req);
      const key = (req.params as { key: string }).key;
      const cfg = (await db.query(`SELECT value FROM app_config WHERE key = 'leaderboards'`)).rows[0]?.value?.enabled as string[] | undefined;
      const b = BOARDS[key];
      if (!b || (cfg && !cfg.includes(key))) throw notFound('Unknown leaderboard.');
      const rows = (await db.query(b.sql)).rows;
      // Dense ranking: equal values share a rank.
      let rank = 0, prev: number | null = null;
      return { key, label: b.label, entries: rows.map((r) => { if (r.value !== prev) { rank++; prev = r.value; } return { rank, userId: r.id, displayName: r.display_name, value: Number(r.value) }; }) };
    });

    // ------------------------------------------------------------ progression views
    app.get('/me/quests', async (req) => {
      const a = requireAuth(req);
      const r = await db.query(
        `SELECT q.key, q.name, q.period, q.target, q.xp_reward, COALESCE(qp.progress,0) AS progress, qp.completed_at
           FROM quests q LEFT JOIN quest_progress qp ON qp.quest_key = q.key AND qp.user_id = $1
            AND qp.period_start = CASE WHEN q.period = 'daily' THEN date_trunc('day', now())::date ELSE date_trunc('week', now())::date END
          WHERE q.active ORDER BY q.period, q.key`, [a.user.id]);
      const history = (await db.query(`SELECT qp.quest_key, q.name, qp.period_start, qp.completed_at FROM quest_progress qp JOIN quests q ON q.key = qp.quest_key WHERE qp.user_id = $1 AND qp.completed_at IS NOT NULL ORDER BY qp.completed_at DESC LIMIT 30`, [a.user.id])).rows;
      return { quests: r.rows, history };
    });
    app.get('/me/xp', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT amount, source, reference_id, created_at FROM xp_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [a.user.id]);
      const levels = (await db.query('SELECT level, reached_at FROM level_history WHERE user_id = $1 ORDER BY level DESC', [a.user.id])).rows;
      return { entries: r.rows, levels };
    });
    app.get('/me/credits', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT seq, amount, entry_type, balance_after, reason, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 100', [a.user.id]);
      return { denomination: 'ALL', entries: r.rows };
    });

    // ------------------------------------------------------------ notifications & announcements
    app.get('/notifications', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT id, kind, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [a.user.id]);
      return { notifications: r.rows, unread: r.rows.filter((n) => !n.read_at).length };
    });
    app.post('/notifications/read', async (req) => {
      const a = requireAuth(req);
      await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [a.user.id]);
      return { ok: true };
    });
    app.get('/announcements', async (req) => {
      requireAuth(req);
      const r = await db.query('SELECT id, title, body, published_at FROM announcements WHERE published_at <= now() AND (expires_at IS NULL OR expires_at > now()) ORDER BY published_at DESC LIMIT 10');
      return { announcements: r.rows };
    });

    // ------------------------------------------------------------ friends, blocks, mutes, reports
    app.get('/friends', async (req) => {
      const a = requireAuth(req);
      const f = await db.query(`SELECT u.id, p.display_name, p.avatar_key, up.level FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END JOIN user_profiles p ON p.user_id = u.id JOIN user_progress up ON up.user_id = u.id WHERE f.user_a = $1 OR f.user_b = $1`, [a.user.id]);
      const reqs = await db.query(`SELECT r.id, r.from_user, p.display_name FROM friend_requests r JOIN user_profiles p ON p.user_id = r.from_user WHERE r.to_user = $1 AND r.status = 'pending'`, [a.user.id]);
      const recent = await db.query(`SELECT DISTINCT ON (o.user_id) o.user_id AS id, p.display_name, h.ended_at FROM hand_players me JOIN hand_players o ON o.hand_id = me.hand_id AND o.user_id <> me.user_id JOIN hands h ON h.id = me.hand_id JOIN user_profiles p ON p.user_id = o.user_id WHERE me.user_id = $1 AND h.ended_at > now() - interval '14 days' ORDER BY o.user_id, h.ended_at DESC LIMIT 20`, [a.user.id]);
      const seated = new Set(tables.list().flatMap((t) => t.summary().players));
      return { friends: f.rows.map((x) => ({ ...x, online: seated.has(x.id) })), requests: reqs.rows, recentlyPlayedWith: recent.rows };
    });
    app.post('/friends/requests', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
      const a = requireAuth(req);
      const { userId } = parse(z.strictObject({ userId: UUID }), req.body);
      if (userId === a.user.id) throw badRequest('You cannot add yourself.');
      const blocked = await db.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [a.user.id, userId]);
      if (blocked.rowCount) throw forbidden('You cannot send a request to this player.');
      try {
        await db.query('INSERT INTO friend_requests (from_user, to_user) VALUES ($1,$2)', [a.user.id, userId]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('Request already sent.');
        if ((e as { code?: string }).code === '23503') throw notFound('Player not found.');
        throw e;
      }
      await db.query(`INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,'friend_request','Friend request',$2,$3)`, [userId, `${a.user.displayName} wants to be friends.`, { from: a.user.id }]);
      return { ok: true };
    });
    app.post('/friends/requests/:id/:decision', async (req) => {
      const a = requireAuth(req);
      const { id, decision } = req.params as { id: string; decision: string };
      parse(UUID, id);
      if (decision !== 'accept' && decision !== 'decline') throw notFound();
      await withTx(db, async (tx) => {
        const r = (await tx.query(`UPDATE friend_requests SET status = $3, responded_at = now() WHERE id = $1 AND to_user = $2 AND status = 'pending' RETURNING from_user`, [id, a.user.id, decision === 'accept' ? 'accepted' : 'declined'])).rows[0];
        if (!r) throw notFound('Request not found.');
        if (decision === 'accept') await tx.query('INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING', pair(a.user.id, r.from_user));
      });
      return { ok: true };
    });
    app.delete('/friends/:id', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      await db.query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', pair(a.user.id, id));
      return { ok: true };
    });
    for (const [path, table, col1, col2] of [['blocks', 'user_blocks', 'blocker_id', 'blocked_id'], ['mutes', 'user_mutes', 'muter_id', 'muted_id']] as const) {
      app.post(`/${path}/:id`, async (req) => {
        const a = requireAuth(req);
        const id = parse(UUID, (req.params as { id: string }).id);
        if (id === a.user.id) throw badRequest('Not allowed.');
        await db.query(`INSERT INTO ${table} (${col1}, ${col2}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [a.user.id, id]);
        if (path === 'blocks') await db.query('DELETE FROM friendships WHERE user_a = $1 AND user_b = $2', pair(a.user.id, id));
        return { ok: true };
      });
      app.delete(`/${path}/:id`, async (req) => {
        const a = requireAuth(req);
        const id = parse(UUID, (req.params as { id: string }).id);
        await db.query(`DELETE FROM ${table} WHERE ${col1} = $1 AND ${col2} = $2`, [a.user.id, id]);
        return { ok: true };
      });
    }
    app.post('/reports', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
      const a = requireAuth(req);
      const b = parse(ReportBody, req.body);
      if (b.targetUserId === a.user.id) throw badRequest('You cannot report yourself.');
      await db.query('INSERT INTO reports (reporter_id, target_id, category, details, context) VALUES ($1,$2,$3,$4,$5)', [a.user.id, b.targetUserId, b.category, b.details ?? null, b.context ?? {}]);
      return { ok: true };
    });

    // ------------------------------------------------------------ gifts (cosmetic only)
    app.get('/gifts/catalog', async (req) => {
      const a = requireAuth(req);
      const r = await db.query(
        `SELECT i.key, i.name, i.kind, i.rarity, i.animation, i.daily_send_limit,
                i.daily_send_limit - (SELECT count(*) FROM gift_history g WHERE g.from_user = $1 AND g.item_key = i.key AND g.created_at >= date_trunc('day', now()))::int AS remaining_today
           FROM items i WHERE i.active AND i.giftable AND (i.seasonal_from IS NULL OR current_date BETWEEN i.seasonal_from AND i.seasonal_to) ORDER BY i.rarity, i.name`, [a.user.id]);
      return { items: r.rows };
    });
    app.get('/me/inventory', async (req) => {
      const a = requireAuth(req);
      const r = await db.query('SELECT i.key, i.name, i.kind, i.rarity, ui.quantity FROM user_inventory ui JOIN items i ON i.key = ui.item_key WHERE ui.user_id = $1 AND ui.quantity > 0', [a.user.id]);
      const received = await db.query('SELECT g.id, g.item_key, i.name, g.message, g.created_at, p.display_name AS from_name FROM gift_history g JOIN items i ON i.key = g.item_key JOIN user_profiles p ON p.user_id = g.from_user WHERE g.to_user = $1 ORDER BY g.created_at DESC LIMIT 50', [a.user.id]);
      return { items: r.rows, received: received.rows };
    });
    app.post('/gifts', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      const a = requireAuth(req);
      const b = parse(SendGiftBody, req.body);
      if (b.toUserId === a.user.id) throw badRequest('You cannot send a gift to yourself.');
      const gift = await withTx(db, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gift:${a.user.id}`]);
        const item = (await tx.query(`SELECT key, name, animation, daily_send_limit FROM items WHERE key = $1 AND active AND giftable AND (seasonal_from IS NULL OR current_date BETWEEN seasonal_from AND seasonal_to)`, [b.itemKey])).rows[0];
        if (!item) throw badRequest('That gift is not available.');
        const blocked = await tx.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [b.toUserId, a.user.id]);
        if (blocked.rowCount) throw forbidden('You cannot send gifts to this player.');
        const sent = (await tx.query(`SELECT count(*)::int AS n FROM gift_history WHERE from_user = $1 AND item_key = $2 AND created_at >= date_trunc('day', now())`, [a.user.id, b.itemKey])).rows[0].n;
        if (sent >= item.daily_send_limit) throw tooMany(`You have sent all your ${item.name} gifts for today.`);
        const r = await tx.query('INSERT INTO gift_history (from_user, to_user, item_key, table_id, message) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at', [a.user.id, b.toUserId, b.itemKey, b.tableId ?? null, b.message ?? null]);
        await tx.query(`INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,'gift','Gift received',$2,$3)`, [b.toUserId, `${a.user.displayName} sent you a ${item.name}.`, { item: item.key, from: a.user.id }]);
        return { id: r.rows[0].id, item };
      }).catch((e) => {
        if ((e as { code?: string }).code === '23503') throw notFound('Player not found.');
        throw e;
      });
      const payload = { giftId: gift.id, item: gift.item.key, name: gift.item.name, animation: gift.item.animation, fromUserId: a.user.id, fromName: a.user.displayName, toUserId: b.toUserId, tableId: b.tableId ?? null };
      if (b.tableId) live.toTable(b.tableId, 'table:gift', payload);
      live.toUser(b.toUserId, 'notify', { kind: 'gift', title: 'Gift received', body: `${a.user.displayName} sent you a ${gift.item.name}.`, data: payload });
      return { ok: true, gift: payload };
    });
  };
}
