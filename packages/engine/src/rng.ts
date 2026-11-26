import { createHmac, randomInt, randomBytes } from 'node:crypto';

/** Source of uniform integers in [0, maxExclusive). */
export interface RandomSource {
  int(maxExclusive: number): number;
}

/**
 * Production randomness: Node's crypto.randomInt, backed by the OS CSPRNG
 * (getrandom(2) on Linux). randomInt uses rejection sampling, so it is unbiased.
 */
export const cryptoRandom: RandomSource = {
  int(maxExclusive: number): number {
    return randomInt(0, maxExclusive);
  },
};

export function secureBytes(n: number): Buffer {
  return randomBytes(n);
}

/**
 * Deterministic random bit generator: HMAC-SHA256(key, "NOIR-DRBG-v1" || counter).
 * Used ONLY where determinism is the point:
 *  - deriving the public deal permutation from the public mix value (fairness protocol),
 *  - reproducible tests.
 * It is never used to shuffle the authoritative deck.
 */
export class HmacDrbg implements RandomSource {
  private counter = 0n;
  private buffer = Buffer.alloc(0);
  constructor(private readonly key: Buffer) {
    if (key.length < 16) throw new Error('DRBG key too short');
  }

  private nextBlock(): void {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(this.counter++);
    const block = createHmac('sha256', this.key).update('NOIR-DRBG-v1').update(c).digest();
    this.buffer = Buffer.concat([this.buffer, block]);
  }

  private uint32(): number {
    if (this.buffer.length < 4) this.nextBlock();
    const v = this.buffer.readUInt32BE(0);
    this.buffer = this.buffer.subarray(4);
    return v;
  }

  /** Unbiased via rejection sampling. */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 2 ** 32) {
      throw new Error('maxExclusive out of range');
    }
    const limit = 2 ** 32 - (2 ** 32 % maxExclusive);
    for (;;) {
      const v = this.uint32();
      if (v < limit) return v % maxExclusive;
    }
  }
}
