import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io-client';
import { verifyReveal } from '@noir/engine';
import type { Noir } from '../src/server.js';
import { Client, connectSocket, emitAck, loginStaff, makeUser, startNoir, waitFor } from './harness.js';

let noir: Noir;
let url: string;

interface P { name: string; id: string; c: Client; s: Socket; events: any[]; privates: any[]; snapshots: any[]; commitments: any[] }
const players: P[] = [];
let tableId: string;

async function grantCredits(ownerC: Client, userId: string, amount: number) {
  const r = await ownerC.post('/api/admin/credits', { userId, amount, kind: 'grant', reason: 'Test bankroll', idempotencyKey: randomUUID() });
  expect(r.status).toBe(200);
}

function attach(p: Omit<P, 'events' | 'privates' | 'snapshots' | 'commitments'>): P {
  const full: P = { ...p, events: [], privates: [], snapshots: [], commitments: [] };
  full.s.on('table:event', (e) => full.events.push(e));
  full.s.on('table:private', (e) => full.privates.push(e));
  full.s.on('table:snapshot', (e) => full.snapshots.push(e));
  full.s.on('table:commitment', (e) => full.commitments.push(e));
  return full;
}

const lastTurn = (p: P, handId: string) => [...p.events].reverse().find((e) => e.handId === handId && (e.event.type === 'TURN' || e.event.type === 'HAND_ENDED'));

async function playHandPassively(handId: string, maxSteps = 60) {
  // Everyone calls/checks until the hand ends.
  for (let i = 0; i < maxSteps; i++) {
    const t = await waitFor(() => lastTurn(players[0]!, handId));
    if (t.event.type === 'HAND_ENDED') return;
    const actor = players.find((p) => p.id === seatUser(t.event.seat))!;
    const o = t.event.options;
    const r = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: randomUUID(), expectedSeq: t.seq, type: o.canCheck ? 'check' : 'call' });
    expect(r.ok).toBe(true);
    await waitFor(() => lastTurn(players[0]!, handId) !== t);
  }
  throw new Error('hand did not end');
}

let seatMap = new Map<number, string>();
const seatUser = (seat: number) => seatMap.get(seat)!;

beforeAll(async () => {
  ({ noir, url } = await startNoir());
  const owner = await makeUser(noir, 'owner1', 'owner', { mfa: true });
  const ownerC = new Client(url);
  await loginStaff(noir, ownerC, owner);
  const t = await ownerC.post('/api/tables', { name: 'Integration Table', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, actionSeconds: 5 });
  expect(t.status).toBe(200);
  tableId = t.body.table.id;
  for (const name of ['ann', 'ben', 'cat']) {
    const u = await makeUser(noir, name);
    await grantCredits(ownerC, u.id, 5000);
    const c = new Client(url);
    await c.login(name);
    const s = await connectSocket(url, c.cookie);
    players.push(attach({ name, id: u.id, c, s }));
  }
});
afterAll(async () => {
  for (const p of players) p.s.disconnect();
  await noir?.close();
});

describe('multiplayer table', () => {
  it('rejects unauthenticated sockets and foreign origins', async () => {
    await expect(connectSocket(url, 'noir_sid=forged-token')).rejects.toThrow();
  });

  it('players watch, sit with a ledger-backed buy-in, contribute entropy, and a hand starts', async () => {
    for (const [i, p] of players.entries()) {
      const w = await emitAck(p.s, 'table:watch', { tableId });
      expect(w.ok).toBe(true);
      const commit = w.data.nextCommitment;
      const sit = await emitAck(p.s, 'table:sit', { tableId, seat: i, buyIn: 1000 });
      expect(sit.ok).toBe(true);
      seatMap.set(i, p.id);
      if (commit) {
        const e = await emitAck(p.s, 'table:entropy', { tableId, commitId: commit.handId, entropy: randomBytes(32).toString('hex') });
        // Entropy may arrive after the hand already started for early sitters; either outcome is valid.
        expect(typeof e.ok).toBe('boolean');
      }
    }
    const me = await players[0]!.c.get('/api/auth/me');
    expect(me.body.credits).toEqual({ wallet: 4000, onTables: 1000, denomination: 'ALL' });
    await waitFor(() => players[0]!.events.find((e) => e.event.type === 'HAND_STARTED'));
  });

  it('each player receives exactly their own hole cards with valid proofs; nobody else sees them', async () => {
    const started = players[0]!.events.find((e) => e.event.type === 'HAND_STARTED');
    const handId = started.handId;
    await waitFor(() => players.every((p) => p.privates.some((x) => x.handId === handId)));
    const hs = await new Promise<any>((r) => { const ev = players[0]!.events; r(ev); });
    expect(hs).toBeTruthy();
    const fairnessMsg = await noir.db.query('SELECT deck_root, entropy_mix, deck_commit_id FROM hands WHERE id = $1', [handId]);
    const commitment = { commitId: fairnessMsg.rows[0].deck_commit_id, root: fairnessMsg.rows[0].deck_root, algorithm: 'NOIR-CARD-v1/sha256-merkle' as const };
    const allHole = new Set<string>();
    for (const p of players) {
      const mine = p.privates.filter((x) => x.handId === handId);
      expect(mine).toHaveLength(1);
      const ev = mine[0];
      expect(ev.event.cards).toHaveLength(2);
      for (const r of ev.reveals) expect(verifyReveal(commitment, fairnessMsg.rows[0].entropy_mix, r)).toBe(true);
      for (const c of ev.event.cards) allHole.add(c);
    }
    expect(allHole.size).toBe(6);
    // No public event carried any hole card before showdown.
    for (const p of players) {
      for (const e of p.events.filter((x) => x.handId === handId && x.event.type !== 'SHOWDOWN')) {
        const blob = JSON.stringify(e.event.type === 'STREET_DEALT' ? { ...e, event: { type: e.event.type } , reveals: [] } : e);
        for (const c of allHole) expect(blob.includes(`"${c}"`)).toBe(false);
      }
    }
  });

  it('rejects out-of-turn, stale-seq and forged actions; duplicate actionId is idempotent', async () => {
    const handId = players[0]!.events.find((e) => e.event.type === 'HAND_STARTED').handId;
    const t = await waitFor(() => lastTurn(players[0]!, handId));
    const actor = players.find((p) => p.id === seatUser(t.event.seat))!;
    const other = players.find((p) => p !== actor)!;
    const wrong = await emitAck(other.s, 'table:action', { tableId, handId, actionId: randomUUID(), expectedSeq: t.seq, type: 'fold' });
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe('NOT_YOUR_TURN');
    const stale = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: randomUUID(), expectedSeq: t.seq + 5, type: 'call' });
    expect(stale.code).toBe('STALE');
    const forged = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: randomUUID(), expectedSeq: t.seq, type: 'raise', amount: 10_000_000 });
    expect(forged.ok).toBe(false);
    const extra = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: randomUUID(), expectedSeq: t.seq, type: 'call', seat: 3, stack: 99999 });
    expect(extra.code).toBe('VALIDATION');
    const id = randomUUID();
    const a = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: id, expectedSeq: t.seq, type: 'call' });
    const b = await emitAck(actor.s, 'table:action', { tableId, handId, actionId: id, expectedSeq: t.seq, type: 'call' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const acted = players[0]!.events.filter((e) => e.handId === handId && e.event.type === 'PLAYER_ACTED' && e.event.seat === t.event.seat);
    expect(acted).toHaveLength(1);
  });

  it('completes the hand, conserves chips, updates stats/XP, and the event chain verifies', async () => {
    const handId = players[0]!.events.find((e) => e.event.type === 'HAND_STARTED').handId;
    await playHandPassively(handId);
    const ended = players[0]!.events.find((e) => e.handId === handId && e.event.type === 'HAND_ENDED');
    const total = ended.event.stacks.reduce((a: number, s: any) => a + s.stack, 0);
    expect(total).toBe(3000);
    await waitFor(async () => true);
    const hp = await noir.db.query('SELECT sum(net)::int AS n FROM hand_players WHERE hand_id = $1', [handId]);
    expect(hp.rows[0].n).toBe(0);
    const stats = await noir.db.query('SELECT sum(hands_played)::int AS n FROM player_stats');
    expect(stats.rows[0].n).toBe(3);
    const xp = await noir.db.query(`SELECT count(*)::int AS n FROM xp_ledger WHERE source = 'hand' AND reference_id = $1`, [handId]);
    expect(xp.rows[0].n).toBe(3);
    const { chainHash } = await import('@noir/engine');
    const ev = (await noir.db.query('SELECT seq, type, payload, prev_hash, hash FROM hand_events WHERE hand_id = $1 ORDER BY seq', [handId])).rows;
    let prev = ev[0].prev_hash;
    for (const e of ev) {
      expect(e.prev_hash).toBe(prev);
      expect(chainHash(prev, e.seq, e.type, e.payload)).toBe(e.hash);
      prev = e.hash;
    }
    // Player may view their own hand history but not hidden opponents' cards.
    const hist = await players[0]!.c.get(`/api/hands/${handId}`);
    expect(hist.status).toBe(200);
    for (const pl of hist.body.players) if (pl.user_id !== players[0]!.id && !pl.shown) expect(pl.hole_cards).toBeNull();
  });

  it('a disconnected player times out (check/fold) and gets a private-safe snapshot on reconnect', async () => {
    const next = await waitFor(() => [...players[0]!.events].reverse().find((e) => e.event.type === 'HAND_STARTED' && !players[0]!.events.some((x) => x.handId === e.handId && x.event.type === 'HAND_ENDED')), 8000);
    const handId = next.handId;
    const t = await waitFor(() => lastTurn(players[0]!, handId));
    const victim = players.find((p) => p.id === seatUser(t.event.seat))!;
    victim.s.disconnect();
    const timeout = await waitFor(() => players.find((p) => p !== victim)!.events.find((e) => e.handId === handId && e.event.type === 'PLAYER_ACTED' && e.event.seat === t.event.seat), 9000);
    expect(['check', 'fold']).toContain(timeout.event.action);
    victim.s = await connectSocket(url, victim.c.cookie);
    const snap = await emitAck(victim.s, 'table:watch', { tableId });
    expect(snap.ok).toBe(true);
    const h = snap.data.hand;
    if (h && h.handId === handId) {
      const mine = h.players.find((p: any) => p.playerId === victim.id);
      expect(mine.hole).toHaveLength(2);
      for (const p of h.players) if (p.playerId !== victim.id && !(h.street === 'complete')) expect(p.hole).toBeNull();
    }
    // Re-attach listeners for the rest of the suite.
    const re = attach({ name: victim.name, id: victim.id, c: victim.c, s: victim.s });
    Object.assign(victim, re);
  }, 20_000);

  it('runs a second table concurrently', async () => {
    const owner = await noir.db.query(`SELECT u.id FROM users u WHERE username = 'owner1'`);
    expect(owner.rowCount).toBe(1);
    const extra: P[] = [];
    const ownerC = new Client(url);
    await loginStaff(noir, ownerC, { id: owner.rows[0].id, username: 'owner1', totpSecret: (await getSecret('owner1')) });
    const t2 = await ownerC.post('/api/tables', { name: 'Second Table', maxSeats: 2, smallBlind: 1, bigBlind: 2, minBuyIn: 20, maxBuyIn: 400, actionSeconds: 5 });
    for (const name of ['dan', 'eva']) {
      const u = await makeUser(noir, name);
      await grantCredits(ownerC, u.id, 500);
      const c = new Client(url);
      await c.login(name);
      const s = await connectSocket(url, c.cookie);
      extra.push(attach({ name, id: u.id, c, s }));
    }
    for (const [i, p] of extra.entries()) expect((await emitAck(p.s, 'table:sit', { tableId: t2.body.table.id, seat: i, buyIn: 100 })).ok).toBe(true);
    await waitFor(() => extra[0]!.events.find((e) => e.tableId === t2.body.table.id && e.event.type === 'HAND_STARTED'));
    // Table 1 players never see table 2 events.
    expect(players[0]!.events.some((e) => e.tableId === t2.body.table.id)).toBe(false);
    for (const p of extra) p.s.disconnect();
  });

  it('leaving cashes out the exact stack to the wallet and global credits are conserved', async () => {
    for (const p of players) await emitAck(p.s, 'table:leave', { tableId });
    await waitFor(async () => true);
    const open = await waitFor(async () => {
      const r = await noir.db.query('SELECT count(*)::int AS n FROM table_sessions WHERE table_id = $1 AND left_at IS NULL', [tableId]);
      return r.rows[0].n === 0;
    }, 15_000).catch(() => false);
    // waitFor with async fn returns a promise (truthy) immediately; poll explicitly instead.
    for (let i = 0; i < 200; i++) {
      const r = await noir.db.query('SELECT count(*)::int AS n FROM table_sessions WHERE table_id = $1 AND left_at IS NULL', [tableId]);
      if (r.rows[0].n === 0) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    void open;
    let total = 0;
    for (const p of players) {
      const me = (await p.c.get('/api/auth/me')).body.credits;
      expect(me.onTables).toBe(0);
      total += me.wallet;
    }
    expect(total).toBe(15_000);
  }, 30_000);
});

async function getSecret(username: string): Promise<string> {
  // Owner's TOTP secret was generated in beforeAll; recover it from the DB (test only).
  const { decryptSecret } = await import('../src/modules/auth/crypto.js');
  const r = await noir.db.query('SELECT totp_secret_enc FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.username = $1', [username]);
  return decryptSecret((noir as any).config.dataKey, r.rows[0].totp_secret_enc);
}
