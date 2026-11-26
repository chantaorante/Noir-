import { randomBytes } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';
import { loadConfig } from '../src/config/env.js';
import { createPool, withTx } from '../src/db/pool.js';
import { createNoir, type Noir } from '../src/server.js';
import { encryptSecret, newTotpSecret, totpAt } from '../src/modules/auth/crypto.js';
import { insertUser } from '../src/modules/auth/users.js';

export const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://noir:noir_dev_only@localhost:5432/noir_test';
export const ORIGIN = 'http://localhost:3999';
export const PASSWORD = 'Correct-Horse-Battery-9';

const DATA_KEY = randomBytes(32).toString('hex');

export async function startNoir(env: Record<string, string> = {}, opts: { keepDb?: boolean } = {}): Promise<{ noir: Noir; url: string }> {
  if (!opts.keepDb) {
    const reset = createPool(DB_URL, 1);
    await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await reset.end();
  }
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: DB_URL, PUBLIC_ORIGINS: ORIGIN, NOIR_DATA_KEY: DATA_KEY,
    COOKIE_SECURE: 'false', TRUST_PROXY: 'false', HOST: '127.0.0.1', PORT: '0', HAND_PAUSE_MS: '50', LOG_LEVEL: 'silent', LOGIN_RATE_LIMIT: '1000', ...env,
  });
  const noir = await createNoir(config, { listen: true });
  const addr = noir.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  (noir as unknown as { config: typeof config }).config = config;
  return { noir, url: `http://127.0.0.1:${port}` };
}

export async function makeUser(noir: Noir, username: string, role: 'owner' | 'admin' | 'moderator' | 'player' = 'player', opts: { mfa?: boolean } = {}) {
  const config = (noir as unknown as { config: ReturnType<typeof loadConfig> }).config;
  const u = await withTx(noir.db, (tx) => insertUser(tx, { username, displayName: username, role, password: PASSWORD }));
  let totpSecret: string | null = null;
  if (opts.mfa) {
    totpSecret = newTotpSecret();
    await noir.db.query('UPDATE user_credentials SET totp_secret_enc = $2, totp_enabled = true WHERE user_id = $1', [u.id, encryptSecret(config.dataKey, totpSecret)]);
  }
  return { ...u, username, totpSecret };
}

export const totpNow = (secret: string, offsetSteps = 0) => totpAt(secret, Math.floor(Date.now() / 30_000) + offsetSteps);

/** Minimal cookie-aware HTTP client that behaves like the SPA (sends Origin, client header, CSRF). */
export class Client {
  cookie = '';
  csrf = '';
  constructor(public readonly base: string) {}
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; origin?: string | null; clientHeader?: boolean } = {}) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (opts.clientHeader !== false) headers['x-noir-client'] = '1';
    if (opts.csrf !== false && this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const [kv] = c.split(';');
      if (kv!.startsWith('noir_sid=')) this.cookie = kv!.endsWith('=') ? '' : kv!;
    }
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    if (json && typeof json === 'object' && typeof json.csrf === 'string') this.csrf = json.csrf;
    return { status: res.status, body: json, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  async login(username: string, password = PASSWORD, totp?: string) {
    return this.post('/api/auth/login', { username, password, ...(totp ? { totp } : {}) });
  }
}

export function connectSocket(url: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(url, { path: '/ws', transports: ['websocket'], extraHeaders: { cookie, origin: ORIGIN }, reconnection: false, forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
}

export function emitAck<T = any>(s: Socket, ev: string, data?: unknown): Promise<T> {
  return new Promise((resolve) => (data === undefined ? s.emit(ev, resolve) : s.emit(ev, data, resolve)));
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

/**
 * TEST ONLY: log a staff member in with a valid current TOTP code. Replay protection means each
 * time step is accepted once per account, so the test clears the last-used step first.
 */
export async function loginStaff(noir: Noir, c: Client, u: { id: string; username: string; totpSecret: string | null }) {
  await noir.db.query('UPDATE user_credentials SET totp_last_step = NULL WHERE user_id = $1', [u.id]);
  const r = await c.login(u.username, PASSWORD, totpNow(u.totpSecret!));
  if (r.status !== 200) throw new Error(`staff login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
