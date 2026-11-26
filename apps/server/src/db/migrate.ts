import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './pool.js';

/**
 * Forward-only SQL migrations. Each file runs in its own transaction; its SHA-256 is recorded and
 * verified on every start so an edited, already-applied migration is detected rather than ignored.
 */
export async function migrate(db: Db, dir: string, log: (m: string) => void = () => undefined): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied = new Map((await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
  const ran: string[] = [];
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(f);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${f} was modified after being applied (checksum mismatch).`);
      continue;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7243001)');
      const again = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
        ran.push(f);
        log(`applied migration ${f}`);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${f} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
