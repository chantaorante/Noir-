import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../http/context.js';

export function healthRoutes({ db }: AppDeps) {
  return async (app: FastifyInstance) => {
    /** Liveness: process is up. */
    app.get('/healthz', async () => ({ ok: true }));
    /** Readiness: database reachable and migrated. */
    app.get('/readyz', async (_req, reply) => {
      try {
        const t0 = Date.now();
        const r = await db.query('SELECT count(*)::int AS n FROM schema_migrations');
        return { ok: true, migrations: r.rows[0].n, dbLatencyMs: Date.now() - t0 };
      } catch {
        return reply.status(503).send({ ok: false, error: 'database unavailable' });
      }
    });
    app.get('/api/status', async () => {
      const m = (await db.query(`SELECT value FROM app_config WHERE key = 'maintenance'`)).rows[0]?.value ?? { enabled: false };
      return { maintenance: m, denomination: 'ALL', disclaimer: 'Game credits only. Non-redeemable, with no cash value.' };
    });
  };
}
