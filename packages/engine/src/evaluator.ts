import { rankOf, suitOf, type Card } from './cards.js';

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

export const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.OnePair]: 'One Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.Trips]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.Quads]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
};

export interface HandValue {
  /** Totally ordered: higher wins, equal ties. */
  score: number;
  category: HandCategory;
  /** The five ranks that define the hand, most significant first (ace-low straight uses 5 high). */
  ranks: number[];
  name: string;
}

function encode(category: HandCategory, ranks: number[]): number {
  let s = category;
  for (let i = 0; i < 5; i++) s = s * 16 + (ranks[i] ?? 0);
  return s;
}

/** Highest straight top rank among a set of distinct ranks, or 0. Handles the wheel (A-2-3-4-5). */
function straightHigh(rankSet: Set<number>): number {
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let r = high; r > high - 5; r--) {
      const rr = r === 1 ? 14 : r;
      if (!rankSet.has(rr)) { ok = false; break; }
    }
    if (ok) return high;
  }
  // wheel: 5-4-3-2-A
  if ([14, 2, 3, 4, 5].every((r) => rankSet.has(r))) return 5;
  return 0;
}

function straightRanks(high: number): number[] {
  return high === 5 ? [5, 4, 3, 2, 1] : [high, high - 1, high - 2, high - 3, high - 4];
}

/** Evaluate the best 5-card hand from 5 to 7 cards. */
export function evaluate(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new Error('evaluate needs 5..7 cards');
  if (new Set(cards).size !== cards.length) throw new Error('duplicate cards');

  const counts = new Map<number, number>();
  const bySuit = new Map<string, number[]>();
  for (const c of cards) {
    const r = rankOf(c);
    counts.set(r, (counts.get(r) ?? 0) + 1);
    const s = suitOf(c);
    const list = bySuit.get(s) ?? [];
    list.push(r);
    bySuit.set(s, list);
  }

  // Straight flush / flush
  let flushRanks: number[] | null = null;
  for (const list of bySuit.values()) {
    if (list.length >= 5) flushRanks = list.slice().sort((a, b) => b - a);
  }
  if (flushRanks) {
    const sfHigh = straightHigh(new Set(flushRanks));
    if (sfHigh) return make(HandCategory.StraightFlush, straightRanks(sfHigh));
  }

  // Group ranks by multiplicity, ordered by (count desc, rank desc)
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const desc = [...counts.keys()].sort((a, b) => b - a);
  const top = groups[0]!;

  if (top[1] === 4) {
    const kicker = desc.find((r) => r !== top[0])!;
    return make(HandCategory.Quads, [top[0], top[0], top[0], top[0], kicker]);
  }

  const trips = groups.filter((g) => g[1] === 3).map((g) => g[0]);
  const pairs = groups.filter((g) => g[1] === 2).map((g) => g[0]);
  if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
    const t = trips[0]!;
    const p = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return make(HandCategory.FullHouse, [t, t, t, p, p]);
  }

  if (flushRanks) return make(HandCategory.Flush, flushRanks.slice(0, 5));

  const sHigh = straightHigh(new Set(desc));
  if (sHigh) return make(HandCategory.Straight, straightRanks(sHigh));

  if (trips.length === 1) {
    const t = trips[0]!;
    const kick = desc.filter((r) => r !== t).slice(0, 2);
    return make(HandCategory.Trips, [t, t, t, ...kick]);
  }
  if (pairs.length >= 2) {
    const [p1, p2] = [pairs[0]!, pairs[1]!];
    const kicker = desc.find((r) => r !== p1 && r !== p2)!;
    return make(HandCategory.TwoPair, [p1, p1, p2, p2, kicker]);
  }
  if (pairs.length === 1) {
    const p = pairs[0]!;
    const kick = desc.filter((r) => r !== p).slice(0, 3);
    return make(HandCategory.OnePair, [p, p, ...kick]);
  }
  return make(HandCategory.HighCard, desc.slice(0, 5));
}

function make(category: HandCategory, ranks: number[]): HandValue {
  return { score: encode(category, ranks), category, ranks, name: CATEGORY_NAMES[category] };
}
