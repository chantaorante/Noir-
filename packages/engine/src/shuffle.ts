import type { RandomSource } from './rng.js';

/** Fisher–Yates (Durstenfeld) shuffle. Returns a new array; input is not mutated. */
export function fisherYates<T>(items: readonly T[], rng: RandomSource): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}
