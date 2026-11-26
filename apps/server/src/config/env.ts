import { z } from 'zod';

const WEAK = /^(changeme|password|secret|noir|admin|test|dev)$/i;

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  /** Public origin(s) allowed for CSRF/WS origin checks, comma-separated, e.g. https://noir.lan,https://poker.example.com */
  PUBLIC_ORIGINS: z.string().min(1),
  /** 32-byte hex key: encrypts TOTP secrets at rest. */
  NOIR_DATA_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'NOIR_DATA_KEY must be 64 hex chars (openssl rand -hex 32)'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  TRUST_PROXY: z.enum(['true', 'false']).default('true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STATIC_DIR: z.string().optional(),
  /** Pause between hands (ms). Also the window for player entropy contributions. */
  HAND_PAUSE_MS: z.coerce.number().int().min(0).max(30000).default(3500),
  /** Login/registration attempts per IP per minute. */
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(10),
  HAND_SECRET_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    const pw = /:\/\/[^:]+:([^@]+)@/.exec(e.DATABASE_URL)?.[1] ?? '';
    if (pw.length < 16 || WEAK.test(pw)) throw new Error('Refusing to start: database password is missing or weak.');
    if (/^0+$/.test(e.NOIR_DATA_KEY)) throw new Error('Refusing to start: NOIR_DATA_KEY is a default value.');
    if (e.COOKIE_SECURE !== 'true') throw new Error('Refusing to start: COOKIE_SECURE must be true in production.');
  }
  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    origins: e.PUBLIC_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    dataKey: Buffer.from(e.NOIR_DATA_KEY, 'hex'),
    cookieSecure: e.COOKIE_SECURE === 'true',
    trustProxy: e.TRUST_PROXY === 'true',
    logLevel: e.LOG_LEVEL,
    staticDir: e.STATIC_DIR,
    handPauseMs: e.HAND_PAUSE_MS,
    handSecretRetentionDays: e.HAND_SECRET_RETENTION_DAYS,
    loginRateLimit: e.LOGIN_RATE_LIMIT,
  };
}
