export interface Contribution {
  seat: number;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that can win this pot (not folded, contributed to its level). */
  eligible: number[];
}

export interface PotResult {
  pots: Pot[];
  /** Uncalled chips returned to a seat (at most one seat). */
  refunds: { seat: number; amount: number }[];
}

/**
 * Split total contributions into a main pot and side pots.
 * - Each distinct contribution level forms a slice.
 * - A slice contested by a single contributor who has not folded is an uncalled bet → refunded.
 * - A slice with no eligible seat (only folded money) is merged into the previous pot.
 * - Consecutive slices with identical eligible sets are merged.
 */
export function computePots(contribs: readonly Contribution[]): PotResult {
  const active = contribs.filter((c) => c.amount > 0);
  const levels = [...new Set(active.map((c) => c.amount))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  const refunds: { seat: number; amount: number }[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    const contributors: Contribution[] = [];
    for (const c of active) {
      const part = Math.min(c.amount, level) - Math.min(c.amount, prev);
      if (part > 0) {
        amount += part;
        contributors.push(c);
      }
    }
    const eligible = contributors.filter((c) => !c.folded).map((c) => c.seat).sort((a, b) => a - b);
    prev = level;
    if (amount === 0) continue;
    if (contributors.length === 1 && eligible.length === 1) {
      refunds.push({ seat: eligible[0]!, amount });
      continue;
    }
    const last = pots[pots.length - 1];
    if (eligible.length === 0) {
      if (last) last.amount += amount;
      else pots.push({ amount, eligible });
      continue;
    }
    if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  // Defensive: a leading pot with no eligible seats cannot happen in a legal hand,
  // but if it did, fold its chips into the next pot rather than lose them.
  while (pots.length > 1 && pots[0]!.eligible.length === 0) {
    const dead = pots.shift()!;
    pots[0]!.amount += dead.amount;
  }
  // Merge consecutive refunds for the same seat
  const merged = new Map<number, number>();
  for (const r of refunds) merged.set(r.seat, (merged.get(r.seat) ?? 0) + r.amount);
  return { pots, refunds: [...merged.entries()].map(([seat, amount]) => ({ seat, amount })) };
}

function sameSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Split an amount among winners. Odd chips go one at a time to winners in
 * clockwise order starting from the first seat left of the button.
 */
export function splitPot(amount: number, winners: readonly number[], buttonSeat: number, maxSeats: number): Map<number, number> {
  const out = new Map<number, number>();
  if (winners.length === 0) return out;
  const share = Math.floor(amount / winners.length);
  let remainder = amount - share * winners.length;
  const order = winners.slice().sort((a, b) => distance(buttonSeat, a, maxSeats) - distance(buttonSeat, b, maxSeats));
  for (const w of order) out.set(w, share);
  for (let i = 0; remainder > 0; i++, remainder--) {
    const w = order[i % order.length]!;
    out.set(w, out.get(w)! + 1);
  }
  return out;
}

/** Clockwise distance from the button to a seat, in 1..maxSeats (button itself = maxSeats). */
function distance(button: number, seat: number, maxSeats: number): number {
  const d = (seat - button + maxSeats) % maxSeats;
  return d === 0 ? maxSeats : d;
}
