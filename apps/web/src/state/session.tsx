import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrf } from '../net/api';
import { closeSocket, getSocket } from '../net/socket';

export interface Me {
  csrf: string;
  user: { id: string; publicId: number; username: string; displayName: string; role: string; mfaEnabled: boolean; mustChangePassword: boolean; permissions: string[]; staffMfaRequired: boolean };
  credits: { wallet: number; onTables: number; denomination: string };
  progress: { xp: number; level: number; rank: string; levelXp: number; nextLevelXp: number | null } | null;
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void>; can: (p: string) => boolean }>({
  me: null, loading: true, refresh: async () => {}, logout: async () => {}, can: () => false,
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('/auth/me');
      setCsrf(m.csrf);
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setMe(null); closeSocket(); }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!me) return;
    const s = getSocket();
    const onRevoked = () => { setMe(null); closeSocket(); };
    const onCredits = () => void refresh();
    s.on('session:revoked', onRevoked);
    s.on('credits:changed', onCredits);
    s.on('table:left', onCredits);
    return () => { s.off('session:revoked', onRevoked); s.off('credits:changed', onCredits); s.off('table:left', onCredits); };
  }, [me?.user.id, refresh]);
  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    closeSocket();
    setMe(null);
  }, []);
  const can = useCallback((p: string) => !!me?.user.permissions.includes(p), [me]);
  return <Ctx.Provider value={{ me, loading, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
