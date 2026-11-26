import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Noir } from '../src/server.js';
import { Client, makeUser, startNoir, totpNow, PASSWORD } from './harness.js';

let noir: Noir;
let url: string;
beforeAll(async () => ({ noir, url } = await startNoir()));
afterAll(async () => noir?.close());

describe('authentication', () => {
  it('logs in, exposes /me, and stores only a hash of the session token', async () => {
    await makeUser(noir, 'alice');
    const c = new Client(url);
    const r = await c.login('alice');
    expect(r.status).toBe(200);
    expect(c.cookie).toMatch(/^noir_sid=/);
    const set = r.headers.getSetCookie().join(';');
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const me = await c.get('/api/auth/me');
    expect(me.body.user.username).toBe('alice');
    expect(me.body.credits).toEqual({ wallet: 0, onTables: 0, denomination: 'ALL' });
    const token = c.cookie.split('=')[1]!;
    const raw = await noir.db.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash::text LIKE $1', [`%${token}%`]);
    expect(raw.rows[0].n).toBe(0);
    const hash = await noir.db.query('SELECT password_hash FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE username = $1', ['alice']);
    expect(hash.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(hash.rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('uses the same generic error for unknown users and wrong passwords', async () => {
    const c = new Client(url);
    const a = await c.login('nobody_here', 'whatever-123');
    const b = await c.login('alice', 'wrong-password-1');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('locks the account after 5 failed attempts', async () => {
    await makeUser(noir, 'bob');
    const c = new Client(url);
    for (let i = 0; i < 5; i++) await c.login('bob', 'bad-password-x');
    const r = await c.login('bob');
    expect(r.status).toBe(423);
    const sec = await noir.db.query(`SELECT count(*)::int AS n FROM security_events WHERE kind = 'account_locked'`);
    expect(sec.rows[0].n).toBeGreaterThan(0);
  });

  it('rejects state-changing requests without CSRF token, client header, or with a foreign Origin', async () => {
    const c = new Client(url);
    await c.login('alice');
    expect((await c.req('POST', '/api/notifications/read', {}, { csrf: false })).status).toBe(403);
    expect((await c.req('POST', '/api/notifications/read', {}, { clientHeader: false })).status).toBe(403);
    expect((await c.req('POST', '/api/notifications/read', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/api/notifications/read')).status).toBe(200);
  });

  it('logout revokes the session server-side', async () => {
    const c = new Client(url);
    await c.login('alice');
    const cookie = c.cookie;
    await c.post('/api/auth/logout');
    c.cookie = cookie; // replay the old cookie
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('requires TOTP when enabled and rejects code replay', async () => {
    const u = await makeUser(noir, 'carol', 'player', { mfa: true });
    const c = new Client(url);
    const r1 = await c.login('carol');
    expect(r1.status).toBe(401);
    expect(r1.body.code).toBe('MFA_REQUIRED');
    const code = totpNow(u.totpSecret!);
    expect((await c.login('carol', PASSWORD, code)).status).toBe(200);
    const c2 = new Client(url);
    expect((await c2.login('carol', PASSWORD, code)).status).toBe(401); // same step reused
  });

  it('full MFA enrolment flow rotates the session', async () => {
    await makeUser(noir, 'dave');
    const c = new Client(url);
    await c.login('dave');
    const before = c.cookie;
    const setup = await c.post('/api/auth/mfa/setup');
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/NOIR:dave\?secret=/);
    const { totpAt } = await import('../src/modules/auth/crypto.js');
    const code = totpAt(setup.body.secret, Math.floor(Date.now() / 30_000));
    const en = await c.post('/api/auth/mfa/enable', { code });
    expect(en.status).toBe(200);
    expect(en.body.recoveryCodes).toHaveLength(10);
    expect(c.cookie).not.toBe(before);
    const old = new Client(url);
    old.cookie = before;
    expect((await old.get('/api/auth/me')).status).toBe(401);
    expect((await c.get('/api/auth/me')).body.user.mfaEnabled).toBe(true);

    // Recovery codes: each logs in exactly once; wrong codes are rejected.
    const rc = en.body.recoveryCodes[0];
    const r1 = new Client(url);
    expect((await r1.post('/api/auth/login', { username: 'dave', password: PASSWORD, recoveryCode: rc })).status).toBe(200);
    expect((await r1.get('/api/auth/me')).body.user.username).toBe('dave');
    const r2 = new Client(url);
    expect((await r2.post('/api/auth/login', { username: 'dave', password: PASSWORD, recoveryCode: rc })).status).toBe(401);
    expect((await r2.post('/api/auth/login', { username: 'dave', password: PASSWORD, recoveryCode: 'AAAAAAAAAA' })).status).toBe(401);
    const left = await noir.db.query("SELECT cardinality(recovery_codes) AS n FROM user_credentials c JOIN users u ON u.id = c.user_id WHERE u.username = 'dave'");
    expect(left.rows[0].n).toBe(9);
  });

  it('registration requires a valid invitation code', async () => {
    const c = new Client(url);
    const r = await c.post('/api/auth/register', { inviteCode: 'not-a-real-code', username: 'eve', displayName: 'Eve', password: 'A-strong-pass-77' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_INVITE');
  });

  it('rejects unknown fields and oversized bodies', async () => {
    const c = new Client(url);
    expect((await c.post('/api/auth/login', { username: 'alice', password: PASSWORD, role: 'owner' })).status).toBe(400);
    expect((await c.post('/api/auth/login', { username: 'a'.repeat(70_000), password: 'x' })).status).toBe(413);
  });

  it('SQL injection attempts in login are inert', async () => {
    const c = new Client(url);
    const r = await c.login("alice' OR '1'='1", "x' OR '1'='1");
    expect(r.status).toBe(401);
  });

  it('sends security headers', async () => {
    const r = await new Client(url).get('/healthz');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('login rate limiting (default production limit)', () => {
  it('returns 429 after 10 attempts per minute from one IP', async () => {
    await noir.close();
    ({ noir, url } = await startNoir({ LOGIN_RATE_LIMIT: '10' }));
    const c = new Client(url);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await c.login('ghost', 'whatever-123')).status);
    expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
