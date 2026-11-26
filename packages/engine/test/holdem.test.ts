import { describe, expect, it } from 'vitest';
import { totalChips, projectForViewer, timeoutAction, nextButtonSeat, startHand, applyAction, fisherYates, orderedDeck, HmacDrbg, legalOptions } from '../src/index.js';
import { cfg, rigDeck, seats, Table } from './helpers.js';

const ANY_BOARD = ['2c', '7d', '9h', 'Js', '3c'];

describe('blinds, positions and action order', () => {
  it('3-handed: SB and BB left of button, UTG acts first preflop, SB first postflop', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    expect(t.state.sbSeat).toBe(1);
    expect(t.state.bbSeat).toBe(2);
    expect(t.state.toActSeat).toBe(0);
    expect(t.stack(1)).toBe(995);
    expect(t.stack(2)).toBe(990);
    t.act(0, 'call').act(1, 'call');
    expect(t.state.toActSeat).toBe(2); // big blind option
    t.act(2, 'check');
    expect(t.state.street).toBe('flop');
    expect(t.state.toActSeat).toBe(1);
  });

  it('heads-up: button posts SB and acts first preflop, last postflop', () => {
    const t = new Table(cfg(), seats(1000, 1000), 0, rigDeck([['Kh', 'Kd'], ['Ah', 'Ad']], ANY_BOARD));
    expect(t.state.sbSeat).toBe(0);
    expect(t.state.bbSeat).toBe(1);
    expect(t.state.toActSeat).toBe(0);
    t.act(0, 'call').act(1, 'check');
    expect(t.state.street).toBe('flop');
    expect(t.state.toActSeat).toBe(1);
  });

  it('hole cards are dealt one at a time starting left of the button', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    // deal order seat1, seat2, seat0
    expect(t.state.players.find((p) => p.seat === 1)!.hole).toEqual(['Ah', 'Ad']);
    expect(t.state.players.find((p) => p.seat === 0)!.hole).toEqual(['Qh', 'Qd']);
    expect(t.state.players.find((p) => p.seat === 1)!.holeDealIndices).toEqual([0, 3]);
  });

  it('button rotation skips empty seats and wraps', () => {
    expect(nextButtonSeat(null, [2, 5, 7])).toBe(2);
    expect(nextButtonSeat(2, [2, 5, 7])).toBe(5);
    expect(nextButtonSeat(7, [2, 5, 7])).toBe(2);
    expect(nextButtonSeat(3, [2, 5, 7])).toBe(5);
  });

  it('antes are dead money', () => {
    const t = new Table(cfg({ ante: 2 }), seats(100, 100, 100), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    expect(t.stack(0)).toBe(98);
    expect(t.stack(1)).toBe(93);
    t.act(0, 'fold').act(1, 'fold');
    expect(t.stack(2)).toBe(100 + 2 + 2 + 5);
  });
});

describe('betting validation', () => {
  const mk = () => new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));

  it('rejects out-of-turn actions', () => {
    const t = mk();
    const r = t.try(1, 'call');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_YOUR_TURN');
  });

  it('rejects check when facing a bet, call when nothing to call', () => {
    const t = mk();
    expect(t.try(0, 'check').ok).toBe(false);
    t.act(0, 'call').act(1, 'call');
    expect(t.try(2, 'call').ok).toBe(false);
  });

  it('enforces the minimum raise and stack limits', () => {
    const t = mk();
    expect(t.try(0, 'raise', 15).ok).toBe(false); // min raise to 20
    expect(t.try(0, 'raise', 1001).ok).toBe(false);
    expect(t.try(0, 'raise', 20.5).ok).toBe(false);
    expect(t.try(0, 'bet', 30).ok).toBe(false); // there is already a bet (BB)
    t.act(0, 'raise', 30); // raise of 20
    expect(legalOptions(t.state, 1)!.minTo).toBe(50);
    expect(t.try(1, 'raise', 49).ok).toBe(false);
    t.act(1, 'raise', 50);
  });

  it('postflop minimum bet is one big blind', () => {
    const t = mk();
    t.act(0, 'call').act(1, 'call').act(2, 'check');
    expect(t.try(1, 'bet', 5).ok).toBe(false);
    t.act(1, 'bet', 10);
  });

  it('stale/duplicate action is rejected because the turn has moved', () => {
    const t = mk();
    t.act(0, 'call');
    expect(t.try(0, 'call').ok).toBe(false);
  });

  it('incomplete all-in raise does not reopen betting for players who already acted', () => {
    // seat0 button, seat1 SB, seat2 BB. Postflop: seat1 bets 100, seat2 shoves 130 (incomplete), seat0 calls; seat1 may only call/fold.
    const t = new Table(cfg(), [{ seat: 0, playerId: 'a', stack: 1000 }, { seat: 1, playerId: 'b', stack: 1000 }, { seat: 2, playerId: 'c', stack: 140 }], 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    t.act(0, 'call').act(1, 'call').act(2, 'check');
    t.act(1, 'bet', 100);
    t.act(2, 'allin'); // to 130: increment 30 < 100
    expect(t.state.currentBet).toBe(130);
    const o0 = legalOptions(t.state, 0)!;
    expect(o0.canRaise).toBe(true); // seat0 has not acted this round
    t.act(0, 'call');
    const o1 = legalOptions(t.state, 1)!;
    expect(o1.canRaise).toBe(false);
    expect(o1.callAmount).toBe(30);
    expect(t.try(1, 'raise', 400).ok).toBe(false);
    t.act(1, 'call');
    expect(t.state.street).toBe('turn');
  });

  it('a full raise after an incomplete one reopens action', () => {
    const t = new Table(cfg(), [{ seat: 0, playerId: 'a', stack: 1000 }, { seat: 1, playerId: 'b', stack: 1000 }, { seat: 2, playerId: 'c', stack: 140 }, { seat: 3, playerId: 'd', stack: 1000 }], 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd'], ['Jh', 'Jd']], ANY_BOARD));
    // preflop limp around
    t.act(3, 'call').act(0, 'call').act(1, 'call').act(2, 'check');
    t.act(1, 'bet', 100).act(2, 'allin').act(3, 'raise', 300).act(0, 'fold');
    expect(legalOptions(t.state, 1)!.canRaise).toBe(true);
  });
});

describe('pots, all-ins and showdown', () => {
  it('fold to a bet awards the pot without showdown and keeps cards hidden', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    t.act(0, 'raise', 40).act(1, 'fold').act(2, 'fold');
    expect(t.stack(0)).toBe(1015);
    expect(t.state.result!.wentToShowdown).toBe(false);
    expect(t.events('SHOWDOWN')).toHaveLength(0);
    expect(t.events('UNCALLED_RETURNED')[0]).toMatchObject({ seat: 0, amount: 30 });
  });

  it('best hand wins at showdown', () => {
    // deal order: seat1, seat2, seat0
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    t.act(0, 'call').act(1, 'call').act(2, 'check');
    for (let i = 0; i < 3; i++) t.act(1, 'check').act(2, 'check').act(0, 'check');
    expect(t.state.street).toBe('complete');
    expect(t.stack(1)).toBe(1020);
    expect(t.stack(0)).toBe(990);
  });

  it('three side pots with four different all-in stacks are built and awarded correctly', () => {
    // seats: 0 BTN(1000), 1 SB(100), 2 BB(300), 3 UTG(600). deal order 1,2,3,0
    // Hands: seat1 AA (best), seat2 KK, seat3 QQ, seat0 JJ. Board blank.
    const t = new Table(cfg(), seats(1000, 100, 300, 600), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd'], ['Jh', 'Jd']], ['2c', '7d', '9s', '3c', '4d']));
    t.act(3, 'allin').act(0, 'call').act(1, 'allin').act(2, 'allin');
    expect(t.state.street).toBe('complete');
    const awards = t.events('POT_AWARDED');
    // main 100*4 → seat1, side1 (300-100)*3 → seat2, side2 (600-300)*2 → seat3 (QQ beats JJ)
    expect(awards.map((a: any) => [a.amount, a.winners.map((w: any) => w.seat)])).toEqual([[400, [1]], [600, [2]], [600, [3]]]);
    expect(t.events('UNCALLED_RETURNED')).toHaveLength(0);
    expect(t.stack(1)).toBe(400);
    expect(t.stack(2)).toBe(600);
    expect(t.stack(3)).toBe(600);
    expect(t.stack(0)).toBe(400);
    expect(totalChips(t.state)).toBe(2000);
    // all-in runout: every live hand is tabled
    expect(t.events('SHOWDOWN')[0].reveals.map((r: any) => r.seat).sort()).toEqual([0, 1, 2, 3]);
  });

  it('split pot with an odd chip goes to the first winner left of the button', () => {
    // Board is a royal flush: everyone ties. 3 players, pot 5+10+10 = 25 → 8,8,9? Use blinds 5/10: limp: 30 total.
    const t = new Table(cfg({ smallBlind: 5, bigBlind: 10 }), seats(1000, 1000, 1000), 0, rigDeck([['2h', '3d'], ['2d', '3h'], ['4c', '5d']], ['As', 'Ks', 'Qs', 'Js', 'Ts']));
    // seat0 folds after posting nothing; SB completes? Make an odd pot: seat0 calls 10, seat1 folds (5 dead), seat2 checks → pot 25 between seat0 & seat2
    t.act(0, 'call').act(1, 'fold').act(2, 'check');
    for (let i = 0; i < 3; i++) t.act(2, 'check').act(0, 'check');
    const award = t.events('POT_AWARDED')[0];
    expect(award.amount).toBe(25);
    // left of button (seat0) is seat1 (folded), then seat2 → seat2 gets the odd chip
    expect(award.winners).toEqual(expect.arrayContaining([{ seat: 2, amount: 13 }, { seat: 0, amount: 12 }]));
  });

  it('short all-in big blind: others still owe the full big blind', () => {
    const t = new Table(cfg(), seats(1000, 1000, 4), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    expect(t.state.players.find((p) => p.seat === 2)!.status).toBe('allin');
    expect(legalOptions(t.state, 0)!.callAmount).toBe(10);
    t.act(0, 'call').act(1, 'call');
    // BB is all-in; seats 0 and 1 continue betting on later streets
    expect(t.state.street).toBe('flop');
  });

  it('heads-up SB all-in posting the blind runs out immediately', () => {
    const t = new Table(cfg(), seats(3, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd']], ANY_BOARD));
    expect(t.state.street).toBe('complete');
    expect(totalChips(t.state)).toBe(1003);
  });

  it('losing hand is mucked (not revealed) when there was no all-in', () => {
    const DRY = ['8c', 'Td', 'Kh', '4s', '6d'];
    const t = new Table(cfg(), seats(1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['2s', '7c']], DRY));
    // deal order: seat1 then seat0 → seat1 AA, seat0 27o
    t.act(0, 'call').act(1, 'check');
    t.act(1, 'bet', 20).act(0, 'call');
    t.act(1, 'check').act(0, 'check');
    t.act(1, 'check').act(0, 'bet', 10).act(1, 'call');
    // seat0 was last aggressor on the river and shows first; seat1 must show (beats it); seat0 shown since first.
    const reveals = t.events('SHOWDOWN')[0].reveals.map((r: any) => r.seat);
    expect(reveals).toEqual([0, 1]);
    // Reverse: last aggressor is the winner → loser may muck
    const u = new Table(cfg(), seats(1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['2s', '7c']], DRY));
    u.act(0, 'call').act(1, 'check');
    for (let i = 0; i < 2; i++) u.act(1, 'check').act(0, 'check');
    u.act(1, 'bet', 10).act(0, 'call');
    expect(u.events('SHOWDOWN')[0].reveals.map((r: any) => r.seat)).toEqual([1]);
    expect(projectForViewer(u.state, null).players.find((p) => p.seat === 0)!.hole).toBeNull();
  });
});

describe('privacy projection', () => {
  it('a viewer only sees their own hole cards during the hand', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    const v = projectForViewer(t.state, 1);
    expect(v.players.find((p) => p.seat === 1)!.hole).toEqual(['Ah', 'Ad']);
    expect(v.players.find((p) => p.seat === 0)!.hole).toBeNull();
    expect(v.players.find((p) => p.seat === 2)!.hole).toBeNull();
    const spectator = projectForViewer(t.state, null);
    expect(spectator.players.every((p) => p.hole === null)).toBe(true);
    expect(JSON.stringify(spectator)).not.toMatch(/"(Ah|Ad|Kh|Kd|Qh|Qd)"/);
  });

  it('private hole-card events are routed only to the owning seat', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    const publicBlob = JSON.stringify(t.log.filter((e) => e.visibility.to === 'public'));
    expect(publicBlob).not.toMatch(/"(Ah|Ad|Kh|Kd|Qh|Qd)"/);
    const priv = t.log.filter((e) => e.visibility.to === 'seat');
    expect(priv).toHaveLength(3);
    for (const e of priv) expect((e.visibility as any).seat).toBe((e.event as any).seat);
  });
});

describe('timeouts', () => {
  it('times out to check when free and fold when facing a bet', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ANY_BOARD));
    expect(timeoutAction(t.state)).toEqual({ seat: 0, type: 'fold' });
    t.act(0, 'call').act(1, 'call');
    expect(timeoutAction(t.state)).toEqual({ seat: 2, type: 'check' });
  });
});

describe('property: random play conserves chips and always terminates', () => {
  it('10,000 random hands with 2–9 players and random stacks', () => {
    const rng = new HmacDrbg(Buffer.alloc(32, 42));
    const types = ['fold', 'check', 'call', 'bet', 'raise', 'allin'] as const;
    for (let h = 0; h < 10_000; h++) {
      const n = 2 + rng.int(8);
      const stacks = Array.from({ length: n }, () => 1 + rng.int(2000));
      const players = stacks.map((stack, i) => ({ seat: i, playerId: `p${i}`, stack }));
      const total = stacks.reduce((a, b) => a + b, 0);
      const deck = fisherYates(orderedDeck(), rng);
      let r = startHand(`h${h}`, cfg({ ante: rng.int(3) }), players, rng.int(n), deck);
      let state = r.state;
      let guard = 0;
      while (state.street !== 'complete') {
        if (++guard > 500) throw new Error('hand did not terminate');
        const seat = state.toActSeat!;
        expect(seat).not.toBeNull();
        const o = legalOptions(state, seat)!;
        const t = types[rng.int(types.length)]!;
        let amount: number | undefined;
        if (t === 'bet' || t === 'raise') amount = o.minTo + rng.int(Math.max(1, o.maxTo - o.minTo + 1));
        const res = applyAction(state, { seat, type: t, ...(amount !== undefined ? { amount } : {}) });
        if (!res.ok) continue; // illegal random choice: rejected without state change
        state = res.state;
        expect(totalChips(state)).toBe(total);
        for (const p of state.players) expect(p.stack).toBeGreaterThanOrEqual(0);
      }
      expect(state.players.reduce((a, p) => a + p.stack, 0)).toBe(total);
      expect(state.result!.deltas.reduce((a, d) => a + d.delta, 0)).toBe(0);
    }
  }, 120_000);
});
