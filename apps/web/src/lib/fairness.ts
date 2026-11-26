/**
 * Browser-side verifier for the NOIR-CARD-v1 protocol (mirror of packages/engine/src/fairness.ts).
 * Lets every player check, on their own device, that each card shown to them was committed
 * before the hand and sits at the deal position derived from the public entropy mix.
 */
const enc = new TextEncoder();
const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (data: Uint8Array) => toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));

export async function leafHash(commitId: string, position: number, card: string, saltHex: string) {
  return sha256(concat(enc.encode('NOIR-CARD-v1'), enc.encode('\x00'), enc.encode(commitId), enc.encode('\x00'), new Uint8Array([position & 0xff]), enc.encode(card), hexToBytes(saltHex)));
}
const nodeHash = (l: string, r: string) => sha256(concat(new Uint8Array([1]), hexToBytes(l), hexToBytes(r)));

/** Public deal permutation: Fisher–Yates driven by HMAC-SHA256(mix, "NOIR-DRBG-v1" || counter). */
export async function dealPermutation(mixHex: string): Promise<number[]> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(mixHex) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let counter = 0n;
  let buf = new Uint8Array(0);
  const u32 = async () => {
    if (buf.length < 4) {
      const c = new Uint8Array(8);
      new DataView(c.buffer).setBigUint64(0, counter++);
      const block = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(enc.encode('NOIR-DRBG-v1'), c) as BufferSource));
      buf = concat(buf, block);
    }
    const v = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
    buf = buf.slice(4);
    return v;
  };
  const int = async (max: number) => {
    const limit = 2 ** 32 - (2 ** 32 % max);
    for (;;) { const v = await u32(); if (v < limit) return v % max; }
  };
  const a = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = await int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface Reveal { dealIndex: number; position: number; card: string; salt: string; proof: { side: 'L' | 'R'; hash: string }[] }

const permCache = new Map<string, Promise<number[]>>();
export async function verifyReveal(commitId: string, root: string, mix: string, r: Reveal): Promise<boolean> {
  try {
    if (!permCache.has(mix)) permCache.set(mix, dealPermutation(mix));
    const perm = await permCache.get(mix)!;
    if (perm[r.dealIndex] !== r.position) return false;
    let h = await leafHash(commitId, r.position, r.card, r.salt);
    for (const s of r.proof) h = s.side === 'R' ? await nodeHash(h, s.hash) : await nodeHash(s.hash, h);
    return h === root;
  } catch {
    return false;
  }
}

export function randomEntropy(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
