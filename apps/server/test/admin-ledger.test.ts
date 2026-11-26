import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Noir } from '../src/server.js';
import { verifyUserLedger } from '../src/modules/ledger/ledger.js';
import { Client, loginStaff, makeUser, startNoir } from './harness.js';

let noir: Noir;
let url: string;
let owner: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let mod: Awaited<ReturnType<typeof makeUser>>;
let player: Awaited<ReturnType<typeof makeUser>>;
let adminC: Client;

beforeAll(async () => {
  ({ noir, url } = await startNoir());
  owner = await makeUser(noir, 'owner1', 'owner', { mfa: true });
  admin = await makeUser(noir, 'admin1', 'admin', { mfa: true });
  mod = await makeUser(noir, 'mod1', 'moderator', { mfa: true });
  player = await makeUser(noir, 'player1');
  adminC = new Client(url);
  await loginStaff(noir, adminC, admin);
});
afterAll(async () => noir?.close());

const grant = (c: Client, userId: string, amount: number, kind: 'grant' | 'correction' = 'grant', key = randomUUID()) =>
  c.post('/api/admin/credits', { userId, amount, kind, reason: 'Testing ledger', idempotencyKey: key });

describe('role-based access control', () => {
  it('players cannot reach any admin endpoint', async () => {
    const c = new Client(url);
    await c.login('player1');
    for (const p of ['/api/admin/dashboard', '/api/admin/users', '/api/admin/credits/ledger', '/api/admin/audit']) expect((await c.get(p)).status).toBe(403);
    expect((await grant(c, player.id, 1000)).status).toBe(403);
  });

  it('moderators can moderate but cannot touch credits, audit or config', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, mod);
    expect((await c.get('/api/admin/reports')).status).toBe(200);
    expect((await c.get('/api/admin/credits/ledger')).status).toBe(403);
    expect((await grant(c, player.id, 1000)).status).toBe(403);
    expect((await c.get('/api/admin/audit')).status).toBe(403);
    expect((await c.req('PUT', '/api/admin/config/maintenance', { enabled: true, message: 'x' })).status).toBe(403);
  });

  it('staff without MFA are blocked from admin functions', async () => {
    await makeUser(noir, 'admin_nomfa', 'admin');
    const c = new Client(url);
    await c.login('admin_nomfa');
    const r = await c.get('/api/admin/users');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MFA_REQUIRED');
  });

  it('high-risk credit operations require a fresh step-up even with MFA', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, admin);
    await noir.db.query(`UPDATE sessions SET mfa_at = now() - interval '10 minutes' WHERE user_id = $1`, [admin.id]);
    const r = await grant(c, player.id, 500);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('STEP_UP_REQUIRED');
  });

  it('an administrator cannot manage the owner or promote to admin', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, admin);
    expect((await c.post(`/api/admin/users/${owner.id}/status`, { status: 'banned', reason: 'coup attempt' })).status).toBe(403);
    expect((await c.post(`/api/admin/users/${player.id}/role`, { role: 'admin' })).status).toBe(403);
  });
});

describe('credit ledger', () => {
  it('grants are append-only entries with before/after balances and an audit record', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    const r = await grant(c, player.id, 10_000);
    expect(r.status).toBe(200);
    expect(r.body.entry).toMatchObject({ amount: 10_000, balance_before: 0, balance_after: 10_000, entry_type: 'ADMIN_GRANT' });
    const audit = await noir.db.query(`SELECT * FROM admin_audit_log WHERE action = 'credits.grant' AND target_id = $1`, [player.id]);
    expect(audit.rowCount).toBe(1);
    await expect(noir.db.query('UPDATE credit_ledger SET amount = 999999 WHERE user_id = $1', [player.id])).rejects.toThrow(/append-only/);
    await expect(noir.db.query('DELETE FROM credit_ledger WHERE user_id = $1', [player.id])).rejects.toThrow(/append-only/);
    await expect(noir.db.query('DELETE FROM admin_audit_log')).rejects.toThrow(/append-only/);
  });

  it('idempotency key prevents double application; reuse with different amount is rejected', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    const key = randomUUID();
    const a = await grant(c, player.id, 250, 'grant', key);
    const b = await grant(c, player.id, 250, 'grant', key);
    expect(a.body.entry.id).toBe(b.body.entry.id);
    const bad = await grant(c, player.id, 999, 'grant', key);
    expect(bad.status).toBe(409);
  });

  it('corrections cannot make a balance negative; grants cannot be negative', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    expect((await grant(c, player.id, -1_000_000, 'correction')).status).toBe(409);
    expect((await grant(c, player.id, -5, 'grant')).status).toBe(400);
    const ok = await grant(c, player.id, -250, 'correction');
    expect(ok.body.entry.entry_type).toBe('ADMIN_CORRECTION');
  });

  it('25 concurrent grants serialize into a gap-free chain', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, admin);
    // A fresh step-up for this session (mfa_at is set at login).
    const target = await makeUser(noir, 'concurrency1');
    const results = await Promise.all(Array.from({ length: 25 }, () => grant(c, target.id, 7)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bal = await noir.db.query('SELECT balance_after, seq FROM credit_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 1', [target.id]);
    expect(bal.rows[0]).toEqual({ balance_after: 175, seq: 25 });
    expect(await verifyUserLedger(noir.db, target.id)).toBeNull();
  });

  it('users cannot change balances through any player endpoint', async () => {
    const c = new Client(url);
    await c.login('player1');
    const before = (await c.get('/api/auth/me')).body.credits.wallet;
    await c.req('PATCH', '/api/me/profile', { balance: 1e9 });
    await c.post('/api/gifts', { toUserId: owner.id, itemKey: 'rose', amount: 5000 });
    expect((await c.get('/api/auth/me')).body.credits.wallet).toBe(before);
  });

  it('CSV export neutralizes formula injection and is audit-logged', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    await c.post('/api/admin/credits', { userId: player.id, amount: 1, kind: 'grant', reason: '=HYPERLINK("x")', idempotencyKey: randomUUID() });
    const r = await c.get(`/api/admin/credits/export?userId=${player.id}`);
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('audit chain verifies and detects tampering', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    const ok = await c.get('/api/admin/audit');
    expect(ok.body.chainIntact).toBe(true);
    await noir.db.query('ALTER TABLE admin_audit_log DISABLE TRIGGER admin_audit_append_only');
    await noir.db.query(`UPDATE admin_audit_log SET details = '{"amount": 1}' WHERE id = (SELECT min(id) FROM admin_audit_log)`);
    await noir.db.query('ALTER TABLE admin_audit_log ENABLE TRIGGER admin_audit_append_only');
    const bad = await c.get('/api/admin/audit');
    expect(bad.body.chainIntact).toBe(false);
  });
});

describe('admin user management', () => {
  it('creates a user with a one-time setup link (no password shown) and suspends with session revocation', async () => {
    const c = new Client(url);
    await loginStaff(noir, c, owner);
    const r = await c.post('/api/admin/users', { username: 'newbie', displayName: 'Newbie', role: 'player' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['expiresInHours', 'setupPath', 'user']);
    expect(JSON.stringify(r.body)).not.toMatch(/argon2/);
    const token = r.body.setupPath.split('#')[1];
    const n = new Client(url);
    expect((await n.post('/api/auth/password-reset', { token, newPassword: 'Brand-New-Pass-42' })).status).toBe(200);
    expect((await n.post('/api/auth/password-reset', { token, newPassword: 'Brand-New-Pass-43' })).status).toBe(400); // single use
    expect((await n.login('newbie', 'Brand-New-Pass-42')).status).toBe(200);
    const s = await c.post(`/api/admin/users/${r.body.user.id}/status`, { status: 'suspended', reason: 'testing suspension' });
    expect(s.status).toBe(200);
    expect((await n.get('/api/auth/me')).status).toBe(401);
    expect((await n.login('newbie', 'Brand-New-Pass-42')).status).toBe(403);
  });
});
