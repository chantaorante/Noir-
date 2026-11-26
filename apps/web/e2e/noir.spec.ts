import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';

const seed = () => JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8')) as {
  password: string; totpSecret: string; tableId: string; owner: { username: string }; players: { username: string }[];
};
const shots = process.env.E2E_SHOTS_DIR;

function base32(s: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
}
function totp(secret: string, step = Math.floor(Date.now() / 30_000)) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function seatedPlayer(browser: Browser, username: string, tableId: string, password: string, viewport: { width: number; height: number } | null) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  await login(page, username, password);
  await expect(page.getByRole('heading', { name: /Tables/ })).toBeVisible();
  await page.goto(`/table/${tableId}`);
  await page.getByRole('button', { name: /^Sit at seat/ }).first().click();
  await page.getByRole('button', { name: /^Buy in for/ }).click();
  await expect(page.getByRole('button', { name: /Sit out|Sit in/ })).toBeVisible();
  return { ctx, page };
}

test('login rejects a wrong password and accepts the right one', async ({ page }) => {
  const s = seed();
  await login(page, 'alice', 'not-the-password-1');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password').fill(s.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.table-card', { hasText: 'Velvet Room' })).toBeVisible();
  // Seeded with 10,000; earlier projects in the same run may have played hands, so only check it is a balance.
  await expect(page.locator('.wallet')).toContainText(/\d/);
  if (shots) await page.screenshot({ path: `${shots}/lobby-${test.info().project.name}.png`, fullPage: true });
});

test('two players sit, a hand is dealt, actions work and cards verify on the device', async ({ browser }, info) => {
  const s = seed();
  const vp = info.project.use.viewport ?? null;
  // Fresh DB state per project is not guaranteed; leave any seat first via a clean table per run.
  const a = await seatedPlayer(browser, 'alice', s.tableId, s.password, vp);
  const b = await seatedPlayer(browser, 'bob', s.tableId, s.password, vp);
  try {
    // Both clients see hole cards (own face up) once the hand starts.
    for (const p of [a.page, b.page]) await expect(p.locator('.seat.me .pcard.face')).toHaveCount(2, { timeout: 20_000 });
    // Opponent cards are face down for each viewer.
    await expect(a.page.locator('.seat:not(.me) .pcard.back')).toHaveCount(2);
    // Whoever is to act calls/checks; play continues to the flop.
    for (let i = 0; i < 6; i++) {
      const actor = (await a.page.getByRole('group', { name: 'Your action' }).isVisible()) ? a.page : (await b.page.getByRole('group', { name: 'Your action' }).isVisible()) ? b.page : null;
      if (!actor) { await a.page.waitForTimeout(400); continue; }
      const check = actor.getByRole('button', { name: /^Check$/ });
      if (await check.isVisible()) await check.click(); else await actor.getByRole('button', { name: /^Call/ }).click();
      if ((await a.page.locator('.board .pcard.face').count()) >= 3) break;
      await actor.waitForTimeout(300);
    }
    await expect.poll(() => a.page.locator('.board .pcard.face').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    if (shots) {
      await a.page.waitForTimeout(700);
      await a.page.screenshot({ path: `${shots}/table-${info.project.name}.png` });
    }
    await a.page.getByRole('button', { name: 'Fairness details' }).click();
    await expect(a.page.getByText(/\d+ verified/)).toBeVisible();
    await expect(a.page.getByText(/FAILED/)).toHaveCount(0);
    const txt = await a.page.locator('.modal').innerText();
    const n = Number(/(\d+) verified/.exec(txt)![1]);
    expect(n).toBeGreaterThanOrEqual(5); // 2 hole + 3 board
    if (shots) await a.page.screenshot({ path: `${shots}/fairness-${info.project.name}.png` });
    await a.page.keyboard.press('Escape');
    await expect(a.page.locator('.modal')).toHaveCount(0);
  } finally {
    for (const p of [a, b]) {
      await p.page.getByRole('button', { name: /Leave/ }).click({ timeout: 3000 }).catch(() => undefined);
    }
    await a.page.waitForTimeout(300);
    await a.ctx.close();
    await b.ctx.close();
  }
});

test('owner signs in with two-factor and opens the admin dashboard', async ({ page }) => {
  const s = seed();
  await login(page, s.owner.username, s.password);
  // Codes cannot be replayed, so wait for a fresh 30-second step that no earlier run could have used.
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  await page.getByLabel('Authenticator code').fill(totp(s.totpSecret));
  await page.getByRole('button', { name: /Verify/ }).click();
  await expect(page.locator('.wallet')).toBeVisible();
  await page.getByRole('link', { name: 'Admin' }).first().click();
  await expect(page.getByRole('navigation', { name: 'Administration' })).toBeVisible();
  await expect(page.locator('.tile').first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/admin-${test.info().project.name}.png`, fullPage: true });
});
