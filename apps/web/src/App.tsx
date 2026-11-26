import { lazy, Suspense, useEffect, useState } from 'react';
import { Crown, LogOut, Plus, Settings, Shield, Spade, Trophy, User, LayoutGrid } from 'lucide-react';
import { Link, match, useRouter } from './lib/router';
import { initials, Loading, useToast } from './lib/ui';
import { Logo } from './lib/Logo';
import { useSession } from './state/session';
import { api, credits } from './net/api';
import { getSocket } from './net/socket';
import { LoginPage, RegisterPage, ResetPasswordPage } from './features/auth/AuthPages';
import { LobbyPage } from './features/lobby/LobbyPage';
import { TablePage } from './features/table/TablePage';
import { ProfilePage } from './features/profile/ProfilePage';
import { LeaderboardsPage } from './features/social/LeaderboardsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { NotificationsButton } from './features/social/Notifications';

// The admin bundle is code-split and only fetched by staff.
const AdminPage = lazy(() => import('./features/admin/AdminPage'));

export function App() {
  const { me, loading } = useSession();
  const { path, navigate } = useRouter();
  const toast = useToast();

  useEffect(() => {
    if (!me) return;
    const s = getSocket();
    const onNotify = (n: { title: string; body?: string }) => toast({ title: n.title, body: n.body, tone: 'success' });
    s.on('notify', onNotify);
    return () => { s.off('notify', onNotify); };
  }, [me?.user.id, toast]);

  if (path === '/reset-password') return <ResetPasswordPage />;
  if (loading) return <Loading />;
  if (!me) return path === '/register' ? <RegisterPage /> : <LoginPage />;
  if (path === '/' || path === '/register') { queueMicrotask(() => navigate('/lobby', true)); return null; }

  let page: React.ReactNode;
  let p: Record<string, string> | null;
  if ((p = match('/table/:id', path))) return <Shell tableMode><TablePage tableId={p.id!} /></Shell>;
  else if (path === '/lobby') page = <LobbyPage />;
  else if ((p = match('/profile/:id', path))) page = <ProfilePage userId={p.id!} />;
  else if (path === '/leaderboards') page = <LeaderboardsPage />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path.startsWith('/admin')) page = <Suspense fallback={<Loading />}><AdminPage /></Suspense>;
  else page = <div className="empty"><strong>Page not found</strong><Link to="/lobby">Go to the lobby</Link></div>;

  return <Shell>{page}</Shell>;
}

function useOnline(enabled: boolean) {
  const [online, setOnline] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const load = () => api.get<{ online: number }>('/tables').then((r) => { if (!stop) setOnline(r.online); }).catch(() => undefined);
    void load();
    const first = setTimeout(load, 2500); // after this tab's own socket has joined
    const id = setInterval(load, 30_000);
    return () => { stop = true; clearTimeout(first); clearInterval(id); };
  }, [enabled]);
  return online;
}

function Shell({ children, tableMode = false }: { children: React.ReactNode; tableMode?: boolean }) {
  const { me, logout, can } = useSession();
  const { path, navigate } = useRouter();
  const [menu, setMenu] = useState(false);
  const online = useOnline(!!me);
  const tableMatch = match('/table/:id', path);
  const [lastTable, setLastTable] = useState<string | null>(() => { try { return sessionStorage.getItem('noir.lastTable'); } catch { return null; } });
  useEffect(() => {
    if (!tableMatch?.id) return;
    setLastTable(tableMatch.id);
    try { sessionStorage.setItem('noir.lastTable', tableMatch.id); } catch { /* private mode */ }
  }, [tableMatch?.id]);
  if (!me) return null;
  const pills = [
    { to: '/lobby', label: 'Lobby' },
    ...(lastTable ? [{ to: `/table/${lastTable}`, label: 'Table' }] : []),
    { to: '/leaderboards', label: 'Leaderboards' },
  ];
  const sections = [
    { title: 'Play', items: [
      { to: '/lobby', label: 'Lobby', icon: <LayoutGrid size={17} /> },
      { to: '/leaderboards', label: 'Leaderboards', icon: <Trophy size={17} /> },
    ] },
    { title: 'You', items: [
      { to: `/profile/${me.user.id}`, label: 'Profile', icon: <User size={17} /> },
      { to: '/settings', label: 'Settings & security', icon: <Settings size={17} /> },
    ] },
    ...(can('admin.access') ? [{ title: 'Staff', items: [{ to: '/admin', label: 'Admin', icon: <Shield size={17} /> }] }] : []),
  ];
  const mobileNav = [
    { to: '/lobby', label: 'Lobby', icon: <LayoutGrid size={18} /> },
    { to: '/leaderboards', label: 'Leaderboards', icon: <Trophy size={18} /> },
    { to: `/profile/${me.user.id}`, label: 'Profile', icon: <User size={18} /> },
    ...(can('admin.access') ? [{ to: '/admin', label: 'Admin', icon: <Shield size={18} /> }] : []),
  ];
  const active = (to: string) => (to.startsWith('/table/') ? path.startsWith('/table/') : path.startsWith(to));
  return (
    <div className={`shell ${tableMode ? 'table-mode' : ''}`}>
      <header className="topbar">
        <Link to="/lobby" className="brand" aria-label="NOIR lobby"><Logo size={38} withWord /></Link>
        <nav className="pillnav" aria-label="Sections">
          {pills.map((n) => <Link key={n.label} to={n.to} className={`pill ${active(n.to) ? 'active' : ''}`} aria-current={active(n.to) ? 'page' : undefined}>{n.label}</Link>)}
        </nav>
        <div className="topright">
          {online !== null && <span className="online mono hide-sm"><i className="dot on" /> {online} online</span>}
          <div className="wallet" title="Game credits. Non-redeemable, with no cash value."><Crown size={15} className="gold" /><span className="num mono">{credits(me.credits.wallet)}</span></div>
          <NotificationsButton />
          <div style={{ position: 'relative' }}>
            <button className="btn btn-ghost avatar-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span className="avatar sm">{initials(me.user.displayName)}</span>
              <span className="who hide-sm"><strong>{me.user.displayName}</strong><span className="label">{me.user.role}</span></span>
            </button>
            {menu && (
              <div className="menu card" role="menu" onMouseLeave={() => setMenu(false)}>
                <Link to="/settings" role="menuitem" className="menu-item" onClick={() => setMenu(false)}><Settings size={16} /> Settings & security</Link>
                <button role="menuitem" className="menu-item" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {me.user.staffMfaRequired && <div className="banner">Staff accounts must enable two-factor authentication before using admin tools. <Link to="/settings">Enable it now</Link></div>}
      {me.user.mustChangePassword && <div className="banner">Please set a new password in <Link to="/settings">Settings</Link>.</div>}
      <div className="frame">
        <aside className="sidebar card" aria-label="Main">
          {sections.map((s) => (
            <nav key={s.title} className="side-section" aria-label={s.title}>
              <span className="label">{s.title}</span>
              {s.items.map((n) => <Link key={n.to} to={n.to} className={`side-link ${active(n.to) ? 'active' : ''}`} aria-current={active(n.to) ? 'page' : undefined}>{n.icon}<span>{n.label}</span></Link>)}
            </nav>
          ))}
          <div className="side-promo">
            <Spade size={18} className="gold" />
            <strong>Your private table</strong>
            <p>Invite your circle with an access code. Game credits only.</p>
            <button className="btn btn-primary btn-sm btn-block" onClick={() => navigate('/lobby?create=1')}><Plus size={14} /> Create private table</button>
          </div>
          <p className="label side-foot">NOIR v0.1.0 · game credits only</p>
        </aside>
        <main className="page">{children}</main>
      </div>
      <nav className="bottomnav" aria-label="Main">
        {mobileNav.map((n) => <Link key={n.to} to={n.to} className={`bnav ${active(n.to) ? 'active' : ''}`}>{n.icon}<span>{n.label}</span></Link>)}
      </nav>
    </div>
  );
}
