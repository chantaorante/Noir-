/**
 * Tracks live sockets per session/user so revocations take effect immediately.
 * Kept free of Socket.IO imports so HTTP modules can call it without a cycle.
 */
type Disconnectable = { disconnect: (close?: boolean) => void; emit: (ev: string, ...args: unknown[]) => void };

const bySession = new Map<string, Set<Disconnectable>>();

export function registerSocket(sessionId: string, s: Disconnectable): () => void {
  let set = bySession.get(sessionId);
  if (!set) bySession.set(sessionId, (set = new Set()));
  set.add(s);
  return () => {
    set!.delete(s);
    if (set!.size === 0) bySession.delete(sessionId);
  };
}

export function disconnectSessions(sessionIds: Iterable<string>): void {
  for (const id of sessionIds) {
    for (const s of bySession.get(id) ?? []) {
      s.emit('session:revoked');
      s.disconnect(true);
    }
  }
}
