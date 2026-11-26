import { describe, expect, it } from 'vitest';
import { createDeckSecret, commitmentOf, mixEntropy, dealPermutation as enginePerm, revealCard } from '../../../packages/engine/src/index';
import { dealPermutation, verifyReveal } from '../static/js/fairness.js';

describe('browser fairness verifier matches the server engine', () => {
  it('derives the identical deal permutation and verifies real reveals', async () => {
    const secret = createDeckSecret('hand-xyz');
    const c = commitmentOf(secret);
    const mix = mixEntropy(c.root, [{ playerId: 'a', entropy: 'ab'.repeat(32) }]);
    const perm = enginePerm(mix);
    expect(await dealPermutation(mix)).toEqual(perm);
    for (const k of [0, 5, 17, 51]) {
      const r = revealCard(secret, k, perm);
      expect(await verifyReveal(c.commitId, c.root, mix, r)).toBe(true);
      expect(await verifyReveal(c.commitId, c.root, mix, { ...r, card: r.card === 'As' ? 'Ks' : 'As' })).toBe(false);
    }
  });
});
