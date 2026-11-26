/**
 * Load test: N simulated players (real HTTP login + real Socket.IO connections) seated 6 per table,
 * playing real hands with random think times. Reports action-ack latency, hands completed,
 * errors, process resource use, and verifies chip conservation and every ledger chain afterwards.
 *
 * Usage: pnpm --filter @noir/server exec tsx test/load.ts <players> <seconds>
 * DESTRUCTIVE TO ITS OWN DATABASE ONLY: resets LOAD_DATABASE_URL (must contain "load" in its name).
 * Results describe the machine it ran on; they say nothing about other hardware.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Socket } from 'socket.io-client';
import { loadConfig } from '../src/config/env.js';
import { createPool, withTx } from '../src/db/pool.js';
import { createNoir } from '../src/server.js';
import { insertUser } from '../src/modules/auth/users.js';
import { postEntry, verifyUserLedger } from '../src/modules/ledger/ledger.js';
import { Client, connectSocket, emitAck } from './harness.js';

const N = Number(process.argv[2] ?? 10);
const SECONDS = Number(process.argv[3] ?? 60);
const DB = process.env.LOAD_DATABASE_URL ?? 'postgres://noir:noir_dev_only@localhost:5432/noir_load';
if (!/load/.test(new URL(DB).pathname)) throw new Error('LOAD_DATABASE_URL must name a load-test database');
const BANKROLL = 5_000;
const BUY_IN = 1_000;

const reset = createPool(DB, 1);
await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await reset.end();

const ORIGIN = 'http://localhost:3999';
const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: DB, PUBLIC_ORIGINS: ORIGIN, NOIR_DATA_KEY: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false', TRUST_PROXY: 'false', HOST: '127.0.0.1', PORT: '0', HAND_PAUSE_MS: '1500', LOG_LEVEL: 'error', LOGIN_RATE_LIMIT: '10000',
});
const noir = await createNoir(config, { listen: true });
const addr = noir.app.server.address();
const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

// ---- seed
const owner = await withTx(noir.db, (tx) => insertUser(tx, { username: 'loadowner', displayName: 'Load Owner', role: 'owner', password: randomUUID() }));
const PASSWORD = 'Correct-Horse-Battery-9';
const users: { id: string; username: string }[] = [];
for (let i = 0; i < N; i++) {
  const username = `bot${String(i).padStart(3, '0')}`;
  const u = await withTx(noir.db, async (tx) => {
    const u = await insertUser(tx, { username, displayName: username, role: 'player', password: PASSWORD });
    await postEntry(tx, { userId: u.id, amount: BANKROLL, type: 'ADMIN_GRANT', reason: 'load test', adminId: owner.id });
    return u;
  });
  users.push({ id: u.id, username });
}
const tableIds: string[] = [];
for (let t = 0; t < Math.ceil(N / 6); t++) {
  const a = await noir.tables.create({ name: `Load ${t + 1}`, maxSeats: 6, smallBlind: 5, bigBlind: 10, ante: 0, minBuyIn: 200, maxBuyIn: 2000, actionSeconds: 20, isPrivate: false }, owner.id, false);
  tableIds.push(a.summary().id);
}

// ---- metrics
const ackMs: number[] = [];
const loginMs: number[] = [];
let errors = 0;
const errorCodes: Record<string, number> = {};
let windDown = false;
let windDownRejects = 0;
const handsEnded = new Set<string>();
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const cpu0 = process.cpuUsage();
let peakRss = 0;
const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);

// ---- bots
interface Bot { s: Socket; tableId: string; seat: number; stop: boolean }
const bots: Bot[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await Promise.all(users.map(async (u, i) => {
  const c = new Client(url);
  const t0 = performance.now();
  const r = await c.login(u.username, PASSWORD);
  loginMs.push(performance.now() - t0);
  if (r.status !== 200) throw new Error(`login failed for ${u.username}: ${r.status}`);
  const s = await connectSocket(url, c.cookie);
  const bot: Bot = { s, tableId: tableIds[Math.floor(i / 6)]!, seat: i % 6, stop: false };
  s.on('table:event', async (e: any) => {
    if (e.tableId !== bot.tableId) return;
    if (e.event.type === 'HAND_ENDED') handsEnded.add(e.handId);
    if (e.event.type !== 'TURN' || e.event.seat !== bot.seat || bot.stop) return;
    await sleep(150 + Math.random() * 650);
    const o = e.event.options;
    const roll = Math.random();
    let type: string = o.canCheck ? 'check' : 'call';
    let amount: number | undefined;
    if (roll < 0.08 && !o.canCheck) type = 'fold';
    else if (roll > 0.85 && (o.canBet || o.canRaise)) { type = o.canBet ? 'bet' : 'raise'; amount = o.minTo; }
    const a0 = performance.now();
    const ack = await emitAck(s, 'table:action', { tableId: bot.tableId, handId: e.handId, actionId: randomUUID(), expectedSeq: e.seq, type, ...(amount ? { amount } : {}) });
    ackMs.push(performance.now() - a0);
    if (!ack.ok) { if (windDown) windDownRejects++; else { errors++; errorCodes[ack.code] = (errorCodes[ack.code] ?? 0) + 1; } }
  });
  s.on('table:commitment', (e: any) => { if (e.tableId === bot.tableId && !bot.stop) void emitAck(s, 'table:entropy', { tableId: bot.tableId, commitId: e.handId, entropy: randomBytes(32).toString('hex') }); });
  const w = await emitAck(s, 'table:watch', { tableId: bot.tableId });
  if (!w.ok) throw new Error(`watch failed: ${w.error}`);
  const sit = await emitAck(s, 'table:sit', { tableId: bot.tableId, seat: bot.seat, buyIn: BUY_IN });
  if (!sit.ok) throw new Error(`sit failed: ${sit.error}`);
  bots.push(bot);
}));

const started = Date.now();
process.stdout.write(`[load] ${N} players on ${tableIds.length} tables; running ${SECONDS}s\n`);
await sleep(SECONDS * 1000);

// ---- wind down: stop acting voluntarily (timeouts auto-act), leave tables, wait for cash-outs
// Bots keep acting during wind-down so running hands finish; leaving takes effect after the hand.
windDown = true; // leaving folds a player who is to act, so a bot mid-think can legitimately get STALE/HAND_OVER
await Promise.all(bots.map((b) => emitAck(b.s, 'table:leave', { tableId: b.tableId })));
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const open = await noir.db.query('SELECT count(*)::int AS n FROM table_sessions WHERE left_at IS NULL');
  if (open.rows[0].n === 0) break;
  await sleep(500);
}
const elapsed = (Date.now() - started) / 1000;
clearInterval(rssTimer);
loop.disable();
const cpu = process.cpuUsage(cpu0);

// ---- integrity
const open = (await noir.db.query('SELECT count(*)::int AS n, COALESCE(SUM(stack),0)::bigint AS s FROM table_sessions WHERE left_at IS NULL')).rows[0];
const wallets = (await noir.db.query(`SELECT COALESCE(SUM(b),0)::bigint AS s FROM (SELECT DISTINCT ON (user_id) balance_after AS b FROM credit_ledger WHERE user_id = ANY($1) ORDER BY user_id, seq DESC) x`, [users.map((u) => u.id)])).rows[0].s;
let brokenLedgers = 0;
for (const u of users) if ((await verifyUserLedger(noir.db, u.id)) !== null) brokenLedgers++;
const hands = (await noir.db.query(`SELECT count(*) FILTER (WHERE status = 'complete')::int AS complete, count(*) FILTER (WHERE status = 'voided')::int AS voided FROM hands`)).rows[0];

const pct = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };
const r1 = (x: number) => Math.round(x * 10) / 10;
const report = {
  players: N, tables: tableIds.length, durationSeconds: r1(elapsed),
  host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: r1(os.totalmem() / 2 ** 30), node: process.version },
  hands: { endedObserved: handsEnded.size, completeInDb: hands.complete, voidedInDb: hands.voided, perMinute: r1((hands.complete / elapsed) * 60) },
  actions: { count: ackMs.length, rejectedDuringPlay: errors, rejectedByCode: errorCodes, rejectedDuringWindDown: windDownRejects, ackMs: { p50: r1(pct(ackMs, 50)), p95: r1(pct(ackMs, 95)), p99: r1(pct(ackMs, 99)), max: r1(Math.max(...ackMs)) } },
  loginMs: { p50: r1(pct(loginMs, 50)), p95: r1(pct(loginMs, 95)), max: r1(Math.max(...loginMs)) },
  process: { peakRssMB: r1(peakRss / 2 ** 20), cpuSeconds: r1((cpu.user + cpu.system) / 1e6), eventLoopDelayMs: { p50: r1(loop.percentile(50) / 1e6), p99: r1(loop.percentile(99) / 1e6), max: r1(loop.max / 1e6) } },
  integrity: { expectedTotal: N * BANKROLL, walletsTotal: Number(wallets), stillSeated: open.n, chipsStillOnTables: Number(open.s), conserved: Number(wallets) + Number(open.s) === N * BANKROLL, brokenLedgers },
};
console.log(JSON.stringify(report, null, 2));
for (const b of bots) b.s.disconnect();
await noir.close();
process.exit(report.integrity.conserved && brokenLedgers === 0 ? 0 : 1);
