/**
 * No-Limit Texas Hold'em hand state machine. Pure: no I/O, no clock, no randomness.
 * The caller supplies the deck already in deal order (see fairness.ts) and receives
 * events tagged with visibility so the server can route private data correctly.
 */
import type { Card } from './cards.js';
import { evaluate, type HandValue } from './evaluator.js';
import { computePots, splitPot, type Pot } from './pots.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';
export type PlayerStatus = 'active' | 'folded' | 'allin';

export interface HandConfig {
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;
}

export interface SeatInput {
  seat: number;
  playerId: string;
  stack: number;
}

export interface PlayerState {
  seat: number;
  playerId: string;
  /** Chips behind (not yet committed). */
  stack: number;
  startingStack: number;
  /** Chips committed on the current street (blinds included). */
  streetCommitted: number;
  /** Chips committed in the whole hand (antes included). */
  totalCommitted: number;
  status: PlayerStatus;
  /** Has voluntarily acted in the current betting round. */
  acted: boolean;
  /** currentBet at the moment this player last acted this round (for re-raise rights). */
  betLevelWhenActed: number;
  hole: Card[];
  holeDealIndices: number[];
}

export interface HandState {
  handId: string;
  config: HandConfig;
  street: Street;
  buttonSeat: number;
  sbSeat: number;
  bbSeat: number;
  players: PlayerState[];
  deck: readonly Card[];
  nextDealIndex: number;
  board: Card[];
  boardDealIndices: number[];
  currentBet: number;
  /** Size of the last full bet/raise increment on this street (min raise increment). */
  minRaise: number;
  lastAggressorSeat: number | null;
  toActSeat: number | null;
  /** Increments with every accepted command; clients echo it to detect stale actions. */
  seq: number;
  /** Set when the remaining board was run out because nobody could act. */
  allInRunout: boolean;
  result: HandResult | null;
}

export type Visibility = { to: 'public' } | { to: 'seat'; seat: number };

export type HandEvent =
  | { type: 'HAND_STARTED'; handId: string; buttonSeat: number; sbSeat: number; bbSeat: number; players: { seat: number; playerId: string; stack: number }[] }
  | { type: 'ANTE_POSTED'; seat: number; amount: number; stack: number }
  | { type: 'BLIND_POSTED'; seat: number; blind: 'small' | 'big'; amount: number; stack: number; allIn: boolean }
  | { type: 'HOLE_CARDS_DEALT'; seats: number[] }
  | { type: 'HOLE_CARDS'; seat: number; cards: Card[]; dealIndices: number[] }
  | { type: 'PLAYER_ACTED'; seat: number; action: ActionType; amount: number; streetCommitted: number; stack: number; allIn: boolean; currentBet: number }
  | { type: 'TURN'; seat: number; options: ActionOptions }
  | { type: 'STREET_DEALT'; street: 'flop' | 'turn' | 'river'; cards: Card[]; dealIndices: number[]; board: Card[] }
  | { type: 'POTS_UPDATED'; pots: Pot[] }
  | { type: 'UNCALLED_RETURNED'; seat: number; amount: number }
  | { type: 'SHOWDOWN'; reveals: { seat: number; cards: Card[]; dealIndices: number[]; hand: { name: string; score: number; ranks: number[] } }[] }
  | { type: 'POT_AWARDED'; potIndex: number; amount: number; winners: { seat: number; amount: number }[]; handName: string | null }
  | { type: 'HAND_ENDED'; stacks: { seat: number; stack: number }[] };

export interface RoutedEvent { visibility: Visibility; event: HandEvent }

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface PlayerCommand {
  seat: number;
  type: ActionType;
  /** For bet/raise: the TOTAL street commitment after the action ("raise to"). */
  amount?: number;
}

export interface ActionOptions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (0 if check). */
  callAmount: number;
  canBet: boolean;
  canRaise: boolean;
  /** Minimum legal "to" amount for bet/raise (all-in for less is allowed separately). */
  minTo: number;
  /** Maximum "to" amount = all-in. */
  maxTo: number;
}

export interface HandResult {
  pots: Pot[];
  awards: { potIndex: number; winners: { seat: number; amount: number }[] }[];
  refunds: { seat: number; amount: number }[];
  /** Net chip change per seat for the hand. */
  deltas: { seat: number; playerId: string; delta: number; finalStack: number }[];
  wentToShowdown: boolean;
  shownSeats: number[];
}

export type Rejection = { ok: false; code: RejectCode; message: string };
export type RejectCode = 'HAND_OVER' | 'NOT_YOUR_TURN' | 'ILLEGAL_ACTION' | 'BAD_AMOUNT' | 'UNKNOWN_SEAT';
export type Applied = { ok: true; state: HandState; events: RoutedEvent[] };

const pub = (event: HandEvent): RoutedEvent => ({ visibility: { to: 'public' }, event });

// ---------------------------------------------------------------- helpers

function clone(s: HandState): HandState {
  return { ...s, players: s.players.map((p) => ({ ...p, hole: [...p.hole], holeDealIndices: [...p.holeDealIndices] })), board: [...s.board], boardDealIndices: [...s.boardDealIndices] };
}

function bySeat(s: HandState, seat: number): PlayerState | undefined {
  return s.players.find((p) => p.seat === seat);
}

/** Players in clockwise order starting with the first seat strictly after `fromSeat`. */
function clockwiseFrom(s: HandState, fromSeat: number): PlayerState[] {
  const sorted = s.players.slice().sort((a, b) => a.seat - b.seat);
  const after = sorted.filter((p) => p.seat > fromSeat);
  const before = sorted.filter((p) => p.seat <= fromSeat);
  return [...after, ...before];
}

function notFolded(s: HandState): PlayerState[] {
  return s.players.filter((p) => p.status !== 'folded');
}

function canStillAct(p: PlayerState): boolean {
  return p.status === 'active';
}

function commit(p: PlayerState, amount: number): number {
  const a = Math.min(amount, p.stack);
  p.stack -= a;
  p.streetCommitted += a;
  p.totalCommitted += a;
  if (p.stack === 0) p.status = 'allin';
  return a;
}

function dealCard(s: HandState): { card: Card; index: number } {
  const index = s.nextDealIndex++;
  const card = s.deck[index];
  if (card === undefined) throw new Error('deck exhausted');
  return { card, index };
}

// ---------------------------------------------------------------- start

export function startHand(handId: string, config: HandConfig, seats: readonly SeatInput[], buttonSeat: number, deck: readonly Card[]): Applied {
  validateConfig(config);
  const players = seats.filter((p) => p.stack > 0);
  if (players.length < 2) throw new Error('need at least two players with chips');
  if (new Set(players.map((p) => p.seat)).size !== players.length) throw new Error('duplicate seat');
  if (new Set(players.map((p) => p.playerId)).size !== players.length) throw new Error('duplicate player');
  for (const p of players) {
    if (!Number.isSafeInteger(p.stack) || p.stack < 0) throw new Error('invalid stack');
    if (p.seat < 0 || p.seat >= config.maxSeats) throw new Error('seat out of range');
  }
  if (!players.some((p) => p.seat === buttonSeat)) throw new Error('button must be on a dealt-in seat');
  if (deck.length !== 52 || new Set(deck).size !== 52) throw new Error('deck must contain 52 distinct cards');

  const s: HandState = {
    handId,
    config,
    street: 'preflop',
    buttonSeat,
    sbSeat: -1,
    bbSeat: -1,
    players: players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, startingStack: p.stack, streetCommitted: 0, totalCommitted: 0, status: 'active', acted: false, betLevelWhenActed: 0, hole: [], holeDealIndices: [] })),
    deck,
    nextDealIndex: 0,
    board: [],
    boardDealIndices: [],
    currentBet: 0,
    minRaise: config.bigBlind,
    lastAggressorSeat: null,
    toActSeat: null,
    seq: 0,
    allInRunout: false,
    result: null,
  };

  // Heads-up: the button posts the small blind and acts first pre-flop.
  const order = clockwiseFrom(s, buttonSeat);
  const sb = players.length === 2 ? bySeat(s, buttonSeat)! : order[0]!;
  const bb = players.length === 2 ? order[0]! : order[1]!;
  s.sbSeat = sb.seat;
  s.bbSeat = bb.seat;

  const events: RoutedEvent[] = [pub({ type: 'HAND_STARTED', handId, buttonSeat, sbSeat: sb.seat, bbSeat: bb.seat, players: s.players.map((p) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack })) })];

  if (config.ante > 0) {
    for (const p of s.players) {
      const a = Math.min(config.ante, p.stack);
      p.stack -= a;
      p.totalCommitted += a;
      if (p.stack === 0) p.status = 'allin';
      events.push(pub({ type: 'ANTE_POSTED', seat: p.seat, amount: a, stack: p.stack }));
    }
  }
  for (const [p, blind, amt] of [[sb, 'small', config.smallBlind], [bb, 'big', config.bigBlind]] as const) {
    if (p.status !== 'active') continue; // all-in from the ante
    const posted = commit(p, amt);
    events.push(pub({ type: 'BLIND_POSTED', seat: p.seat, blind, amount: posted, stack: p.stack, allIn: p.stack === 0 }));
  }
  // Players must call the full big blind even if the big blind is short.
  s.currentBet = config.bigBlind;
  s.minRaise = config.bigBlind;

  // Deal two hole cards, one at a time, starting left of the button.
  const dealOrderSeats = clockwiseFrom(s, buttonSeat);
  for (let round = 0; round < 2; round++) {
    for (const p of dealOrderSeats) {
      const { card, index } = dealCard(s);
      const target = bySeat(s, p.seat)!;
      target.hole.push(card);
      target.holeDealIndices.push(index);
    }
  }
  events.push(pub({ type: 'HOLE_CARDS_DEALT', seats: dealOrderSeats.map((p) => p.seat) }));
  for (const p of s.players) {
    events.push({ visibility: { to: 'seat', seat: p.seat }, event: { type: 'HOLE_CARDS', seat: p.seat, cards: [...p.hole], dealIndices: [...p.holeDealIndices] } });
  }

  return advance(s, events, nextActor(s, bb.seat));
}

function validateConfig(c: HandConfig): void {
  const ints = [c.smallBlind, c.bigBlind, c.ante, c.maxSeats];
  if (!ints.every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error('config values must be non-negative integers');
  if (c.bigBlind <= 0 || c.smallBlind <= 0 || c.smallBlind > c.bigBlind) throw new Error('invalid blinds');
  if (c.maxSeats < 2 || c.maxSeats > 9) throw new Error('maxSeats must be 2..9');
}

/** First player able to act, clockwise after `afterSeat`. */
function firstToAct(s: HandState, afterSeat: number): number | null {
  const p = clockwiseFrom(s, afterSeat).find(canStillAct);
  return p ? p.seat : null;
}

// ---------------------------------------------------------------- options

export function legalOptions(s: HandState, seat: number): ActionOptions | null {
  if (s.toActSeat !== seat || s.result) return null;
  const p = bySeat(s, seat);
  if (!p || p.status !== 'active') return null;
  const toCall = Math.max(0, s.currentBet - p.streetCommitted);
  const maxTo = p.streetCommitted + p.stack;
  const reopened = !p.acted || s.currentBet - p.betLevelWhenActed >= s.minRaise;
  // If every opponent is all-in or folded, nobody could respond to aggression: only call/check/fold.
  const othersCanRespond = s.players.some((o) => o.seat !== seat && o.status === 'active');
  const canBet = s.currentBet === 0 && p.stack > 0 && othersCanRespond;
  const canRaise = s.currentBet > 0 && maxTo > s.currentBet && reopened && othersCanRespond;
  const minTo = s.currentBet === 0 ? Math.min(s.config.bigBlind, maxTo) : Math.min(s.currentBet + s.minRaise, maxTo);
  return { canFold: true, canCheck: toCall === 0, callAmount: Math.min(toCall, p.stack), canBet, canRaise, minTo, maxTo };
}

// ---------------------------------------------------------------- apply

export function applyAction(state: HandState, cmd: PlayerCommand): Applied | Rejection {
  if (state.result || state.street === 'complete' || state.street === 'showdown') return reject('HAND_OVER', 'The hand is over.');
  const before = bySeat(state, cmd.seat);
  if (!before) return reject('UNKNOWN_SEAT', 'Seat is not in this hand.');
  if (state.toActSeat !== cmd.seat) return reject('NOT_YOUR_TURN', 'It is not your turn.');
  const opts = legalOptions(state, cmd.seat);
  if (!opts) return reject('NOT_YOUR_TURN', 'It is not your turn.');

  const s = clone(state);
  const p = bySeat(s, cmd.seat)!;
  const events: RoutedEvent[] = [];
  let type = cmd.type;
  let to = cmd.amount;

  // Normalise "allin" into the equivalent call/bet/raise.
  if (type === 'allin') {
    const maxTo = opts.maxTo;
    if (s.currentBet === 0) {
      if (!opts.canBet) return reject('ILLEGAL_ACTION', 'Betting is not allowed now.');
      type = 'bet';
    } else if (maxTo <= s.currentBet || !opts.canRaise) {
      type = 'call';
    } else type = 'raise';
    to = maxTo;
  }

  switch (type) {
    case 'fold':
      p.status = 'folded';
      break;
    case 'check':
      if (!opts.canCheck) return reject('ILLEGAL_ACTION', 'You cannot check; there is a bet to call.');
      break;
    case 'call': {
      if (opts.callAmount === 0) return reject('ILLEGAL_ACTION', 'Nothing to call; check instead.');
      commit(p, opts.callAmount);
      break;
    }
    case 'bet':
    case 'raise': {
      if (type === 'bet' && !opts.canBet) return reject('ILLEGAL_ACTION', s.currentBet > 0 ? 'There is already a bet; raise instead.' : 'Betting is not allowed now.');
      if (type === 'raise' && !opts.canRaise) return reject('ILLEGAL_ACTION', 'Raising is not allowed now.');
      if (to === undefined || !Number.isSafeInteger(to)) return reject('BAD_AMOUNT', 'A whole-number amount is required.');
      if (to > opts.maxTo) return reject('BAD_AMOUNT', 'Amount exceeds your stack.');
      const isAllIn = to === opts.maxTo;
      if (to < opts.minTo && !isAllIn) return reject('BAD_AMOUNT', `Minimum is ${opts.minTo}.`);
      if (to <= s.currentBet) return reject('BAD_AMOUNT', 'A raise must exceed the current bet.');
      const increment = to - s.currentBet;
      commit(p, to - p.streetCommitted);
      if (increment >= s.minRaise) {
        // Full bet/raise: becomes the new minimum raise increment and reopens action.
        s.minRaise = increment;
        s.lastAggressorSeat = p.seat;
      }
      // An incomplete all-in raise still raises the price but does not change minRaise.
      s.currentBet = to;
      break;
    }
    default:
      return reject('ILLEGAL_ACTION', 'Unknown action.');
  }

  p.acted = true;
  p.betLevelWhenActed = s.currentBet;
  s.seq++;
  events.push(pub({ type: 'PLAYER_ACTED', seat: p.seat, action: type, amount: p.streetCommitted, streetCommitted: p.streetCommitted, stack: p.stack, allIn: p.status === 'allin', currentBet: s.currentBet }));

  return advance(s, events, nextActor(s, p.seat));
}

/** Timeout policy: check if free, otherwise fold. */
export function timeoutAction(state: HandState): PlayerCommand | null {
  if (state.toActSeat === null) return null;
  const o = legalOptions(state, state.toActSeat);
  if (!o) return null;
  return { seat: state.toActSeat, type: o.canCheck ? 'check' : 'fold' };
}

function reject(code: RejectCode, message: string): Rejection {
  return { ok: false, code, message };
}

/** Next player who still needs to act this round, clockwise from `fromSeat`, or null if the round is closed. */
function nextActor(s: HandState, fromSeat: number): number | null {
  if (notFolded(s).length <= 1) return null;
  for (const p of clockwiseFrom(s, fromSeat)) {
    if (p.status !== 'active') continue;
    if (!p.acted || p.streetCommitted < s.currentBet) {
      // A lone active player who already matches the bet has nobody to play against.
      const othersActive = s.players.some((o) => o.seat !== p.seat && o.status === 'active');
      if (!othersActive && p.streetCommitted >= s.currentBet) return null;
      return p.seat;
    }
  }
  return null;
}

// ---------------------------------------------------------------- progression

function advance(s: HandState, events: RoutedEvent[], next: number | null): Applied {
  if (notFolded(s).length === 1) return finish(s, events, false);

  if (next !== null) {
    s.toActSeat = next;
    events.push(pub({ type: 'TURN', seat: next, options: legalOptions(s, next)! }));
    return { ok: true, state: s, events };
  }

  // Betting round closed.
  s.toActSeat = null;
  events.push(pub({ type: 'POTS_UPDATED', pots: computePots(contributions(s)).pots }));
  const canBetCount = s.players.filter((p) => p.status === 'active').length;
  if (canBetCount <= 1) {
    // Nobody (or only one player) can bet any more: run out the board and show down.
    s.allInRunout = s.street !== 'river';
    while (s.board.length < 5) dealStreet(s, events);
    return finish(s, events, true);
  }
  if (s.street === 'river') return finish(s, events, true);

  dealStreet(s, events);
  for (const p of s.players) {
    p.streetCommitted = 0;
    p.acted = false;
    p.betLevelWhenActed = 0;
  }
  s.currentBet = 0;
  s.minRaise = s.config.bigBlind;
  s.lastAggressorSeat = null;
  return advance(s, events, firstToAct(s, s.buttonSeat));
}

function dealStreet(s: HandState, events: RoutedEvent[]): void {
  const street: 'flop' | 'turn' | 'river' = s.board.length === 0 ? 'flop' : s.board.length === 3 ? 'turn' : 'river';
  dealCard(s); // burn card: consumed, never revealed
  const n = street === 'flop' ? 3 : 1;
  const cards: Card[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const { card, index } = dealCard(s);
    cards.push(card);
    idx.push(index);
  }
  s.board.push(...cards);
  s.boardDealIndices.push(...idx);
  s.street = street;
  events.push(pub({ type: 'STREET_DEALT', street, cards, dealIndices: idx, board: [...s.board] }));
}

function contributions(s: HandState) {
  return s.players.map((p) => ({ seat: p.seat, amount: p.totalCommitted, folded: p.status === 'folded' }));
}

function finish(s: HandState, events: RoutedEvent[], showdown: boolean): Applied {
  s.toActSeat = null;
  s.street = showdown ? 'showdown' : s.street;
  const { pots, refunds } = computePots(contributions(s));
  for (const r of refunds) {
    bySeat(s, r.seat)!.stack += r.amount;
    events.push(pub({ type: 'UNCALLED_RETURNED', seat: r.seat, amount: r.amount }));
  }

  const values = new Map<number, HandValue>();
  const shown = new Set<number>();
  if (showdown) {
    for (const p of notFolded(s)) values.set(p.seat, evaluate([...p.hole, ...s.board]));
    // Reveal policy: in an all-in runout every live hand is tabled. Otherwise, hands are shown in
    // showdown order (last aggressor first, else first left of the button) and a hand that cannot
    // beat or tie the best hand already shown for any pot it is eligible for is mucked.
    const live = notFolded(s);
    const startSeat = s.lastAggressorSeat !== null && live.some((p) => p.seat === s.lastAggressorSeat) ? s.lastAggressorSeat : null;
    const order = startSeat !== null ? [bySeat(s, startSeat)!, ...clockwiseFrom(s, startSeat).filter((p) => p.seat !== startSeat)] : clockwiseFrom(s, s.buttonSeat);
    const bestShownPerPot = pots.map(() => -1);
    for (const p of order) {
      if (p.status === 'folded') continue;
      const v = values.get(p.seat)!;
      let mustShow = s.allInRunout;
      pots.forEach((pot, i) => {
        if (pot.eligible.includes(p.seat) && v.score >= bestShownPerPot[i]!) mustShow = true;
      });
      if (mustShow) {
        shown.add(p.seat);
        pots.forEach((pot, i) => {
          if (pot.eligible.includes(p.seat)) bestShownPerPot[i] = Math.max(bestShownPerPot[i]!, v.score);
        });
      }
    }
    events.push(pub({
      type: 'SHOWDOWN',
      reveals: order.filter((p) => shown.has(p.seat)).map((p) => {
        const v = values.get(p.seat)!;
        return { seat: p.seat, cards: [...p.hole], dealIndices: [...p.holeDealIndices], hand: { name: v.name, score: v.score, ranks: v.ranks } };
      }),
    }));
  }

  const awards: HandResult['awards'] = [];
  pots.forEach((pot, potIndex) => {
    let winners: number[];
    let handName: string | null = null;
    if (!showdown) {
      winners = pot.eligible.length ? pot.eligible : notFolded(s).map((p) => p.seat);
    } else {
      const best = Math.max(...pot.eligible.map((seat) => values.get(seat)!.score));
      winners = pot.eligible.filter((seat) => values.get(seat)!.score === best);
      handName = values.get(winners[0]!)!.name;
    }
    const split = splitPot(pot.amount, winners, s.buttonSeat, s.config.maxSeats);
    const list = [...split.entries()].map(([seat, amount]) => ({ seat, amount }));
    for (const w of list) bySeat(s, w.seat)!.stack += w.amount;
    awards.push({ potIndex, winners: list });
    events.push(pub({ type: 'POT_AWARDED', potIndex, amount: pot.amount, winners: list, handName }));
  });

  s.street = 'complete';
  s.seq++;
  s.result = {
    pots,
    awards,
    refunds,
    deltas: s.players.map((p) => ({ seat: p.seat, playerId: p.playerId, delta: p.stack - p.startingStack, finalStack: p.stack })),
    wentToShowdown: showdown,
    shownSeats: [...shown].sort((a, b) => a - b),
  };
  events.push(pub({ type: 'HAND_ENDED', stacks: s.players.map((p) => ({ seat: p.seat, stack: p.stack })) }));
  return { ok: true, state: s, events };
}

// ---------------------------------------------------------------- invariants & projection

/** Chip conservation: total chips never change during a hand. */
export function totalChips(s: HandState): number {
  const behind = s.players.reduce((a, p) => a + p.stack, 0);
  if (s.result) return behind;
  return behind + s.players.reduce((a, p) => a + p.totalCommitted, 0);
}

export interface PublicPlayerView {
  seat: number;
  playerId: string;
  stack: number;
  streetCommitted: number;
  totalCommitted: number;
  status: PlayerStatus;
  /** Only present for the viewer's own seat, or for hands revealed at showdown. */
  hole: Card[] | null;
  holeCount: number;
}

export interface HandView {
  handId: string;
  street: Street;
  buttonSeat: number;
  sbSeat: number;
  bbSeat: number;
  board: Card[];
  currentBet: number;
  minRaise: number;
  toActSeat: number | null;
  seq: number;
  pots: Pot[];
  players: PublicPlayerView[];
  options: ActionOptions | null;
}

/**
 * Per-viewer projection. This is the ONLY way hand state is sent to clients.
 * A viewer sees their own hole cards; others' hole cards are visible only if shown at showdown.
 */
export function projectForViewer(s: HandState, viewerSeat: number | null): HandView {
  const shown = new Set(s.result?.shownSeats ?? []);
  return {
    handId: s.handId,
    street: s.street,
    buttonSeat: s.buttonSeat,
    sbSeat: s.sbSeat,
    bbSeat: s.bbSeat,
    board: [...s.board],
    currentBet: s.currentBet,
    minRaise: s.minRaise,
    toActSeat: s.toActSeat,
    seq: s.seq,
    pots: s.result ? s.result.pots : computePots(contributions(s)).pots,
    players: s.players.map((p) => ({
      seat: p.seat,
      playerId: p.playerId,
      stack: p.stack,
      streetCommitted: p.streetCommitted,
      totalCommitted: p.totalCommitted,
      status: p.status,
      hole: p.seat === viewerSeat || shown.has(p.seat) ? [...p.hole] : null,
      holeCount: p.hole.length,
    })),
    options: viewerSeat === null ? null : legalOptions(s, viewerSeat),
  };
}

/** Next button seat: the first seat clockwise after the previous button that will be dealt in. */
export function nextButtonSeat(previousButton: number | null, dealtSeats: readonly number[]): number {
  const sorted = [...dealtSeats].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('no seats');
  if (previousButton === null) return sorted[0]!;
  return sorted.find((x) => x > previousButton) ?? sorted[0]!;
}
