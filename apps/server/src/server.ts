import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config/env.js';
import { createPool, type Db } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { createRealtime, EmitterProxy, type Realtime } from './realtime/gateway.js';
import { TableManager } from './modules/tables/manager.js';

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export interface Noir {
  app: FastifyInstance;
  db: Db;
  rt: Realtime;
  tables: TableManager;
  close(): Promise<void>;
}

/** Compose the whole server. Used by main.ts and by integration tests. */
export async function createNoir(config: Config, opts: { listen?: boolean; db?: Db } = {}): Promise<Noir> {
  const db = opts.db ?? createPool(config.databaseUrl);
  await migrate(db, MIGRATIONS_DIR, (m) => process.stdout.write(`[migrate] ${m}\n`));
  const proxy = new EmitterProxy();
  const log = (m: string, e?: unknown) => process.stderr.write(`[noir] ${m} ${e instanceof Error ? e.stack : e ? JSON.stringify(e) : ''}\n`);
  const tables = new TableManager(db, proxy, { handPauseMs: config.handPauseMs, log });
  let rt: Realtime | null = null;
  const live = {
    online: () => rt?.online() ?? 0,
    toTable: (t: string, ev: string, d: unknown) => proxy.toTable(t, ev, d),
    toUser: (u: string, ev: string, d: unknown) => proxy.toUser(u, ev, d),
  };
  const app = await buildApp({ config, db, tables, live });
  rt = await createRealtime(app.server, { config, db, tables, proxy, log });
  const boot = await tables.start();
  if (boot.voided) log(`voided ${boot.voided} hand(s) interrupted by restart; players keep their pre-hand stacks`);
  // Daily retention: purge secret deck material and old login/security telemetry.
  const retention = async () => {
    await db.query(`DELETE FROM hand_secrets WHERE created_at < now() - make_interval(days => $1)`, [config.handSecretRetentionDays]);
    await db.query(`DELETE FROM login_events WHERE created_at < now() - interval '180 days'`);
    await db.query(`DELETE FROM security_events WHERE created_at < now() - interval '180 days'`);
    await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days'`);
  };
  const retentionTimer = setInterval(() => void retention().catch((e) => log('retention failed', e)), 24 * 3600_000);
  retentionTimer.unref();
  void retention().catch((e) => log('retention failed', e));
  if (opts.listen !== false) await app.listen({ host: config.host, port: config.port });
  else await app.ready();
  return {
    app, db, rt, tables,
    async close() {
      clearInterval(retentionTimer);
      await tables.shutdown();
      await new Promise<void>((r) => rt!.io.close(() => r()));
      await app.close().catch(() => undefined);
      if (!opts.db) await db.end();
    },
  };
}
