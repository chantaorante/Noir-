import { io, type Socket } from 'socket.io-client';
import type { Ack } from '@noir/shared';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/ws', transports: ['websocket', 'polling'], withCredentials: true, reconnectionDelay: 500, reconnectionDelayMax: 5000 });
  }
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

export function emit<T = unknown>(event: string, payload?: unknown, timeoutMs = 8000): Promise<Ack<T>> {
  const s = getSocket();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'The server did not respond in time.', code: 'TIMEOUT' }), timeoutMs);
    const cb = (a: Ack<T>) => { clearTimeout(t); resolve(a); };
    if (payload === undefined) s.emit(event, cb);
    else s.emit(event, payload, cb);
  });
}
