import { describe, expect, it } from 'vitest';
import { evaluate, HandCategory, orderedDeck, fisherYates, HmacDrbg, type Card } from '../src/index.js';

const ev = (s: string) => evaluate(s.split(' ') as Card[]);

/** Reference: brute force best of all 5-card subsets with a naive 5-card ranker. */
function naive5(cards: Card[]): number {
  return evaluate(cards).score;
}
function bruteBest(cards: Card[]): number {
  let best = -1;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
    best = Math.max(best, naive5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]));
  }
  return best;
}

describe('hand evaluator', () => {
  it.each([
    ['As Ks Qs Js Ts 2c 3d', HandCategory.StraightFlush],
    ['5h 4h 3h 2h Ah Kc Kd', HandCategory.StraightFlush],
    ['9c 9d 9h 9s 2c 3d 4h', HandCategory.Quads],
    ['Kc Kd Kh 2s 2c 3d 4h', HandCategory.FullHouse],
    ['Kc Kd Kh 2s 2c 2d 4h', HandCategory.FullHouse],
    ['Ac 9c 7c 4c 2c Kd Qh', HandCategory.Flush],
    ['Ac 2d 3h 4s 5c Kd Kh', HandCategory.Straight],
    ['Tc Jd Qh Ks Ac 2d 3h', HandCategory.Straight],
    ['7c 7d 7h As Kc 2d 3h', HandCategory.Trips],
    ['7c 7d 8h 8s Kc Kd 3h', HandCategory.TwoPair],
    ['7c 7d 8h 9s Kc 2d 3h', HandCategory.OnePair],
    ['Ac Jd 8h 6s 4c 3d 2h', HandCategory.HighCard],
  ])('%s → category %i', (hand, cat) => {
    expect(ev(hand).category).toBe(cat);
  });

  it('wheel is the lowest straight', () => {
    expect(ev('Ac 2d 3h 4s 5c 9d Jh').score).toBeLessThan(ev('2c 3d 4h 5s 6c 9d Jh').score);
    expect(ev('Ac 2d 3h 4s 5c 9d Jh').ranks).toEqual([5, 4, 3, 2, 1]);
  });

  it('kickers decide pairs', () => {
    expect(ev('Ac Ad Kh 7s 4c 3d 2h').score).toBeGreaterThan(ev('Ac Ad Qh 7s 4c 3d 2h').score);
  });

  it('two pair picks the best two pairs and best kicker from three pairs', () => {
    const v = ev('Ac Ad Kh Ks Qc Qd 2h');
    expect(v.category).toBe(HandCategory.TwoPair);
    expect(v.ranks).toEqual([14, 14, 13, 13, 12]);
  });

  it('flush uses top five suited cards with six suited', () => {
    expect(ev('Ah Kh 9h 7h 4h 2h Qc').ranks).toEqual([14, 13, 9, 7, 4]);
  });

  it('board plays → identical scores (tie)', () => {
    expect(ev('2c 3d Ah Kh Qh Jh Th').score).toBe(ev('4c 5d Ah Kh Qh Jh Th').score);
  });

  it('rejects duplicates and bad sizes', () => {
    expect(() => ev('Ac Ac 2d 3h 4s')).toThrow();
    expect(() => ev('Ac 2d 3h 4s')).toThrow();
  });

  it('7-card evaluation equals brute force over all 21 five-card subsets (20,000 random hands)', () => {
    const rng = new HmacDrbg(Buffer.alloc(32, 7));
    for (let i = 0; i < 20000; i++) {
      const hand = fisherYates(orderedDeck(), rng).slice(0, 7);
      expect(evaluate(hand).score).toBe(bruteBest(hand));
    }
  });

  it('category frequencies over all 2,598,960 five-card hands match combinatorics', () => {
    const deck = orderedDeck();
    const counts = new Array(9).fill(0);
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) for (let d = c + 1; d < 52; d++) for (let e = d + 1; e < 52; e++) {
      counts[evaluate([deck[a]!, deck[b]!, deck[c]!, deck[d]!, deck[e]!]).category]++;
    }
    expect(counts).toEqual([1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  }, 120_000);
});
