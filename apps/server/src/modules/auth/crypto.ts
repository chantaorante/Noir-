import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// ---------------------------------------------------------------- passwords (Argon2id)
const ARGON = { algorithm: 2 /* Argon2id */, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
const MAX_CONCURRENT_HASHES = 4;
let active = 0;
const waiters: (() => void)[] = [];

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_HASHES) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

export const hashPassword = (pw: string) => withHashSlot(() => argonHash(pw, ARGON));
export const verifyPassword = (hash: string, pw: string) => withHashSlot(() => argonVerify(hash, pw).catch(() => false));

/** A real Argon2id hash used to equalize timing when the username does not exist. */
let dummyHash: Promise<string> | null = null;
export const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

const COMMON = new Set(['password123', '1234567890', 'qwertyuiop', 'password1!', 'iloveyou12', 'admin12345', 'letmein123', 'welcome123', 'football12', 'monkey1234', 'noirpoker1', 'pokerpoker']);
export function passwordProblem(pw: string, username: string): string | null {
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common.';
  if (lower.includes(username.toLowerCase())) return 'Password must not contain your username.';
  if (new Set(pw).size < 5) return 'Password is too repetitive.';
  return null;
}

// ---------------------------------------------------------------- tokens
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest();
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- AES-256-GCM for secrets at rest
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}
export function decryptSecret(key: Buffer, blob: string): string {
  const [v, iv, ct, tag] = blob.split('.');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('bad secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

/** Returns the matched time step (±1 step drift) or null. Caller must reject steps <= last used step. */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  const step = Math.floor(nowMs / 30_000);
  for (const s of [step, step - 1, step + 1]) if (safeEqual(totpAt(secretB32, s), code)) return s;
  return null;
}

export function otpauthUrl(secret: string, username: string): string {
  return `otpauth://totp/NOIR:${encodeURIComponent(username)}?secret=${secret}&issuer=NOIR&algorithm=SHA1&digits=6&period=30`;
}
