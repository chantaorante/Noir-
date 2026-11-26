import type { FastifyInstance } from 'fastify';
import { CreateTableBody, UUID } from '@noir/shared';
import { z } from 'zod';
import { parse, requireAuth, type AppDeps } from '../../http/context.js';
import { forbidden, notFound } from '../../http/errors.js';

export function lobbyRoutes({ db, tables, live }: AppDeps) {
  return async (app: FastifyInstance) => {
    app.get('/tables', async (req) => {
      const a = requireAuth(req);
      return { tables: tables.list().filter((t) => !t.row.is_private || t.canView(a.user.id)).map((t) => t.summary()), online: live.online() };
    });

    // Players may create private tables (they become host); public tables need tables.manage.
    app.post('/tables', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
      const a = requireAuth(req);
      const body = parse(CreateTableBody, req.body);
      if (!body.isPrivate && !a.user.permissions.has('tables.manage')) throw forbidden('Only administrators can create public tables.');
      if (body.isPrivate) {
        const open = await db.query(`SELECT count(*)::int AS n FROM poker_tables WHERE host_id = $1 AND status <> 'closed'`, [a.user.id]);
        if (open.rows[0].n >= 3) throw forbidden('You can host at most 3 open private tables.');
      }
      const t = await tables.create(body, a.user.id, body.isPrivate);
      return { table: t.summary() };
    });

    app.post('/tables/:id/invite', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      const { userId } = parse(z.strictObject({ userId: UUID }), req.body);
      const t = tables.get(id);
      if (t.row.host_id !== a.user.id && !a.user.permissions.has('tables.manage')) throw forbidden();
      await db.query('INSERT INTO table_invites (table_id, user_id, invited_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, userId, a.user.id]);
      t.authorize(userId);
      await db.query(`INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,'table_invite','Table invitation',$2,$3)`, [userId, `You were invited to ${t.row.name}.`, { tableId: id }]);
      return { ok: true };
    });

    app.post('/tables/:id/close', async (req) => {
      const a = requireAuth(req);
      const t = tables.get(parse(UUID, (req.params as { id: string }).id));
      if (t.row.host_id !== a.user.id && !a.user.permissions.has('tables.manage')) throw forbidden();
      await t.setStatus('closed');
      return { ok: true };
    });

    app.get('/hands/:id', async (req) => {
      const a = requireAuth(req);
      const id = parse(UUID, (req.params as { id: string }).id);
      const me = await db.query('SELECT seat, hole_cards FROM hand_players WHERE hand_id = $1 AND user_id = $2', [id, a.user.id]);
      if (!me.rows[0]) throw notFound('You did not play in this hand.');
      const hand = (await db.query('SELECT id, table_id, hand_no, button_seat, small_blind, big_blind, deck_commit_id, deck_root, entropy_mix, board, status, started_at, ended_at, total_pot FROM hands WHERE id = $1', [id])).rows[0];
      const players = (await db.query(`SELECT hp.seat, hp.user_id, p.display_name, hp.starting_stack, hp.final_stack, hp.net, hp.shown, hp.won, CASE WHEN hp.shown OR hp.user_id = $2 THEN hp.hole_cards END AS hole_cards FROM hand_players hp JOIN user_profiles p ON p.user_id = hp.user_id WHERE hp.hand_id = $1 ORDER BY seat`, [id, a.user.id])).rows;
      const events = (await db.query(`SELECT seq, type, payload, prev_hash, hash FROM hand_events WHERE hand_id = $1 AND (visibility = 'public' OR visibility = $2) ORDER BY seq`, [id, `seat:${me.rows[0].seat}`])).rows;
      const entropy = (await db.query('SELECT user_id AS "playerId", entropy FROM hand_entropy WHERE hand_id = $1', [id])).rows;
      return { hand, players, events, fairness: { commitId: hand.deck_commit_id, root: hand.deck_root, mix: hand.entropy_mix, contributions: entropy } };
    });

    app.get('/me/hands', async (req) => {
      const a = requireAuth(req);
      const r = await db.query(`SELECT h.id, h.hand_no, t.name AS table_name, h.ended_at, h.total_pot, hp.net, hp.won FROM hand_players hp JOIN hands h ON h.id = hp.hand_id JOIN poker_tables t ON t.id = h.table_id WHERE hp.user_id = $1 AND h.status = 'complete' ORDER BY h.ended_at DESC LIMIT 50`, [a.user.id]);
      return { hands: r.rows };
    });
  };
}
