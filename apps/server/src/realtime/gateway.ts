import { getMaintenance } from '../modules/system/maintenance.js';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { WsAction, WsChatSend, WsEntropy, WsLeave, WsRebuy, WsSit, WsSitOut, WsWatchTable, type Ack } from '@noir/shared';
import type { z } from 'zod';
import type { Config } from '../config/env.js';
import type { Db } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { resolveSession, SESSION_COOKIE, type AuthContext } from '../modules/auth/sessions.js';
import { securityEvent } from '../modules/audit/audit.js';
import { ChatService } from '../modules/chat/chat.js';
import type { Emitter } from '../modules/tables/actor.js';
import { TableManager } from '../modules/tables/manager.js';
import { registerSocket } from './registry.js';

/** Token bucket per socket. */
class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly burst: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export interface Realtime {
  io: Server;
  tables: TableManager;
  emitter: Emitter;
  online(): number;
}

/** Emitter that buffers nothing and forwards once the Socket.IO server exists. */
export class EmitterProxy implements Emitter {
  target: Emitter | null = null;
  toTable(tableId: string, ev: string, data: unknown) { this.target?.toTable(tableId, ev, data); }
  toUser(userId: string, ev: string, data: unknown) { this.target?.toUser(userId, ev, data); }
  lobbyChanged(tableId: string) { this.target?.lobbyChanged(tableId); }
}

export async function createRealtime(server: HttpServer, deps: { config: Config; db: Db; tables: TableManager; proxy: EmitterProxy; log: (m: string, e?: unknown) => void }): Promise<Realtime> {
  const { config, db, tables } = deps;
  const io = new Server(server, {
    path: '/ws',
    serveClient: false,
    maxHttpBufferSize: 4096,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    cors: { origin: config.origins, credentials: true },
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, !origin || config.origins.includes(origin));
    },
  });

  let lobbyTimer: NodeJS.Timeout | null = null;
  const emitter: Emitter = {
    toTable: (tableId, ev, data) => io.to(`table:${tableId}`).emit(ev, data),
    toUser: (userId, ev, data) => io.to(`user:${userId}`).emit(ev, data),
    lobbyChanged: () => {
      // Coalesce lobby updates (at most 2/s).
      if (lobbyTimer) return;
      lobbyTimer = setTimeout(() => {
        lobbyTimer = null;
        io.to('lobby').emit('lobby:tables', tables.list().filter((t) => !t.row.is_private).map((t) => t.summary()));
      }, 500);
    },
  };
  deps.proxy.target = emitter;
  const chat = new ChatService(db);

  io.use(async (socket, next) => {
    try {
      const auth = await resolveSession(db, parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE));
      if (!auth) return next(new Error('UNAUTHORIZED'));
      (socket.data as { auth: AuthContext }).auth = auth;
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  io.on('connection', (socket: Socket) => {
    const auth = (socket.data as { auth: AuthContext }).auth;
    const userId = auth.user.id;
    const unregister = registerSocket(auth.session.id, socket);
    void socket.join(`user:${userId}`);
    const bucket = new Bucket(20, 40);
    let strikes = 0;
    const watching = new Set<string>();

    // Presence: any table where this user is seated becomes "connected".
    for (const t of tables.list()) if (t.seatOf(userId)) void t.setConnected(userId, true);

    function on<S extends z.ZodType>(event: string, schema: S, handler: (data: z.infer<S>) => Promise<unknown>) {
      socket.on(event, async (raw: unknown, ack?: (a: Ack) => void) => {
        const reply = typeof ack === 'function' ? ack : () => undefined;
        if (!bucket.take()) {
          if (++strikes > 50) {
            await securityEvent(db, 'ws_flood', 'warn', { event }, userId).catch(() => undefined);
            socket.disconnect(true);
          }
          return reply({ ok: false, error: 'Too many requests.', code: 'RATE_LIMITED' });
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          await securityEvent(db, 'ws_invalid_payload', 'info', { event }, userId).catch(() => undefined);
          return reply({ ok: false, error: 'Invalid request.', code: 'VALIDATION' });
        }
        try {
          const data = await handler(parsed.data);
          reply(data === undefined ? { ok: true } : (data as Ack));
        } catch (err) {
          if (err instanceof HttpError) return reply({ ok: false, error: err.message, code: err.code });
          deps.log('socket handler error', err);
          reply({ ok: false, error: 'Something went wrong.', code: 'INTERNAL' });
        }
      });
    }

    socket.on('lobby:subscribe', (ack?: (a: Ack) => void) => {
      void socket.join('lobby');
      if (typeof ack === 'function') ack({ ok: true, data: tables.list().filter((t) => !t.row.is_private || t.canView(userId)).map((t) => t.summary()) });
    });

    on('table:watch', WsWatchTable.extend({ accessCode: WsSit.shape.accessCode }), async ({ tableId, accessCode }) => {
      const t = tables.get(tableId);
      await tables.unlock(t, userId, accessCode);
      await socket.join(`table:${tableId}`);
      watching.add(tableId);
      if (t.seatOf(userId)) await t.setConnected(userId, true);
      return { ok: true, data: t.snapshot(userId) };
    });

    on('table:unwatch', WsWatchTable, async ({ tableId }) => {
      await socket.leave(`table:${tableId}`);
      watching.delete(tableId);
    });

    on('table:sit', WsSit, async ({ tableId, seat, buyIn, accessCode }) => {
      if (getMaintenance().enabled) throw new HttpError(503, 'MAINTENANCE', getMaintenance().message || 'NOIR is in maintenance. Tables reopen shortly.');
      const t = tables.get(tableId);
      await tables.unlock(t, userId, accessCode);
      await t.sit(userId, seat, buyIn);
      await socket.join(`table:${tableId}`);
      watching.add(tableId);
      return { ok: true, data: t.snapshot(userId) };
    });

    on('table:leave', WsLeave, async ({ tableId }) => tables.get(tableId).leave(userId));
    on('table:sitout', WsSitOut, async ({ tableId, sitOut }) => tables.get(tableId).setSitOut(userId, sitOut));
    on('table:rebuy', WsRebuy, async ({ tableId, amount }) => tables.get(tableId).rebuy(userId, amount));
    on('table:entropy', WsEntropy, async ({ tableId, commitId, entropy }) => {
      await tables.get(tableId).contributeEntropy(userId, commitId, entropy);
      return { ok: true, data: { commitId, included: true } };
    });
    on('table:action', WsAction, async (p) => {
      const t = tables.get(p.tableId);
      const r = await t.act(userId, p);
      if (!r.ok && r.code === 'STALE') socket.emit('table:snapshot', t.snapshot(userId));
      return r.ok ? { ok: true } : r;
    });
    on('table:snapshot', WsWatchTable, async ({ tableId }) => {
      const t = tables.get(tableId);
      if (!t.canView(userId)) throw new HttpError(403, 'PRIVATE', 'This is a private table.');
      return { ok: true, data: t.snapshot(userId) };
    });

    on('chat:send', WsChatSend, async ({ channel, body }) => {
      if (channel !== 'lobby') {
        const tableId = channel.slice(6);
        if (!watching.has(tableId)) throw new HttpError(403, 'NOT_WATCHING', 'Join the table to chat.');
      }
      const msg = await chat.send(auth.user, channel, body);
      io.to(channel).emit('chat:message', msg);
    });
    on('chat:history', WsChatSend.pick({ channel: true }), async ({ channel }) => {
      if (channel !== 'lobby' && !watching.has(channel.slice(6))) throw new HttpError(403, 'NOT_WATCHING', 'Join the table to chat.');
      return { ok: true, data: await chat.history(channel, userId) };
    });

    socket.on('disconnect', () => {
      unregister();
      // Only mark disconnected when the user's last socket closes.
      const room = io.sockets.adapter.rooms.get(`user:${userId}`);
      if (!room || room.size === 0) for (const t of tables.list()) if (t.seatOf(userId)) void t.setConnected(userId, false);
    });
  });

  return { io, tables, emitter, online: () => { let n = 0; for (const k of io.sockets.adapter.rooms.keys()) if (k.startsWith('user:')) n++; return n; } }; // unique signed-in users
}
