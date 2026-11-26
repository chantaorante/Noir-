import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Config } from '../config/env.js';
import type { Db } from '../db/pool.js';
import type { TableManager } from '../modules/tables/manager.js';
import type { AuthContext } from '../modules/auth/sessions.js';
import { hasRecentMfa, isStaff } from '../modules/auth/sessions.js';
import { badRequest, forbidden, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AppDeps {
  config: Config;
  db: Db;
  tables: TableManager;
  /** Live stats provided by the realtime layer once started. */
  live: { online: () => number; toTable: (tableId: string, ev: string, data: unknown) => void; toUser: (userId: string, ev: string, data: unknown) => void };
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; '), 'VALIDATION');
  return r.data;
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * Permission guard. Staff must have MFA enrolled to use any permission; high-risk operations also
 * require a recent MFA step-up on this session.
 */
export function guard(permission: string, opts: { stepUp?: boolean } = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const a = requireAuth(req);
    if (!a.user.permissions.has(permission)) throw forbidden();
    if (isStaff(a.user) && !a.user.mfaEnabled) throw forbidden('Two-factor authentication must be enabled for staff accounts.', 'MFA_REQUIRED');
    if (opts.stepUp && !hasRecentMfa(a.session)) throw forbidden('Please confirm with your authenticator code.', 'STEP_UP_REQUIRED');
  };
}

export const clientIp = (req: FastifyRequest) => req.ip ?? null;
