import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { SeatView } from '@noir/shared';
import { emit, getSocket } from '../../net/socket';
import { randomEntropy, verifyReveal, type Reveal } from '../../lib/fairness';
import { newId } from '../../lib/ui';

/**
 * Client table state. PRESENTATION ONLY: it mirrors authoritative server events and never decides
 * anything. Every action is a request the server validates; the UI just renders what comes back.
 */
export interface Options { canFold: boolean; canCheck: boolean; callAmount: number; canBet: boolean; canRaise: boolean; minTo: number; maxTo: number }
export interface PlayerV { seat: number; playerId: string; stack: number; streetCommitted: number; status: 'active' | 'folded' | 'allin'; hole: string[] | null; holeCount: number; lastAction?: string | undefined; handName?: string | undefined }
export interface Pot { amount: number; eligible: number[] }
export interface HandV {
  handId: string; handNo: number; street: string; buttonSeat: number; sbSeat: number; bbSeat: number; board: string[];
  currentBet: number; toActSeat: number | null; seq: number; pots: Pot[]; players: PlayerV[]; options: Options | null;
  deadline: number | null; fairness: { commitId: string; root: string; mix: string; contributions: { playerId: string; entropy: string }[] } | null;
  winners: { seat: number; amount: number; potIndex: number; handName: string | null }[]; ended: boolean;
}
export interface TableInfo { id: string; name: string; maxSeats: number; smallBlind: number; bigBlind: number; minBuyIn: number; maxBuyIn: number; actionSeconds: number; isPrivate: boolean; status: string }
export interface Cue { id: number; kind: 'shuffle' | 'deal' | 'board' | 'bet' | 'sweep' | 'reveal' | 'award' | 'end'; seats?: number[]; seat?: number; count?: number }

interface State { table: TableInfo | null; seats: SeatView[]; mySeat: number | null; hand: HandV | null; serverOffset: number; status: string }
type Act =
  | { t: 'snapshot'; s: any }
  | { t: 'seats'; seats: SeatView[]; myId: string }
  | { t: 'event'; e: any; myId: string }
  | { t: 'private'; e: any }
  | { t: 'status'; status: string };

function applyEvent(h: HandV | null, ev: any, meta: { handId: string; seq: number; deadline?: number }, mySeat: number | null): HandV | null {
  if (ev.type === 'HAND_STARTED') {
    return {
      handId: meta.handId, handNo: h?.handId === meta.handId ? h.handNo : (h?.handNo ?? 0) + 1, street: 'preflop', buttonSeat: ev.buttonSeat, sbSeat: ev.sbSeat, bbSeat: ev.bbSeat,
      board: [], currentBet: 0, toActSeat: null, seq: meta.seq, pots: [], options: null, deadline: null, fairness: h?.handId === meta.handId ? h.fairness : null, winners: [], ended: false,
      players: ev.players.map((p: any) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, streetCommitted: 0, status: 'active', hole: h?.handId === meta.handId ? h.players.find((x) => x.seat === p.seat)?.hole ?? null : null, holeCount: 0 })),
    };
  }
  if (!h || h.handId !== meta.handId) return h;
  const n: HandV = { ...h, seq: meta.seq, players: h.players.map((p) => ({ ...p })) };
  const P = (seat: number) => n.players.find((p) => p.seat === seat);
  switch (ev.type) {
    case 'ANTE_POSTED': { const p = P(ev.seat); if (p) { p.stack = ev.stack; if (ev.stack === 0) p.status = 'allin'; } break; }
    case 'BLIND_POSTED': { const p = P(ev.seat); if (p) { p.stack = ev.stack; p.streetCommitted = ev.amount; if (ev.allIn) p.status = 'allin'; } n.currentBet = Math.max(n.currentBet, ev.amount); break; }
    case 'HOLE_CARDS_DEALT': for (const s of ev.seats) { const p = P(s); if (p) p.holeCount = 2; } break;
    case 'PLAYER_ACTED': {
      const p = P(ev.seat);
      if (p) { p.stack = ev.stack; p.streetCommitted = ev.streetCommitted; p.lastAction = ev.allIn ? 'All-in' : ev.action[0].toUpperCase() + ev.action.slice(1); if (ev.action === 'fold') p.status = 'folded'; else if (ev.allIn) p.status = 'allin'; }
      n.currentBet = ev.currentBet; n.toActSeat = null; n.options = null; n.deadline = null;
      break;
    }
    case 'TURN': n.toActSeat = ev.seat; n.options = ev.seat === mySeat ? ev.options : null; n.deadline = meta.deadline ?? null; break;
    case 'STREET_DEALT': n.board = ev.board; n.street = ev.street; n.currentBet = 0; for (const p of n.players) { p.streetCommitted = 0; if (p.status !== 'folded') p.lastAction = undefined; } break;
    case 'POTS_UPDATED': n.pots = ev.pots; for (const p of n.players) p.streetCommitted = 0; break;
    case 'UNCALLED_RETURNED': { const p = P(ev.seat); if (p) { p.stack += ev.amount; p.streetCommitted = 0; } break; }
    case 'SHOWDOWN': n.street = 'showdown'; for (const r of ev.reveals) { const p = P(r.seat); if (p) { p.hole = r.cards; p.handName = r.hand.name; } } break;
    case 'POT_AWARDED': for (const w of ev.winners) { n.winners = [...n.winners, { ...w, potIndex: ev.potIndex, handName: ev.handName }]; } break;
    case 'HAND_ENDED': n.ended = true; n.street = 'complete'; n.toActSeat = null; n.options = null; n.deadline = null; for (const s of ev.stacks) { const p = P(s.seat); if (p) { p.stack = s.stack; p.streetCommitted = 0; } } break;
  }
  return n;
}

function reducer(s: State, a: Act): State {
  switch (a.t) {
    case 'snapshot': {
      const x = a.s;
      let hand: HandV | null = null;
      if (x.hand) {
        hand = {
          handId: x.hand.handId, handNo: x.hand.handNo, street: x.hand.street, buttonSeat: x.hand.buttonSeat, sbSeat: x.hand.sbSeat, bbSeat: x.hand.bbSeat, board: x.hand.board,
          currentBet: x.hand.currentBet, toActSeat: x.hand.toActSeat, seq: x.hand.seq, pots: x.hand.pots, options: x.hand.options, deadline: x.hand.deadline, fairness: x.hand.fairness,
          winners: [], ended: x.hand.street === 'complete',
          players: x.hand.players.map((p: any) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, streetCommitted: p.streetCommitted, status: p.status, hole: p.hole, holeCount: p.holeCount })),
        };
      }
      return { table: x.table, seats: x.seats, mySeat: x.mySeat, hand, serverOffset: x.serverTime - Date.now(), status: x.table.status };
    }
    case 'seats': {
      const mine = a.seats.find((x) => x.userId === a.myId);
      return { ...s, seats: a.seats, mySeat: mine ? mine.seat : null };
    }
    case 'event': {
      const myHandSeat = s.hand?.players.find((p) => p.playerId === a.myId)?.seat ?? (a.e.event.type === 'HAND_STARTED' ? a.e.event.players.find((p: any) => p.playerId === a.myId)?.seat ?? null : null);
      return { ...s, hand: applyEvent(s.hand, a.e.event, { handId: a.e.handId, seq: a.e.seq, deadline: a.e.deadline }, myHandSeat) };
    }
    case 'private': {
      if (!s.hand || s.hand.handId !== a.e.handId) {
        // Private cards can race the HAND_STARTED event on reconnect; keep them on a placeholder hand.
        return s;
      }
      return { ...s, hand: { ...s.hand, players: s.hand.players.map((p) => (p.seat === a.e.event.seat ? { ...p, hole: a.e.event.cards } : p)) } };
    }
    case 'status':
      return { ...s, status: a.status, table: s.table ? { ...s.table, status: a.status } : s.table };
  }
}

export type VerifyState = Record<string, 'pending' | 'ok' | 'fail'>;

export function useTable(tableId: string, myId: string, accessCode: string | null) {
  const [state, dispatch] = useReducer(reducer, { table: null, seats: [], mySeat: null, hand: null, serverOffset: 0, status: 'open' });
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [verify, setVerify] = useState<VerifyState>({});
  const [gifts, setGifts] = useState<{ id: string; toUserId: string; item: string; fromName: string }[]>([]);
  // Commitment info per hand, kept outside the reducer so it survives the HAND_STARTED/handStarted ordering race.
  const [fairnessByHand, setFairnessByHand] = useState<Record<string, NonNullable<HandV['fairness']>>>({});
  const [entropyIncluded, setEntropyIncluded] = useState<Record<string, boolean>>({});
  const stateRef = useRef(state);
  stateRef.current = state;
  const fairnessRef = useRef<Record<string, HandV['fairness']>>({});
  const pendingReveals = useRef<Record<string, Reveal[]>>({});
  const cueId = useRef(0);

  const cue = useCallback((c: Omit<Cue, 'id'>) => setCues((x) => [...x.slice(-20), { ...c, id: ++cueId.current }]), []);

  const checkReveals = useCallback((handId: string, reveals: Reveal[]) => {
    const f = fairnessRef.current[handId];
    if (!f) { (pendingReveals.current[handId] ??= []).push(...reveals); return; }
    for (const r of reveals) {
      setVerify((v) => ({ ...v, [r.card]: 'pending' }));
      void verifyReveal(f.commitId, f.root, f.mix, r).then((ok) => setVerify((v) => ({ ...v, [r.card]: ok ? 'ok' : 'fail' })));
    }
  }, []);

  const watch = useCallback(async () => {
    const a = await emit<any>('table:watch', { tableId, ...(accessCode ? { accessCode } : {}) });
    if (!a.ok) { setError({ code: a.code ?? 'ERROR', message: a.error }); return; }
    setError(null);
    dispatch({ t: 'snapshot', s: a.data });
    if (a.data.hand?.fairness) {
      fairnessRef.current[a.data.hand.handId] = a.data.hand.fairness;
      setFairnessByHand((x) => ({ ...x, [a.data.hand.handId]: a.data.hand.fairness }));
      setVerify({});
      checkReveals(a.data.hand.handId, a.data.hand.reveals ?? []);
    }
    const nc = a.data.nextCommitment;
    if (nc && a.data.mySeat !== null && !nc.contributed) void contribute(nc.handId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, accessCode, checkReveals]);

  const contribute = useCallback(async (commitId: string) => {
    const r = await emit<{ included: boolean }>('table:entropy', { tableId, commitId, entropy: randomEntropy() });
    if (r.ok) setEntropyIncluded((x) => ({ ...x, [commitId]: true }));
  }, [tableId]);

  useEffect(() => {
    const s = getSocket();
    const mine = (e: { tableId?: string }) => e.tableId === tableId;
    const onEvent = (e: any) => {
      if (!mine(e)) return;
      dispatch({ t: 'event', e, myId });
      const ev = e.event;
      if (ev.type === 'HAND_STARTED') { cue({ kind: 'shuffle' }); setVerify({}); }
      if (ev.type === 'HOLE_CARDS_DEALT') cue({ kind: 'deal', seats: ev.seats });
      if (ev.type === 'STREET_DEALT') { cue({ kind: 'board', count: ev.cards.length }); if (e.reveals) checkReveals(e.handId, e.reveals); }
      if (ev.type === 'PLAYER_ACTED' && ['call', 'bet', 'raise'].includes(ev.action)) cue({ kind: 'bet', seat: ev.seat });
      if (ev.type === 'POTS_UPDATED') cue({ kind: 'sweep' });
      if (ev.type === 'SHOWDOWN') { cue({ kind: 'reveal' }); if (e.reveals) checkReveals(e.handId, e.reveals); }
      if (ev.type === 'POT_AWARDED') cue({ kind: 'award', seats: ev.winners.map((w: any) => w.seat) });
      if (ev.type === 'HAND_ENDED') cue({ kind: 'end' });
    };
    const onPrivate = (e: any) => {
      if (!mine(e)) return;
      dispatch({ t: 'private', e });
      checkReveals(e.handId, e.reveals);
    };
    const onStarted = (e: any) => {
      if (!mine(e)) return;
      fairnessRef.current[e.handId] = e.fairness;
      setFairnessByHand((x) => ({ ...Object.fromEntries(Object.entries(x).slice(-3)), [e.handId]: e.fairness }));
      const pend = pendingReveals.current[e.handId];
      if (pend) { delete pendingReveals.current[e.handId]; checkReveals(e.handId, pend); }
    };
    const onSeats = (e: any) => mine(e) && dispatch({ t: 'seats', seats: e.seats, myId });
    const onCommit = (e: any) => { if (mine(e) && stateRef.current.mySeat !== null) void contribute(e.handId); };
    const onStatus = (e: any) => mine(e) && dispatch({ t: 'status', status: e.status });
    const onSnapshot = (x: any) => x.table?.id === tableId && dispatch({ t: 'snapshot', s: x });
    const onGift = (g: any) => { if (!mine(g)) return; setGifts((x) => [...x, { id: g.giftId, toUserId: g.toUserId, item: g.item, fromName: g.fromName }]); setTimeout(() => setGifts((x) => x.filter((y) => y.id !== g.giftId)), 3200); };
    s.on('table:event', onEvent);
    s.on('table:private', onPrivate);
    s.on('table:handStarted', onStarted);
    s.on('table:seats', onSeats);
    s.on('table:commitment', onCommit);
    s.on('table:status', onStatus);
    s.on('table:snapshot', onSnapshot);
    s.on('table:gift', onGift);
    // Reconnect = full resync from a fresh per-viewer snapshot.
    s.on('connect', watch);
    void watch();
    return () => {
      s.off('table:event', onEvent); s.off('table:private', onPrivate); s.off('table:handStarted', onStarted); s.off('table:seats', onSeats);
      s.off('table:commitment', onCommit); s.off('table:status', onStatus); s.off('table:snapshot', onSnapshot); s.off('table:gift', onGift); s.off('connect', watch);
      void emit('table:unwatch', { tableId });
    };
  }, [tableId, myId, watch, cue, checkReveals, contribute]);

  const act = useCallback(async (type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin', amount?: number) => {
    const h = stateRef.current.hand;
    if (!h) return { ok: false as const, error: 'No hand in progress.' };
    return emit('table:action', { tableId, handId: h.handId, actionId: newId(), expectedSeq: h.seq, type, ...(amount !== undefined ? { amount } : {}) });
  }, [tableId]);

  return {
    ...state, hand: state.hand && !state.hand.fairness && fairnessByHand[state.hand.handId] ? { ...state.hand, fairness: fairnessByHand[state.hand.handId]! } : state.hand,
    error, cues, verify, gifts, entropyIncluded, act, reload: watch,
    sit: (seat: number, buyIn: number) => emit<any>('table:sit', { tableId, seat, buyIn, ...(accessCode ? { accessCode } : {}) }).then((a) => { if (a.ok) dispatch({ t: 'snapshot', s: a.data }); return a; }),
    leave: () => emit('table:leave', { tableId }),
    sitOut: (sitOut: boolean) => emit('table:sitout', { tableId, sitOut }),
    rebuy: (amount: number) => emit('table:rebuy', { tableId, amount }),
  };
}
