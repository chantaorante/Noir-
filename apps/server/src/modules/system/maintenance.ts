import type { Queryable } from '../../db/pool.js';

/**
 * Maintenance mode. While enabled: no new hands start (running hands finish normally), nobody can take a seat,
 * and only staff can sign in. Held in memory (single app process) and refreshed from app_config.
 */
let state = { enabled: false, message: '' };

export const getMaintenance = () => state;

export async function refreshMaintenance(db: Queryable) {
  const v = (await db.query(`SELECT value FROM app_config WHERE key = 'maintenance'`)).rows[0]?.value as { enabled?: boolean; message?: string } | undefined;
  const was = state.enabled;
  state = { enabled: v?.enabled === true, message: typeof v?.message === 'string' ? v.message : '' };
  return { changed: was !== state.enabled, state };
}
