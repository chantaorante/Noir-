import { randomUUID } from 'node:crypto';
import {
  applyAction, chainHash, commitmentOf, createDeckSecret, dealOrder, dealPermutation, legalOptions, mixEntropy, nextButtonSeat,
  projectForViewer, revealCard, startHand, timeoutAction, type DeckSecret, type HandState, type RoutedEvent,
} from '@noir/engine';
import type { CardRevealDto, FairnessInfo, SeatView } from '@noir/shared';
import { withTx, type Db, type Tx } from '../../db/pool.js';
import { HttpError } from '../../http/errors.js';
import { postEntry } from '../ledger/ledger.js';
import { onHandComplete, type ProgressNotice } from '../progression/progression.js';

export interface TableRow {
  id: string;
  name: string;
  max_seats: number;
  small_blind: number;
  big_blind: number;
  ante: number;
  min_buy_in: number;
  max_buy_in: number;
  action_seconds: number;
  is_private: boolean;
  access_code_hash: string | null;
  host_id: string | null;
  status: string;
  chain_head: string;
  closes_at: Date | null;
}

export interface Emitter {
  toTable(tableId: string, event: string, data: unknown): void;
  toUser(userId: string, event: string, data: unknown): void;
  lobbyChanged(tableId: string): void;
}

interface Seat {
  seat: number;
  userId: string;
  displayName: string;
  avatarKey: string;
  level: number;
  stack: number;
  sessionRowId: string;
  sittingOut: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  consecutiveTimeouts: number;
  leaveAfterHand: boolean;
}

interface ActiveHand {
  id: string;
  no: number;
  state: HandState;
  secret: DeckSecret;
  perm: number[];
  fairness: FairnessInfo;
  eventSeq: number;
  turnStartedAt: number;
  deadline: number | null;
  /** Seats dealt into this hand → userId */
  seatUsers: Map<number, string>;
}

type ActionResult = { ok: true } | { ok: false; error: string; code: string };

const MAX_CONSECUTIVE_TIMEOUTS = 2;
const DISCONNECTED_CASHOUT_MS = 10 * 60_000;

export class TableActor {
  private seats = new Map<number, Seat>();
  private hand: ActiveHand | null = null;
  private lastButton: number | null = null;
  private handNo = 0;
  private chainHead: string;
  /** Commitment for the NEXT hand, published before entropy is accepted. */
  private next: { handId: string; secret: DeckSecret; entropy: Map<string, string> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private actionTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private processedActions = new Map<string, ActionResult>();
  /** Users allowed to view a private table (host, invitees, users who entered the code). */
  private authorized = new Set<string>();
  closed = false;

  constructor(
    public row: TableRow,
    private readonly db: Db,
    private readonly io: Emitter,
    private readonly opts: { handPauseMs: number; log: (msg: string, extra?: unknown) => void },
  ) {
    this.chainHead = row.chain_head;
    if (row.host_id) this.authorized.add(row.host_id);
  }

  get id() {
    return this.row.id;
  }

  /** Serialize every mutation through one queue: no two commands touch table state concurrently. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  // ------------------------------------------------------------------ restore
  async restore(): Promise<void> {
    const r = await this.db.query(
      `SELECT ts.id, ts.seat, ts.user_id, ts.stack, p.display_name, p.avatar_key, COALESCE(up.level, 1) AS level
         FROM table_sessions ts JOIN user_profiles p ON p.user_id = ts.user_id LEFT JOIN user_progress up ON up.user_id = ts.user_id
        WHERE ts.table_id = $1 AND ts.left_at IS NULL`,
      [this.id],
    );
    for (const s of r.rows) {
      this.seats.set(s.seat, { seat: s.seat, userId: s.user_id, displayName: s.display_name, avatarKey: s.avatar_key, level: s.level, stack: s.stack, sessionRowId: s.id, sittingOut: false, connected: false, disconnectedAt: Date.now(), consecutiveTimeouts: 0, leaveAfterHand: false });
      this.authorized.add(s.user_id);
    }
    const last = await this.db.query<{ hand_no: number; button_seat: number }>('SELECT hand_no, button_seat FROM hands WHERE table_id = $1 ORDER BY hand_no DESC LIMIT 1', [this.id]);
    this.handNo = last.rows[0]?.hand_no ?? 0;
    this.lastButton = last.rows[0]?.button_seat ?? null;
    const inv = await this.db.query<{ user_id: string }>('SELECT user_id FROM table_invites WHERE table_id = $1', [this.id]);
    for (const i of inv.rows) this.authorized.add(i.user_id);
    this.prepareCommitment();
  }

  // ------------------------------------------------------------------ views
  summary() {
    return {
      id: this.id, name: this.row.name, variant: 'NLHE' as const, maxSeats: this.row.max_seats, seated: this.seats.size,
      smallBlind: this.row.small_blind, bigBlind: this.row.big_blind, minBuyIn: this.row.min_buy_in, maxBuyIn: this.row.max_buy_in,
      isPrivate: this.row.is_private, status: this.row.status, handsPerHour: null, players: [...this.seats.values()].map((s) => s.userId),
    };
  }

  seatViews(): SeatView[] {
    return [...this.seats.values()].sort((a, b) => a.seat - b.seat).map((s) => ({
      seat: s.seat, userId: s.userId, displayName: s.displayName, avatarKey: s.avatarKey, level: s.level, stack: this.liveStack(s), sittingOut: s.sittingOut, connected: s.connected,
    }));
  }

  private liveStack(s: Seat): number {
    const p = this.hand?.state.players.find((x) => x.seat === s.seat && x.playerId === s.userId);
    return p ? p.stack : s.stack;
  }

  canView(userId: string): boolean {
    return !this.row.is_private || this.authorized.has(userId);
  }

  authorize(userId: string) {
    this.authorized.add(userId);
  }

  seatOf(userId: string): Seat | undefined {
    for (const s of this.seats.values()) if (s.userId === userId) return s;
    return undefined;
  }

  /** Full state for one viewer (used on watch and reconnect). Never includes other players' hidden cards. */
  snapshot(userId: string) {
    const mine = this.seatOf(userId);
    const h = this.hand;
    let hand = null;
    if (h) {
      const viewerSeat = mine && h.seatUsers.get(mine.seat) === userId ? mine.seat : null;
      const view = projectForViewer(h.state, viewerSeat);
      const reveals: CardRevealDto[] = [];
      if (viewerSeat !== null) {
        const me = h.state.players.find((p) => p.seat === viewerSeat)!;
        for (const k of me.holeDealIndices) reveals.push(revealCard(h.secret, k, h.perm));
      }
      for (const k of h.state.boardDealIndices) reveals.push(revealCard(h.secret, k, h.perm));
      for (const seat of h.state.result?.shownSeats ?? []) {
        if (seat === viewerSeat) continue;
        for (const k of h.state.players.find((p) => p.seat === seat)!.holeDealIndices) reveals.push(revealCard(h.secret, k, h.perm));
      }
      hand = { ...view, reveals, fairness: h.fairness, deadline: h.deadline, handNo: h.no };
    }
    return {
      table: { id: this.id, name: this.row.name, maxSeats: this.row.max_seats, smallBlind: this.row.small_blind, bigBlind: this.row.big_blind, minBuyIn: this.row.min_buy_in, maxBuyIn: this.row.max_buy_in, actionSeconds: this.row.action_seconds, isPrivate: this.row.is_private, status: this.row.status },
      seats: this.seatViews(),
      mySeat: mine?.seat ?? null,
      hand,
      nextCommitment: this.next ? { ...commitmentOf(this.next.secret), handId: this.next.handId, contributed: this.next.entropy.has(userId) } : null,
      serverTime: Date.now(),
    };
  }

  // ------------------------------------------------------------------ presence
  setConnected(userId: string, connected: boolean) {
    return this.run(async () => {
      const s = this.seatOf(userId);
      if (!s || s.connected === connected) return;
      s.connected = connected;
      s.disconnectedAt = connected ? null : Date.now();
      this.broadcastSeats();
    });
  }

  /** Periodic sweep: cash out players disconnected for too long while no hand involves them. */
  sweep() {
    return this.run(async () => {
      const now = Date.now();
      for (const s of [...this.seats.values()]) {
        if (!s.connected && s.disconnectedAt && now - s.disconnectedAt > DISCONNECTED_CASHOUT_MS && !this.inHand(s)) await this.cashOut(s, 'disconnected');
      }
      if (this.row.closes_at && this.row.closes_at.getTime() < now && !this.hand) await this.closeInternal('duration_elapsed');
    });
  }

  private inHand(s: Seat): boolean {
    const h = this.hand;
    if (!h || h.state.street === 'complete') return false;
    return h.seatUsers.get(s.seat) === s.userId && h.state.players.find((p) => p.seat === s.seat)?.status !== 'folded';
  }

  // ------------------------------------------------------------------ seating
  sit(userId: string, seat: number, buyIn: number) {
    return this.run(async () => {
      if (this.closed || this.row.status !== 'open') throw new HttpError(409, 'TABLE_CLOSED', 'This table is not open.');
      if (seat >= this.row.max_seats) throw new HttpError(400, 'BAD_SEAT', 'That seat does not exist.');
      if (this.seats.has(seat)) throw new HttpError(409, 'SEAT_TAKEN', 'That seat is taken.');
      if (this.seatOf(userId)) throw new HttpError(409, 'ALREADY_SEATED', 'You are already seated at this table.');
      if (buyIn < this.row.min_buy_in || buyIn > this.row.max_buy_in) throw new HttpError(400, 'BAD_BUY_IN', `Buy-in must be between ${this.row.min_buy_in} and ${this.row.max_buy_in}.`);
      if (!this.canView(userId)) throw new HttpError(403, 'PRIVATE', 'This is a private table.');

      const created = await withTx(this.db, async (tx) => {
        await this.checkLimits(tx, userId, buyIn);
        const ts = await tx.query<{ id: string }>('INSERT INTO table_sessions (table_id, user_id, seat, buy_in_total, stack) VALUES ($1,$2,$3,$4,$4) RETURNING id', [this.id, userId, seat, buyIn]);
        const id = ts.rows[0]!.id;
        await postEntry(tx, { userId, amount: -buyIn, type: 'TABLE_BUY_IN', referenceType: 'table_session', referenceId: id, metadata: { tableId: this.id, seat } });
        const p = await tx.query('SELECT p.display_name, p.avatar_key, COALESCE(up.level,1) AS level FROM user_profiles p LEFT JOIN user_progress up ON up.user_id = p.user_id WHERE p.user_id = $1', [userId]);
        return { id, profile: p.rows[0] };
      }).catch((err) => {
        if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'SEAT_TAKEN', 'That seat is taken or you are already seated.');
        throw err;
      });
      this.seats.set(seat, { seat, userId, displayName: created.profile.display_name, avatarKey: created.profile.avatar_key, level: created.profile.level, stack: buyIn, sessionRowId: created.id, sittingOut: false, connected: true, disconnectedAt: null, consecutiveTimeouts: 0, leaveAfterHand: false });
      this.authorized.add(userId);
      this.broadcastSeats();
      this.io.lobbyChanged(this.id);
      this.scheduleStart();
    });
  }

  private async checkLimits(tx: Tx, userId: string, buyIn: number) {
    const l = (await tx.query('SELECT max_buy_in, max_daily_buy_in FROM account_limits WHERE user_id = $1', [userId])).rows[0];
    if (!l) return;
    if (l.max_buy_in && buyIn > l.max_buy_in) throw new HttpError(403, 'LIMIT', 'This buy-in exceeds your account limit.');
    if (l.max_daily_buy_in) {
      const used = (await tx.query<{ s: number }>(`SELECT COALESCE(-SUM(amount),0)::bigint AS s FROM credit_ledger WHERE user_id = $1 AND entry_type = 'TABLE_BUY_IN' AND created_at > now() - interval '24 hours'`, [userId])).rows[0]!.s;
      if (used + buyIn > l.max_daily_buy_in) throw new HttpError(403, 'LIMIT', 'This buy-in exceeds your daily limit.');
    }
  }

  rebuy(userId: string, amount: number) {
    return this.run(async () => {
      const s = this.seatOf(userId);
      if (!s) throw new HttpError(409, 'NOT_SEATED', 'You are not seated here.');
      if (this.hand && this.hand.seatUsers.get(s.seat) === userId && this.hand.state.street !== 'complete') throw new HttpError(409, 'IN_HAND', 'You can add chips after this hand.');
      if (s.stack + amount > this.row.max_buy_in) throw new HttpError(400, 'BAD_BUY_IN', `Your stack cannot exceed ${this.row.max_buy_in}.`);
      if (s.stack + amount < this.row.min_buy_in && s.stack === 0) throw new HttpError(400, 'BAD_BUY_IN', `Add at least ${this.row.min_buy_in}.`);
      await withTx(this.db, async (tx) => {
        await this.checkLimits(tx, userId, amount);
        await postEntry(tx, { userId, amount: -amount, type: 'TABLE_BUY_IN', referenceType: 'table_session', referenceId: s.sessionRowId, metadata: { tableId: this.id, rebuy: true } });
        await tx.query('UPDATE table_sessions SET stack = stack + $2, buy_in_total = buy_in_total + $2 WHERE id = $1', [s.sessionRowId, amount]);
      });
      s.stack += amount;
      s.sittingOut = false;
      this.broadcastSeats();
      this.scheduleStart();
    });
  }

  setSitOut(userId: string, sitOut: boolean) {
    return this.run(async () => {
      const s = this.seatOf(userId);
      if (!s) throw new HttpError(409, 'NOT_SEATED', 'You are not seated here.');
      s.sittingOut = sitOut;
      if (!sitOut) s.consecutiveTimeouts = 0;
      this.broadcastSeats();
      if (!sitOut) this.scheduleStart();
    });
  }

  leave(userId: string) {
    return this.run(async () => {
      const s = this.seatOf(userId);
      if (!s) return;
      if (this.inHand(s)) {
        // Fold now if it is their turn; otherwise leave once the hand finishes (their cards are folded when action reaches them).
        s.leaveAfterHand = true;
        s.sittingOut = true;
        if (this.hand!.state.toActSeat === s.seat) await this.applyInternal(s.seat, { type: 'fold' }, null);
        this.broadcastSeats();
        return;
      }
      await this.cashOut(s, 'left');
    });
  }

  private async cashOut(s: Seat, reason: string) {
    // Chips already committed to a running pot stay there; only the stack behind is returned.
    const stack = this.liveStack(s);
    await withTx(this.db, async (tx) => {
      if (stack > 0) await postEntry(tx, { userId: s.userId, amount: stack, type: 'TABLE_CASH_OUT', referenceType: 'table_session', referenceId: s.sessionRowId, metadata: { tableId: this.id, reason } });
      await tx.query('UPDATE table_sessions SET left_at = now(), cash_out = $2, stack = 0 WHERE id = $1', [s.sessionRowId, stack]);
    });
    this.seats.delete(s.seat);
    this.broadcastSeats();
    this.io.lobbyChanged(this.id);
    this.io.toUser(s.userId, 'table:left', { tableId: this.id, cashOut: stack, reason });
  }

  // ------------------------------------------------------------------ fairness entropy
  private prepareCommitment() {
    const handId = randomUUID();
    this.next = { handId, secret: createDeckSecret(handId), entropy: new Map() };
    this.io.toTable(this.id, 'table:commitment', { tableId: this.id, ...commitmentOf(this.next.secret), handId });
  }

  contributeEntropy(userId: string, commitId: string, entropy: string) {
    return this.run(async () => {
      if (!this.next || this.next.handId !== commitId) throw new HttpError(409, 'STALE_COMMITMENT', 'That commitment is no longer open.');
      if (!this.seatOf(userId)) throw new HttpError(409, 'NOT_SEATED', 'Only seated players contribute entropy.');
      if (this.next.entropy.has(userId)) return;
      this.next.entropy.set(userId, entropy);
    });
  }

  // ------------------------------------------------------------------ hand lifecycle
  private scheduleStart(delay = 400) {
    if (this.hand && this.hand.state.street !== 'complete') return;
    if (this.startTimer || this.closed) return;
    if (this.eligibleSeats().length < 2) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.run(() => this.startNextHand()).catch((err) => this.opts.log('start hand failed', err));
    }, delay);
  }

  private eligibleSeats(): Seat[] {
    return [...this.seats.values()].filter((s) => s.stack > 0 && !s.sittingOut && !s.leaveAfterHand && (s.connected || s.disconnectedAt === null || Date.now() - s.disconnectedAt < 60_000));
  }

  private async startNextHand() {
    if (this.closed || this.row.status !== 'open') return;
    if (this.hand && this.hand.state.street !== 'complete') return;
    const players = this.eligibleSeats();
    if (players.length < 2 || !this.next) return;

    const { handId, secret, entropy } = this.next;
    this.next = null;
    const contributions = players.filter((p) => entropy.has(p.userId)).map((p) => ({ playerId: p.userId, entropy: entropy.get(p.userId)! }));
    const mix = mixEntropy(secret.root, contributions);
    const perm = dealPermutation(mix);
    const deck = dealOrder(secret, perm);
    const button = nextButtonSeat(this.lastButton, players.map((p) => p.seat));
    const cfg = { smallBlind: this.row.small_blind, bigBlind: this.row.big_blind, ante: this.row.ante, maxSeats: this.row.max_seats };
    const res = startHand(handId, cfg, players.map((p) => ({ seat: p.seat, playerId: p.userId, stack: p.stack })), button, deck);
    const no = this.handNo + 1;
    const fairness: FairnessInfo = { commitId: handId, root: secret.root, mix, contributions };

    await withTx(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO hands (id, table_id, hand_no, button_seat, small_blind, big_blind, ante, deck_commit_id, deck_root, entropy_mix) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [handId, this.id, no, button, cfg.smallBlind, cfg.bigBlind, cfg.ante, handId, secret.root, mix],
      );
      await tx.query('INSERT INTO hand_secrets (hand_id, deck, salts) VALUES ($1,$2,$3)', [handId, secret.cards, secret.salts]);
      for (const c of contributions) await tx.query('INSERT INTO hand_entropy (hand_id, user_id, entropy) VALUES ($1,$2,$3)', [handId, c.playerId, c.entropy]);
      for (const p of res.state.players) await tx.query('INSERT INTO hand_players (hand_id, user_id, seat, starting_stack, hole_cards) VALUES ($1,$2,$3,$4,$5)', [handId, p.playerId, p.seat, p.startingStack, p.hole]);
    });
    this.handNo = no;
    this.lastButton = button;
    this.hand = { id: handId, no, state: res.state, secret, perm, fairness, eventSeq: 0, turnStartedAt: Date.now(), deadline: null, seatUsers: new Map(res.state.players.map((p) => [p.seat, p.playerId])) };
    this.io.toTable(this.id, 'table:handStarted', { tableId: this.id, handId, handNo: no, fairness });
    await this.commitEvents(res.events, null);
    this.io.lobbyChanged(this.id);
  }

  /** Player action from a socket. userId comes from the authenticated session, never the payload. */
  act(userId: string, p: { handId: string; actionId: string; expectedSeq: number; type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'; amount?: number | undefined }): Promise<ActionResult> {
    return this.run(async () => {
      const prior = this.processedActions.get(p.actionId);
      if (prior) return prior; // idempotent replay
      const h = this.hand;
      const s = this.seatOf(userId);
      const fail = (code: string, error: string): ActionResult => ({ ok: false, code, error });
      let result: ActionResult;
      if (!h || h.id !== p.handId || h.state.street === 'complete') result = fail('HAND_OVER', 'That hand is over.');
      else if (!s || h.seatUsers.get(s.seat) !== userId) result = fail('NOT_IN_HAND', 'You are not in this hand.');
      else if (p.expectedSeq !== h.state.seq) result = fail('STALE', 'The table moved on. Your view has been refreshed.');
      else {
        const r = await this.applyInternal(s.seat, { type: p.type, amount: p.amount }, { actionId: p.actionId, userId });
        result = r;
        if (r.ok) s.consecutiveTimeouts = 0;
      }
      this.processedActions.set(p.actionId, result);
      if (this.processedActions.size > 2000) this.processedActions.delete(this.processedActions.keys().next().value!);
      return result;
    });
  }

  private async applyInternal(seat: number, cmd: { type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'; amount?: number | undefined }, meta: { actionId: string; userId: string } | null): Promise<ActionResult> {
    const h = this.hand!;
    const street = h.state.street;
    const res = applyAction(h.state, { seat, type: cmd.type, ...(cmd.amount !== undefined ? { amount: cmd.amount } : {}) });
    const decisionMs = Date.now() - h.turnStartedAt;
    if (meta) {
      await this.db.query(
        'INSERT INTO player_actions (action_id, hand_id, user_id, seat, street, action, amount, accepted, reject_code, decision_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (action_id) DO NOTHING',
        [meta.actionId, h.id, meta.userId, seat, street, cmd.type, cmd.amount ?? null, res.ok, res.ok ? null : res.code, decisionMs],
      );
    }
    if (!res.ok) return { ok: false, code: res.code, error: res.message };
    h.state = res.state;
    await this.commitEvents(res.events, null);
    return { ok: true };
  }

  /** Persist events (hash-chained) and only then fan them out with the right visibility. */
  private async commitEvents(events: RoutedEvent[], tx: Tx | null) {
    const h = this.hand!;
    const rows: { seq: number; type: string; vis: string; payload: unknown; prev: string; hash: string }[] = [];
    for (const e of events) {
      const seq = ++h.eventSeq;
      const vis = e.visibility.to === 'public' ? 'public' : `seat:${e.visibility.seat}`;
      const hash = chainHash(this.chainHead, seq, e.event.type, e.event);
      rows.push({ seq, type: e.event.type, vis, payload: e.event, prev: this.chainHead, hash });
      this.chainHead = hash;
    }
    const write = async (q: Tx) => {
      for (const r of rows) {
        await q.query('INSERT INTO hand_events (hand_id, seq, type, visibility, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)', [h.id, r.seq, r.type, r.vis, r.payload, r.prev, r.hash]);
      }
      await q.query('UPDATE poker_tables SET chain_head = $2 WHERE id = $1', [this.id, this.chainHead]);
    };
    if (tx) await write(tx);
    else await withTx(this.db, write);

    let ended = false;
    for (const [i, e] of events.entries()) {
      const meta = { tableId: this.id, handId: h.id, seq: h.state.seq, eventSeq: rows[i]!.seq, hash: rows[i]!.hash };
      const ev = e.event;
      if (e.visibility.to === 'seat') {
        const userId = h.seatUsers.get(e.visibility.seat);
        if (userId && ev.type === 'HOLE_CARDS') {
          const reveals = ev.dealIndices.map((k) => revealCard(h.secret, k, h.perm));
          this.io.toUser(userId, 'table:private', { ...meta, event: ev, reveals });
        }
        continue;
      }
      let reveals: CardRevealDto[] | undefined;
      if (ev.type === 'STREET_DEALT') reveals = ev.dealIndices.map((k) => revealCard(h.secret, k, h.perm));
      if (ev.type === 'SHOWDOWN') reveals = ev.reveals.flatMap((r) => r.dealIndices.map((k) => revealCard(h.secret, k, h.perm)));
      let deadline: number | null = null;
      if (ev.type === 'TURN') {
        deadline = this.armTimer(ev.seat);
      }
      this.io.toTable(this.id, 'table:event', { ...meta, event: ev, ...(reveals ? { reveals } : {}), ...(deadline ? { deadline } : {}) });
      if (ev.type === 'HAND_ENDED') ended = true;
    }
    if (ended) await this.finishHand();
  }

  private armTimer(seat: number): number {
    const h = this.hand!;
    if (this.actionTimer) clearTimeout(this.actionTimer);
    const s = this.seats.get(seat);
    // Players who already chose to leave/sit out act instantly by timeout policy.
    const ms = s && (s.leaveAfterHand || (s.sittingOut && !s.connected)) ? 300 : this.row.action_seconds * 1000;
    h.turnStartedAt = Date.now();
    h.deadline = Date.now() + ms;
    const handId = h.id;
    const seq = h.state.seq;
    this.actionTimer = setTimeout(() => {
      void this.run(async () => {
        const cur = this.hand;
        if (!cur || cur.id !== handId || cur.state.seq !== seq || cur.state.street === 'complete') return;
        const cmd = timeoutAction(cur.state);
        if (!cmd) return;
        const st = this.seats.get(cmd.seat);
        if (st) {
          st.consecutiveTimeouts++;
          if (st.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) st.sittingOut = true;
        }
        this.io.toTable(this.id, 'table:timeout', { tableId: this.id, handId, seat: cmd.seat, action: cmd.type });
        await this.applyInternal(cmd.seat, { type: cmd.type }, null);
        this.broadcastSeats();
      }).catch((err) => this.opts.log('timeout failed', err));
    }, ms);
    return h.deadline;
  }

  private async finishHand() {
    const h = this.hand!;
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = null;
    h.deadline = null;
    const result = h.state.result!;
    let notices: ProgressNotice[] = [];
    await withTx(this.db, async (tx) => {
      const totalPot = result.pots.reduce((a, p) => a + p.amount, 0);
      await tx.query(`UPDATE hands SET status = 'complete', ended_at = now(), board = $2, total_pot = $3 WHERE id = $1`, [h.id, h.state.board, totalPot]);
      for (const [i, pot] of result.pots.entries()) {
        const award = result.awards.find((a) => a.potIndex === i);
        const handName = null;
        await tx.query('INSERT INTO hand_pots (hand_id, pot_index, amount, eligible_seats, winners, hand_name) VALUES ($1,$2,$3,$4,$5,$6)', [h.id, i, pot.amount, pot.eligible, JSON.stringify(award?.winners ?? []), handName]);
      }
      const winners = new Set(result.awards.flatMap((a) => a.winners.map((w) => w.seat)));
      for (const p of h.state.players) {
        const d = result.deltas.find((x) => x.seat === p.seat)!;
        await tx.query('UPDATE hand_players SET final_stack = $3, net = $4, shown = $5, folded = $6, went_to_showdown = $7, won = $8 WHERE hand_id = $1 AND seat = $2', [
          h.id, p.seat, d.finalStack, d.delta, result.shownSeats.includes(p.seat), p.status === 'folded', result.wentToShowdown && p.status !== 'folded', winners.has(p.seat),
        ]);
        const s = this.seats.get(p.seat);
        if (s && s.userId === p.playerId) {
          await tx.query('UPDATE table_sessions SET stack = $2 WHERE id = $1', [s.sessionRowId, d.finalStack]);
        }
      }
      notices = await onHandComplete(tx, h.id, h.state);
    });
    for (const p of h.state.players) {
      const s = this.seats.get(p.seat);
      if (s && s.userId === p.playerId) s.stack = p.stack;
    }
    for (const n of notices) this.io.toUser(n.userId, 'notify', n);
    for (const s of [...this.seats.values()]) {
      if (s.leaveAfterHand) await this.cashOut(s, 'left');
      else if (s.stack === 0) s.sittingOut = true;
    }
    this.broadcastSeats();
    this.prepareCommitment();
    if (this.closed || this.row.status !== 'open') return;
    this.scheduleStart(this.opts.handPauseMs);
  }

  // ------------------------------------------------------------------ admin
  setStatus(status: 'open' | 'paused' | 'closed') {
    return this.run(async () => {
      if (status === 'closed') return this.closeInternal('admin');
      this.row.status = status;
      await this.db.query('UPDATE poker_tables SET status = $2 WHERE id = $1', [this.id, status]);
      this.io.toTable(this.id, 'table:status', { tableId: this.id, status });
      this.io.lobbyChanged(this.id);
      if (status === 'open') this.scheduleStart();
    });
  }

  private async closeInternal(reason: string) {
    if (this.hand && this.hand.state.street !== 'complete') {
      // Let the current hand finish; table closes after it.
      this.row.status = 'paused';
      await this.db.query(`UPDATE poker_tables SET status = 'paused' WHERE id = $1`, [this.id]);
      return;
    }
    for (const s of [...this.seats.values()]) await this.cashOut(s, `table_closed:${reason}`);
    this.row.status = 'closed';
    this.closed = true;
    await this.db.query(`UPDATE poker_tables SET status = 'closed' WHERE id = $1`, [this.id]);
    this.io.toTable(this.id, 'table:status', { tableId: this.id, status: 'closed' });
    this.io.lobbyChanged(this.id);
    this.dispose();
  }

  dispose() {
    if (this.actionTimer) clearTimeout(this.actionTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.actionTimer = this.startTimer = null;
  }

  /** Wait until all queued work is done (tests and graceful shutdown). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private broadcastSeats() {
    this.io.toTable(this.id, 'table:seats', { tableId: this.id, seats: this.seatViews() });
  }

  /** Test/diagnostic accessor. */
  debugState() {
    return { hand: this.hand?.state ?? null, seats: [...this.seats.values()], options: this.hand ? (seat: number) => legalOptions(this.hand!.state, seat) : null };
  }
}
