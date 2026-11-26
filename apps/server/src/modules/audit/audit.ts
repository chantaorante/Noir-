import { createHash } from 'node:crypto';
import { canonicalJson, GENESIS_HASH } from '@noir/engine';
import type { Queryable } from '../../db/pool.js';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append to the hash-chained admin audit log. Must be called inside the same transaction as the
 * change it records. A transaction-level advisory lock serializes chain appends.
 */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(7243002)');
  const prev = (await q.query<{ hash: string }>('SELECT hash FROM admin_audit_log ORDER BY id DESC LIMIT 1')).rows[0]?.hash ?? GENESIS_HASH;
  const createdAt = new Date().toISOString();
  const body = { actorId: e.actorId, action: e.action, targetType: e.targetType ?? null, targetId: e.targetId ?? null, details: e.details ?? {}, createdAt };
  const hash = createHash('sha256').update(prev).update(canonicalJson(body)).digest('hex');
  await q.query(
    `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, details, ip, prev_hash, hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.actorId, e.action, body.targetType, body.targetId, body.details, e.ip ?? null, prev, hash, createdAt],
  );
}

export async function securityEvent(q: Queryable, kind: string, severity: 'info' | 'warn' | 'high', details: Record<string, unknown> = {}, userId: string | null = null, ip: string | null = null): Promise<void> {
  await q.query('INSERT INTO security_events (kind, severity, user_id, ip, details) VALUES ($1,$2,$3,$4,$5)', [kind, severity, userId, ip, details]);
}

/** Verify the whole audit chain; returns the id of the first broken row, or null if intact. */
export async function verifyAuditChain(q: Queryable): Promise<number | null> {
  const rows = (await q.query<{ id: number; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown>; prev_hash: string; hash: string; created_at: Date }>('SELECT * FROM admin_audit_log ORDER BY id')).rows;
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const body = { actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id, details: r.details, createdAt: r.created_at.toISOString() };
    const h = createHash('sha256').update(prev).update(canonicalJson(body)).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return r.id;
    prev = r.hash;
  }
  return null;
}
