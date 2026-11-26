/**
 * First-run bootstrap: creates the Owner account and prints a one-time setup link.
 * Usage: node dist/cli/create-owner.js <username> "<Display Name>"
 * Refuses to run if an Owner already exists.
 */
import { createPool, withTx } from '../db/pool.js';
import { newToken, sha256 } from '../modules/auth/crypto.js';
import { insertUser } from '../modules/auth/users.js';
import { audit } from '../modules/audit/audit.js';

const [username, displayName] = process.argv.slice(2);
if (!username || !displayName) {
  console.error('Usage: create-owner <username> "<Display Name>"');
  process.exit(2);
}
const db = createPool(process.env.DATABASE_URL!, 2);
const exists = await db.query(`SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'owner'`);
if (exists.rowCount) {
  console.error('An Owner account already exists. Refusing to create another.');
  process.exit(1);
}
const token = newToken(32);
await withTx(db, async (tx) => {
  const u = await insertUser(tx, { username, displayName, role: 'owner', password: newToken(24), mustChangePassword: true });
  await tx.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '24 hours')`, [u.id, sha256(token)]);
  await audit(tx, { actorId: null, action: 'owner.bootstrap', targetType: 'user', targetId: u.id });
});
console.log(`Owner "${username}" created.\nOpen this link within 24 hours to set the password, then enable two-factor authentication:\n  <your NOIR address>/reset-password#${token}`);
await db.end();
