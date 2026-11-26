import type { Tx } from '../../db/pool.js';
import { conflict } from '../../http/errors.js';
import { hashPassword } from './crypto.js';

export interface NewUser {
  username: string;
  displayName: string;
  email?: string | null;
  role: 'owner' | 'admin' | 'moderator' | 'player';
  password: string;
  mustChangePassword?: boolean;
}

export async function insertUser(tx: Tx, u: NewUser): Promise<{ id: string; publicId: number }> {
  const passwordHash = await hashPassword(u.password);
  try {
    const r = await tx.query<{ id: string; public_id: number }>(
      `INSERT INTO users (username, email, role_id) VALUES ($1, $2, (SELECT id FROM roles WHERE key = $3)) RETURNING id, public_id`,
      [u.username, u.email ?? null, u.role],
    );
    const id = r.rows[0]!.id;
    await tx.query('INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1, $2, $3)', [id, passwordHash, u.mustChangePassword ?? false]);
    await tx.query('INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)', [id, u.displayName]);
    await tx.query('INSERT INTO user_progress (user_id) VALUES ($1)', [id]);
    await tx.query('INSERT INTO player_stats (user_id) VALUES ($1)', [id]);
    await tx.query('INSERT INTO level_history (user_id, level) VALUES ($1, 1)', [id]);
    return { id, publicId: r.rows[0]!.public_id };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('That username or email is already taken.', 'TAKEN');
    throw err;
  }
}
