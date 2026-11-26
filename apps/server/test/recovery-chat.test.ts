import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Noir } from '../src/server.js';
import { sanitizeChat } from '../src/modules/chat/chat.js';
import { Client, connectSocket, emitAck, loginStaff, makeUser, startNoir, waitFor } from './harness.js';

let noir: Noir | null = null;
afterAll(async () => noir?.close());

describe('server restart during a hand', () => {
  it('voids the interrupted hand and restores every seat to its pre-hand stack', async () => {
    let url: string;
    ({ noir, url } = await startNoir());
    const owner = await makeUser(noir, 'owner1', 'owner', { mfa: true });
    const oc = new Client(url);
    await loginStaff(noir, oc, owner);
    const t = await oc.post('/api/tables', { name: 'Restart Table', maxSeats: 2, smallBlind: 5, bigBlind: 10, minBuyIn: 100, maxBuyIn: 1000, actionSeconds: 30 });
    const tableId = t.body.table.id;
    const ids: string[] = [];
    const sockets = [];
    for (const [i, name] of ['rex', 'roy'].entries()) {
      const u = await makeUser(noir, name);
      ids.push(u.id);
      await oc.post('/api/admin/credits', { userId: u.id, amount: 1000, kind: 'grant', reason: 'Test bankroll', idempotencyKey: randomUUID() });
      const c = new Client(url);
      await c.login(name);
      const s = await connectSocket(url, c.cookie);
      sockets.push(s);
      const started = new Promise((r) => s.on('table:event', (e) => e.event.type === 'TURN' && r(e)));
      expect((await emitAck(s, 'table:sit', { tableId, seat: i, buyIn: 500 })).ok).toBe(true);
      if (i === 1) {
        const turn: any = await started;
        // Put chips in the pot, then "crash".
        const actor = sockets[turn.event.seat]!;
        await emitAck(actor, 'table:action', { tableId, handId: turn.handId, actionId: randomUUID(), expectedSeq: turn.seq, type: 'raise', amount: 100 });
      }
    }
    for (const s of sockets) s.disconnect();
    await noir.close();
    ({ noir, url } = await startNoir({}, { keepDb: true }));
    const voided = await noir.db.query(`SELECT count(*)::int AS n FROM hands WHERE status = 'voided'`);
    expect(voided.rows[0].n).toBe(1);
    const seats = await noir.db.query('SELECT user_id, stack FROM table_sessions WHERE table_id = $1 AND left_at IS NULL ORDER BY seat', [tableId]);
    expect(seats.rows.map((r) => r.stack)).toEqual([500, 500]);
    const actor = noir.tables.get(tableId);
    expect(actor.seatViews()).toHaveLength(2);
    expect(actor.seatViews().every((s) => !s.connected)).toBe(true);
  }, 30_000);
});

describe('chat', () => {
  it('sanitizes control characters, blocks links and filters words', () => {
    const rules = { allowLinks: false, maxLength: 300, perMinute: 12, bannedWords: ['badword'] };
    expect(sanitizeChat('hi‮there\u0000', rules)).toEqual({ ok: true, text: 'hithere' });
    expect(sanitizeChat('visit https://evil.example', rules).ok).toBe(false);
    expect(sanitizeChat('go to evil.com now', rules).ok).toBe(false);
    expect(sanitizeChat('you badword', rules)).toEqual({ ok: true, text: 'you •••••••' });
    // HTML is stored as text; the client renders it escaped (React text nodes).
    expect(sanitizeChat('<script>alert(1)</script>', rules)).toEqual({ ok: true, text: '<script>alert(1)</script>' });
  });

  it('broadcasts lobby chat in real time, rate-limits, and enforces mutes', async () => {
    await noir!.close();
    let url: string;
    ({ noir, url } = await startNoir());
    const a = await makeUser(noir, 'talker');
    const b = await makeUser(noir, 'listener');
    const ca = new Client(url); await ca.login('talker');
    const cb = new Client(url); await cb.login('listener');
    const sa = await connectSocket(url, ca.cookie);
    const sb = await connectSocket(url, cb.cookie);
    await emitAck(sa, 'lobby:subscribe');
    await emitAck(sb, 'lobby:subscribe');
    const got: any[] = [];
    sb.on('chat:message', (m) => got.push(m));
    expect((await emitAck(sa, 'chat:send', { channel: 'lobby', body: 'hello table' })).ok).toBe(true);
    await waitFor(() => got.length === 1);
    expect(got[0]).toMatchObject({ body: 'hello table', userId: a.id });
    // Not watching a table → cannot post into its channel
    expect((await emitAck(sa, 'chat:send', { channel: `table:${randomUUID()}`, body: 'sneaky' })).code).toBe('NOT_WATCHING');
    // Burst limit
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await emitAck(sa, 'chat:send', { channel: 'lobby', body: `m${i}` })).code);
    expect(codes).toContain('RATE_LIMITED');
    await noir.db.query(`UPDATE users SET chat_muted_until = now() + interval '1 hour' WHERE id = $1`, [b.id]);
    expect((await emitAck(sb, 'chat:send', { channel: 'lobby', body: 'am I muted' })).code).toBe('MUTED');
    sa.disconnect(); sb.disconnect();
  });
});
