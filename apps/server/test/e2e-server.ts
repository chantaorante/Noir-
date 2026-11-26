/**
 * Starts a disposable NOIR instance for browser (Playwright) tests.
 * DESTRUCTIVE TO ITS OWN DATABASE ONLY: it drops and recreates the schema of E2E_DATABASE_URL,
 * which must name a database containing "e2e" so it can never point at real data.
 * Seeds: owner (with MFA, secret written to e2e-seed.json), players alice and bob with credits,
 * and one public table. Serves the built SPA from apps/web/dist.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/env.js';
import { createPool, withTx } from '../src/db/pool.js';
import { createNoir } from '../src/server.js';
import { encryptSecret, newTotpSecret } from '../src/modules/auth/crypto.js';
import { insertUser } from '../src/modules/auth/users.js';
import { postEntry } from '../src/modules/ledger/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://noir:noir_dev_only@localhost:5432/noir_e2e';
const PORT = Number(process.env.E2E_PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
export const PASSWORD = 'Correct-Horse-Battery-9';
if (!/e2e/.test(new URL(DB).pathname)) throw new Error('E2E_DATABASE_URL must name an e2e database');

const reset = createPool(DB, 1);
await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await reset.end();

const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: DB, PUBLIC_ORIGINS: `${ORIGIN},http://localhost:${PORT}`, NOIR_DATA_KEY: randomBytes(32).toString('hex'),
  COOKIE_SECURE: 'false', TRUST_PROXY: 'false', HOST: '127.0.0.1', PORT: String(PORT), HAND_PAUSE_MS: '1500',
  LOG_LEVEL: 'warn', LOGIN_RATE_LIMIT: '1000', STATIC_DIR: path.resolve(here, '../../web/static'),
});
const noir = await createNoir(config, { listen: true });

const totpSecret = newTotpSecret();
const seed = await withTx(noir.db, async (tx) => {
  const owner = await insertUser(tx, { username: 'owner', displayName: 'Owner', role: 'owner', password: PASSWORD });
  await tx.query('UPDATE user_credentials SET totp_secret_enc = $2, totp_enabled = true WHERE user_id = $1', [owner.id, encryptSecret(config.dataKey, totpSecret)]);
  const players = [];
  for (const name of ['alice', 'bob']) {
    const u = await insertUser(tx, { username: name, displayName: name[0]!.toUpperCase() + name.slice(1), role: 'player', password: PASSWORD });
    await postEntry(tx, { userId: u.id, amount: 10_000, type: 'ADMIN_GRANT', reason: 'e2e seed', adminId: owner.id });
    players.push({ id: u.id, username: name });
  }
  return { owner: { id: owner.id, username: 'owner' }, players };
});
const table = await noir.tables.create({ name: 'Velvet Room', maxSeats: 6, smallBlind: 5, bigBlind: 10, ante: 0, minBuyIn: 200, maxBuyIn: 2000, actionSeconds: 30, isPrivate: false }, seed.owner.id, false);
writeFileSync(path.resolve(here, '../../web/e2e/.seed.json'), JSON.stringify({ origin: ORIGIN, password: PASSWORD, totpSecret, tableId: table.summary().id, ...seed }, null, 2));
process.stdout.write(`E2E NOIR ready on ${ORIGIN}\n`);
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, async () => { await noir.close(); process.exit(0); });
