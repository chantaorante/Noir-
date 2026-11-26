import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { AppDeps } from './context.js';
import { HttpError } from './errors.js';
import { resolveSession, SESSION_COOKIE } from '../modules/auth/sessions.js';
import { safeEqual } from '../modules/auth/crypto.js';
import { securityEvent } from '../modules/audit/audit.js';
import { authRoutes } from '../modules/auth/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { lobbyRoutes } from '../modules/lobby/routes.js';
import { socialRoutes } from '../modules/social/routes.js';
import { healthRoutes } from '../modules/health/routes.js';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss: ws:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export async function buildApp(deps: AppDeps, extra?: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
    disableRequestLogging: false,
  });

  await app.register(cookie);
  app.decorateRequest('auth', null);

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.cookies?.[SESSION_COOKIE]?.slice(0, 16) ?? req.ip,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' }),
  });

  // Security headers on every response.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (_req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Authenticate from the session cookie, then enforce CSRF + Origin on state-changing requests.
  app.addHook('preHandler', async (req) => {
    req.auth = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && !config.origins.includes(origin)) {
      await securityEvent(db, 'origin_rejected', 'warn', { origin, url: req.url }, req.auth?.user.id ?? null, req.ip);
      throw new HttpError(403, 'BAD_ORIGIN', 'Request origin not allowed.');
    }
    // A custom header forces a CORS preflight for cross-site requests, which this server never approves.
    if (req.headers['x-noir-client'] !== '1') throw new HttpError(403, 'CSRF', 'Missing client header.');
    if (req.auth) {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || !safeEqual(token, req.auth.session.csrf)) {
        await securityEvent(db, 'csrf_rejected', 'warn', { url: req.url }, req.auth.user.id, req.ip);
        throw new HttpError(403, 'CSRF', 'Security token missing or invalid. Please reload the page.');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Invalid request.', code: 'VALIDATION' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: status === 429 ? 'Too many requests. Please slow down.' : 'Invalid request.', code: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST' });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'Something went wrong on our side.', code: 'INTERNAL', requestId: req.id });
  });

  await app.register(healthRoutes(deps));
  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(lobbyRoutes(deps), { prefix: '/api' });
  await app.register(socialRoutes(deps), { prefix: '/api' });
  await app.register(adminRoutes(deps), { prefix: '/api/admin' });
  if (extra) await extra(app);

  // Serve the web client (plain HTML/CSS/JS in apps/web/static); unknown paths get index.html.
  if (config.staticDir && existsSync(config.staticDir)) {
    const root = path.resolve(config.staticDir);
    app.get('/*', async (req, reply) => {
      const rel = decodeURIComponent((req.params as { '*': string })['*'] || 'index.html');
      let file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
      const ext = path.extname(file);
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
      reply.type(types[ext] ?? 'application/octet-stream');
      // Plain files without content hashes: fonts and vendored libraries rarely change, everything else is revalidated.
      reply.header('Cache-Control', rel.startsWith('fonts/') || rel.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache');
      return reply.send(createReadStream(file));
    });
  }
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found.', code: 'NOT_FOUND' }));
  return app;
}
