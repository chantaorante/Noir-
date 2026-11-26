import { hashPassword, verifyPassword } from '../auth/crypto.js';
import type { Db } from '../../db/pool.js';
import { HttpError } from '../../http/errors.js';
import { TableActor, type Emitter, type TableRow } from './actor.js';

export class TableManager {
  private actors = new Map<string, TableActor>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db, private readonly io: Emitter, private readonly opts: { handPauseMs: number; log: (m: string, e?: unknown) => void }) {}

  /** On boot: void hands interrupted by a crash/restart, then restore open tables and seated players. */
  async start(): Promise<{ voided: number; tables: number }> {
    const voided = await this.db.query(`UPDATE hands SET status = 'voided', ended_at = now() WHERE status = 'running' RETURNING id`);
    // Stacks are persisted at hand boundaries, so a voided hand returns every player to their pre-hand stack.
    const rows = (await this.db.query<TableRow>(`SELECT * FROM poker_tables WHERE status <> 'closed' AND tournament_id IS NULL`)).rows;
    for (const row of rows) await this.load(row);
    this.sweepTimer = setInterval(() => {
      for (const a of this.actors.values()) void a.sweep().catch((e) => this.opts.log('sweep failed', e));
    }, 30_000);
    this.sweepTimer.unref();
    return { voided: voided.rowCount ?? 0, tables: rows.length };
  }

  private async load(row: TableRow): Promise<TableActor> {
    const actor = new TableActor(row, this.db, this.io, this.opts);
    await actor.restore();
    this.actors.set(row.id, actor);
    return actor;
  }

  get(id: string): TableActor {
    const a = this.actors.get(id);
    if (!a || a.closed) throw new HttpError(404, 'NO_TABLE', 'Table not found.');
    return a;
  }

  list(): TableActor[] {
    return [...this.actors.values()].filter((a) => !a.closed);
  }

  async create(input: { name: string; maxSeats: number; smallBlind: number; bigBlind: number; ante: number; minBuyIn: number; maxBuyIn: number; actionSeconds: number; isPrivate: boolean; accessCode?: string | undefined; durationMinutes?: number | undefined }, createdBy: string, host: boolean): Promise<TableActor> {
    const codeHash = input.isPrivate && input.accessCode ? await hashPassword(input.accessCode) : null;
    const r = await this.db.query<TableRow>(
      `INSERT INTO poker_tables (name, max_seats, small_blind, big_blind, ante, min_buy_in, max_buy_in, action_seconds, is_private, access_code_hash, host_id, created_by, closes_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $13::int IS NULL THEN NULL ELSE now() + make_interval(mins => $13::int) END) RETURNING *`,
      [input.name, input.maxSeats, input.smallBlind, input.bigBlind, input.ante, input.minBuyIn, input.maxBuyIn, input.actionSeconds, input.isPrivate, codeHash, host ? createdBy : null, createdBy, input.durationMinutes ?? null],
    );
    await this.db.query(`INSERT INTO chat_channels (kind, table_id) VALUES ('table', $1)`, [r.rows[0]!.id]);
    const actor = await this.load(r.rows[0]!);
    this.io.lobbyChanged(actor.id);
    return actor;
  }

  /** Grants viewing/sitting rights for a private table after verifying its access code. */
  async unlock(actor: TableActor, userId: string, code: string | undefined): Promise<void> {
    if (actor.canView(userId)) return;
    if (!code || !actor.row.access_code_hash || !(await verifyPassword(actor.row.access_code_hash, code))) throw new HttpError(403, 'BAD_CODE', 'Incorrect access code.');
    actor.authorize(userId);
  }

  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const a of this.actors.values()) {
      await a.idle();
      a.dispose();
    }
  }
}
