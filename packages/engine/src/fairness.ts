/**
 * NOIR fairness protocol v1 — see docs/FAIRNESS_AND_AUDIT.md.
 *
 * 1. Server shuffles deck D with the OS CSPRNG and draws a 256-bit salt per position.
 * 2. leaf_i = SHA256("NOIR-CARD-v1" | commitId | i | card_i | salt_i); root R = Merkle(leaf_0..51).
 *    R is published BEFORE any player entropy is accepted.
 * 3. Players submit entropy after seeing R. mix = SHA256("NOIR-MIX-v1" | R | sorted contributions).
 * 4. Deal permutation P = FisherYates([0..51], HmacDrbg(mix)). The k-th dealt card is D[P[k]].
 * 5. Every revealed card is shipped with (position, salt, Merkle proof) so a client can check it
 *    against R and that its position equals P[k]. Unrevealed cards' salts are never published.
 */
import { createHash } from 'node:crypto';
import { isCard, orderedDeck, type Card } from './cards.js';
import { cryptoRandom, HmacDrbg, secureBytes, type RandomSource } from './rng.js';
import { fisherYates } from './shuffle.js';

export const DECK_SIZE = 52;

const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

function u8(n: number): Buffer {
  return Buffer.from([n & 0xff]);
}

export function leafHash(commitId: string, position: number, card: Card, saltHex: string): string {
  return sha256('NOIR-CARD-v1', '\x00', commitId, '\x00', u8(position), card, Buffer.from(saltHex, 'hex')).toString('hex');
}

function nodeHash(left: string, right: string): string {
  return sha256(u8(1), Buffer.from(left, 'hex'), Buffer.from(right, 'hex')).toString('hex');
}

/** Merkle tree levels; odd nodes are promoted unchanged. levels[0] = leaves. */
function buildLevels(leaves: string[]): string[][] {
  const levels: string[][] = [leaves];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? nodeHash(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    levels.push(next);
  }
  return levels;
}

export interface ProofStep { side: 'L' | 'R'; hash: string }

export interface DeckSecret {
  commitId: string;
  /** Deck order by committed position. SECRET until individually revealed. */
  cards: Card[];
  /** Per-position salts (hex). SECRET until individually revealed. */
  salts: string[];
  root: string;
}

export interface DeckCommitment { commitId: string; root: string; algorithm: 'NOIR-CARD-v1/sha256-merkle' }

export function createDeckSecret(commitId: string, rng: RandomSource = cryptoRandom, saltSource: (n: number) => Buffer = secureBytes): DeckSecret {
  const cards = fisherYates(orderedDeck(), rng);
  const salts = cards.map(() => saltSource(32).toString('hex'));
  const leaves = cards.map((c, i) => leafHash(commitId, i, c, salts[i]!));
  const levels = buildLevels(leaves);
  return { commitId, cards, salts, root: levels[levels.length - 1]![0]! };
}

export function commitmentOf(secret: DeckSecret): DeckCommitment {
  return { commitId: secret.commitId, root: secret.root, algorithm: 'NOIR-CARD-v1/sha256-merkle' };
}

export function merkleProof(secret: DeckSecret, position: number): ProofStep[] {
  const leaves = secret.cards.map((c, i) => leafHash(secret.commitId, i, c, secret.salts[i]!));
  const levels = buildLevels(leaves);
  const proof: ProofStep[] = [];
  let idx = position;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]!;
    const sibling = idx ^ 1;
    if (sibling < level.length) proof.push({ side: idx % 2 === 0 ? 'R' : 'L', hash: level[sibling]! });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export interface CardReveal {
  dealIndex: number;
  position: number;
  card: Card;
  salt: string;
  proof: ProofStep[];
}

export function revealCard(secret: DeckSecret, dealIndex: number, permutation: readonly number[]): CardReveal {
  const position = permutation[dealIndex];
  if (position === undefined) throw new Error('dealIndex out of range');
  return { dealIndex, position, card: secret.cards[position]!, salt: secret.salts[position]!, proof: merkleProof(secret, position) };
}

/** Client-side/independent verification of a single revealed card. */
export function verifyReveal(commitment: DeckCommitment, mixHex: string, reveal: CardReveal): boolean {
  if (!isCard(reveal.card) || !/^[0-9a-f]{64}$/.test(reveal.salt)) return false;
  const perm = dealPermutation(mixHex);
  if (perm[reveal.dealIndex] !== reveal.position) return false;
  let h = leafHash(commitment.commitId, reveal.position, reveal.card, reveal.salt);
  for (const step of reveal.proof) h = step.side === 'R' ? nodeHash(h, step.hash) : nodeHash(step.hash, h);
  return h === commitment.root;
}

export interface EntropyContribution { playerId: string; entropy: string }

const HEX64 = /^[0-9a-f]{64}$/;
export function isValidEntropy(e: unknown): e is string {
  return typeof e === 'string' && HEX64.test(e);
}

/** mix = SHA256("NOIR-MIX-v1" | root | for each contribution sorted by playerId: playerId | entropy). */
export function mixEntropy(root: string, contributions: readonly EntropyContribution[]): string {
  const sorted = contributions.slice().sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
  const parts: (string | Buffer)[] = ['NOIR-MIX-v1', '\x00', Buffer.from(root, 'hex')];
  for (const c of sorted) {
    if (!isValidEntropy(c.entropy)) throw new Error('invalid entropy');
    parts.push('\x00', c.playerId, '\x00', Buffer.from(c.entropy, 'hex'));
  }
  return sha256(...parts).toString('hex');
}

/** Public, deterministic deal permutation from the mix value. */
export function dealPermutation(mixHex: string): number[] {
  const idx = Array.from({ length: DECK_SIZE }, (_, i) => i);
  return fisherYates(idx, new HmacDrbg(Buffer.from(mixHex, 'hex')));
}

/** Cards in deal order: dealt[k] = D[P[k]]. */
export function dealOrder(secret: DeckSecret, permutation: readonly number[]): Card[] {
  return permutation.map((p) => secret.cards[p]!);
}

/** Hash-chained event log link: SHA256(prev | seq | type | canonical JSON payload). */
export function chainHash(prevHash: string, seq: number, type: string, payload: unknown): string {
  return sha256(Buffer.from(prevHash, 'hex'), '\x00', String(seq), '\x00', type, '\x00', canonicalJson(payload)).toString('hex');
}

export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
