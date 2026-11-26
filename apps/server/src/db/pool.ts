import pg from 'pg';

// BIGINT (int8) → JS number. Credit amounts are capped far below 2^53 by validation and DB checks.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('int8 out of safe range');
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(url: string, max = 20): Db {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, statement_timeout: 10_000, application_name: 'noir' });
  pool.on('error', (err) => {
    // Idle client errors (e.g. DB restart) must not crash the process; the pool reconnects.
    process.stderr.write(`[db] idle client error: ${err.message}\n`);
  });
  return pool;
}

/** Run fn inside a transaction. Retries once on serialization failure / deadlock. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (attempt < 2 && (code === '40001' || code === '40P01')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
