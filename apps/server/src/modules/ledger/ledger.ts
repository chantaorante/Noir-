import type { Queryable, Tx } from '../../db/pool.js';
import { HttpError } from '../../http/errors.js';

export type EntryType = 'ADMIN_GRANT' | 'ADMIN_CORRECTION' | 'TABLE_BUY_IN' | 'TABLE_CASH_OUT' | 'TOURNAMENT_ENTRY' | 'TOURNAMENT_REFUND' | 'SIGNUP_BONUS' | 'HAND_VOID_REFUND';

export interface PostEntry {
  userId: string;
  amount: number;
  type: EntryType;
  reason?: string | null;
  adminId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LedgerRow {
  id: string;
  seq: number;
  amount: number;
  balance_before: number;
  balance_after: number;
  entry_type: EntryType;
  reason: string | null;
  admin_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: Date;
}

export class InsufficientCredits extends HttpError {
  constructor() {
    super(409, 'INSUFFICIENT_CREDITS', 'Not enough credits for that.');
  }
}

/**
 * Append one ledger entry. MUST run inside a transaction (tx). Serializes per user by locking the
 * user row, derives balance_before from the latest entry, and relies on UNIQUE(user_id, seq) +
 * CHECK(balance_after >= 0) as a second line of defence.
 * Idempotent: re-posting the same idempotencyKey returns the original entry.
 */
export async function postEntry(tx: Tx, e: PostEntry): Promise<LedgerRow> {
  if (!Number.isSafeInteger(e.amount) || e.amount === 0) throw new Error('ledger amount must be a non-zero safe integer');
  if (e.idempotencyKey) {
    const existing = await tx.query<LedgerRow>('SELECT * FROM credit_ledger WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].amount !== e.amount || (existing.rows[0] as unknown as { user_id: string }).user_id !== e.userId) throw new HttpError(409, 'IDEMPOTENCY_MISMATCH', 'This request was already used with different details.');
      return existing.rows[0];
    }
  }
  const locked = await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [e.userId]);
  if (locked.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  const last = await tx.query<{ seq: number; balance_after: number }>('SELECT seq, balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 1', [e.userId]);
  const before = last.rows[0]?.balance_after ?? 0;
  const seq = (last.rows[0]?.seq ?? 0) + 1;
  const after = before + e.amount;
  if (after < 0) throw new InsufficientCredits();
  const r = await tx.query<LedgerRow>(
    `INSERT INTO credit_ledger (user_id, seq, amount, entry_type, balance_before, balance_after, reason, admin_id, reference_type, reference_id, idempotency_key, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [e.userId, seq, e.amount, e.type, before, after, e.reason ?? null, e.adminId ?? null, e.referenceType ?? null, e.referenceId ?? null, e.idempotencyKey ?? null, e.metadata ?? {}],
  );
  return r.rows[0]!;
}

export async function balanceOf(q: Queryable, userId: string): Promise<number> {
  const r = await q.query<{ balance_after: number }>('SELECT balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY seq DESC LIMIT 1', [userId]);
  return r.rows[0]?.balance_after ?? 0;
}

/** Credits currently sitting on tables (not in the wallet). */
export async function onTables(q: Queryable, userId: string): Promise<number> {
  const r = await q.query<{ s: number | null }>('SELECT COALESCE(SUM(stack),0)::bigint AS s FROM table_sessions WHERE user_id = $1 AND left_at IS NULL', [userId]);
  return r.rows[0]?.s ?? 0;
}

/**
 * Full-chain verification for one user: seq contiguous, each balance_before equals the previous
 * balance_after, and balance_after = before + amount. Returns the first bad seq or null.
 */
export async function verifyUserLedger(q: Queryable, userId: string): Promise<number | null> {
  const rows = (await q.query<{ seq: number; amount: number; balance_before: number; balance_after: number }>('SELECT seq, amount, balance_before, balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY seq', [userId])).rows;
  let prev = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.seq !== i + 1 || r.balance_before !== prev || r.balance_after !== r.balance_before + r.amount) return r.seq;
    prev = r.balance_after;
  }
  return null;
}
