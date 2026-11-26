#!/usr/bin/env node
/**
 * Independent verifier for a NOIR hand verification bundle (exported from the hand history page).
 * Usage: noir-verify bundle.json
 * Checks: every revealed card's Merkle proof against the published root, deal-permutation positions
 * from the published mix, that the mix equals SHA256 of the root and the contributions, and the event hash chain.
 */
import { readFileSync } from 'node:fs';
import { chainHash, mixEntropy, verifyReveal, type CardReveal, type DeckCommitment, type EntropyContribution } from '../index.js';

interface Bundle {
  commitment: DeckCommitment;
  contributions: EntropyContribution[];
  mix: string;
  reveals: CardReveal[];
  chain?: { prevHash: string; events: { seq: number; type: string; payload: unknown; hash: string }[] };
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: noir-verify <bundle.json>');
  process.exit(2);
}
const b = JSON.parse(readFileSync(file, 'utf8')) as Bundle;
let ok = true;
const recomputed = mixEntropy(b.commitment.root, b.contributions);
console.log(`${recomputed === b.mix ? 'PASS' : 'FAIL'}  mix recomputed from root + ${b.contributions.length} contributions`);
ok &&= recomputed === b.mix;
for (const r of b.reveals) {
  const v = verifyReveal(b.commitment, b.mix, r);
  ok &&= v;
  console.log(`${v ? 'PASS' : 'FAIL'}  card ${r.card} at deal index ${r.dealIndex} (position ${r.position})`);
}
if (b.chain) {
  let prev = b.chain.prevHash;
  let chainOk = true;
  for (const e of b.chain.events) {
    const h = chainHash(prev, e.seq, e.type, e.payload);
    if (h !== e.hash) chainOk = false;
    prev = e.hash;
  }
  ok &&= chainOk;
  console.log(`${chainOk ? 'PASS' : 'FAIL'}  event hash chain (${b.chain.events.length} events)`);
}
console.log(ok ? '\nAll checks passed.' : '\nVERIFICATION FAILED.');
process.exit(ok ? 0 : 1);
