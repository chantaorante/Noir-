import { describe, expect, it } from 'vitest';
import { computePots, splitPot, totalChips } from '../src/index.js';
import { cfg, rigDeck, seats, Table } from './helpers.js';

describe('computePots', () => {
  it('returns an uncalled top slice to its owner', () => {
    const r = computePots([{ seat: 0, amount: 1000, folded: false }, { seat: 1, amount: 300, folded: false }]);
    expect(r.pots).toEqual([{ amount: 600, eligible: [0, 1] }]);
    expect(r.refunds).toEqual([{ seat: 0, amount: 700 }]);
  });
  it('folded money stays in the pot but folded seats are not eligible', () => {
    const r = computePots([{ seat: 0, amount: 200, folded: true }, { seat: 1, amount: 100, folded: false }, { seat: 2, amount: 100, folded: false }]);
    expect(r.pots).toEqual([{ amount: 400, eligible: [1, 2] }]);
    expect(r.refunds).toEqual([]);
  });
  it('builds three side pots from five players', () => {
    const r = computePots([
      { seat: 0, amount: 50, folded: false }, { seat: 1, amount: 150, folded: false }, { seat: 2, amount: 400, folded: false },
      { seat: 3, amount: 400, folded: false }, { seat: 4, amount: 100, folded: true },
    ]);
    expect(r.pots).toEqual([
      { amount: 250, eligible: [0, 1, 2, 3] },
      { amount: 350, eligible: [1, 2, 3] },
      { amount: 500, eligible: [2, 3] },
    ]);
  });
  it('splitPot distributes all chips, remainder clockwise from the button', () => {
    const m = splitPot(101, [3, 5, 8], 4, 9);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(101);
    expect(m.get(5)).toBe(34); // first left of button 4
    expect(m.get(8)).toBe(34);
    expect(m.get(3)).toBe(33);
  });
});

describe('integration: raise, re-raise, fold returns uncalled chips', () => {
  it('re-raiser gets uncalled portion back', () => {
    const t = new Table(cfg(), seats(1000, 1000, 1000), 0, rigDeck([['Ah', 'Ad'], ['Kh', 'Kd'], ['Qh', 'Qd']], ['2c', '7d', '9h', 'Js', '3c']));
    t.act(0, 'raise', 30).act(1, 'raise', 100).act(2, 'fold').act(0, 'fold');
    expect(t.stack(1)).toBe(1000 + 30 + 10);
    expect(t.events('UNCALLED_RETURNED')[0]).toMatchObject({ seat: 1, amount: 70 });
    expect(totalChips(t.state)).toBe(3000);
  });
  it('9-handed full hand completes with correct positions', () => {
    const holes: [string, string][] = [['2h', '3h'], ['4h', '5h'], ['6h', '7h'], ['8h', '9h'], ['Th', 'Jh'], ['2d', '3d'], ['4d', '5d'], ['6d', '7d'], ['8d', '9d']];
    const t = new Table(cfg(), seats(...Array(9).fill(500)), 4, rigDeck(holes, ['As', 'Ks', 'Qs', '2c', '3c']));
    expect(t.state.sbSeat).toBe(5);
    expect(t.state.bbSeat).toBe(6);
    expect(t.state.toActSeat).toBe(7);
    for (const s of [7, 8, 0, 1, 2, 3, 4, 5]) t.act(s, 'call');
    t.act(6, 'check');
    expect(t.state.street).toBe('flop');
    expect(t.state.toActSeat).toBe(5);
  });
});
