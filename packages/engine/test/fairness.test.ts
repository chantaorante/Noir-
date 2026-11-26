import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createDeckSecret, commitmentOf, dealPermutation, dealOrder, mixEntropy, revealCard, verifyReveal,
  fisherYates, cryptoRandom, HmacDrbg, chainHash, GENESIS_HASH, canonicalJson, orderedDeck,
} from '../src/index.js';

const hex = (b: number) => Buffer.alloc(32, b).toString('hex');

describe('shuffle', () => {
  it('produces a permutation of 52 distinct cards', () => {
    const d = fisherYates(orderedDeck(), cryptoRandom);
    expect(new Set(d).size).toBe(52);
    expect(d.slice().sort()).toEqual(orderedDeck().sort());
  });

  it('is approximately uniform: position of each card (chi-square, 52×52 cells, 104,000 shuffles)', () => {
    const N = 104_000;
    const counts = Array.from({ length: 52 }, () => new Array(52).fill(0));
    const base = Array.from({ length: 52 }, (_, i) => i);
    for (let n = 0; n < N; n++) {
      const d = fisherYates(base, cryptoRandom);
      d.forEach((card, pos) => counts[card]![pos]++);
    }
    const expected = N / 52;
    let chi = 0;
    for (const row of counts) for (const c of row) chi += (c - expected) ** 2 / expected;
    // df = 51*51 = 2601; mean 2601, sd ≈ 72. Threshold at mean + 6 sd → false failure prob < 1e-8.
    expect(chi).toBeLessThan(2601 + 6 * 72);
    expect(chi).toBeGreaterThan(2601 - 6 * 72);
  }, 60_000);

  it('production module never references Math.random', () => {
    for (const f of ['rng.ts', 'shuffle.ts', 'fairness.ts', 'holdem.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
      expect(src).not.toMatch(/Math\.random/);
    }
  });

  it('HmacDrbg is deterministic and key-dependent', () => {
    const a = fisherYates(orderedDeck(), new HmacDrbg(Buffer.alloc(32, 1)));
    const b = fisherYates(orderedDeck(), new HmacDrbg(Buffer.alloc(32, 1)));
    const c = fisherYates(orderedDeck(), new HmacDrbg(Buffer.alloc(32, 2)));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('deck commitment protocol', () => {
  const secret = createDeckSecret('hand-123');
  const commitment = commitmentOf(secret);
  const mix = mixEntropy(commitment.root, [{ playerId: 'u2', entropy: hex(2) }, { playerId: 'u1', entropy: hex(1) }]);
  const perm = dealPermutation(mix);

  it('deal permutation is a permutation of 0..51', () => {
    expect(perm.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, i) => i));
  });

  it('mix is independent of contribution order', () => {
    expect(mixEntropy(commitment.root, [{ playerId: 'u1', entropy: hex(1) }, { playerId: 'u2', entropy: hex(2) }])).toBe(mix);
  });

  it('every revealed card verifies against the root', () => {
    for (let k = 0; k < 52; k++) {
      const r = revealCard(secret, k, perm);
      expect(r.card).toBe(dealOrder(secret, perm)[k]);
      expect(verifyReveal(commitment, mix, r)).toBe(true);
    }
  });

  it('a substituted card, salt, position or proof fails verification', () => {
    const r = revealCard(secret, 0, perm);
    const other = secret.cards.find((c) => c !== r.card)!;
    expect(verifyReveal(commitment, mix, { ...r, card: other })).toBe(false);
    expect(verifyReveal(commitment, mix, { ...r, salt: hex(9) })).toBe(false);
    expect(verifyReveal(commitment, mix, { ...r, position: (r.position + 1) % 52 })).toBe(false);
    expect(verifyReveal(commitment, mix, { ...r, proof: r.proof.slice(1) })).toBe(false);
    expect(verifyReveal(commitment, mixEntropy(commitment.root, []), r)).toBe(false);
  });

  it('a reveal does not disclose other cards (the proof contains only hashes)', () => {
    const r = revealCard(secret, 0, perm);
    const blob = JSON.stringify(r);
    for (const c of secret.cards) if (c !== r.card) expect(blob.includes(`"${c}"`)).toBe(false);
    for (const s of secret.salts) if (s !== r.salt) expect(blob.includes(s)).toBe(false);
  });

  it('player entropy changes which committed card is dealt first', () => {
    const mix2 = mixEntropy(commitment.root, [{ playerId: 'u1', entropy: hex(3) }]);
    expect(dealPermutation(mix2)).not.toEqual(perm);
  });

  it('rejects malformed entropy', () => {
    expect(() => mixEntropy(commitment.root, [{ playerId: 'x', entropy: 'zz' }])).toThrow();
  });
});

describe('hash chain', () => {
  it('links events and detects tampering', () => {
    const h1 = chainHash(GENESIS_HASH, 1, 'A', { x: 1, y: [1, 2] });
    const h2 = chainHash(h1, 2, 'B', { z: 'q' });
    expect(chainHash(GENESIS_HASH, 1, 'A', { y: [1, 2], x: 1 })).toBe(h1); // canonical key order
    expect(chainHash(h1, 2, 'B', { z: 'r' })).not.toBe(h2);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
