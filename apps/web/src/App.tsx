import { lazy, Suspense, useEffect, useState } from 'react';
import { Crown, LogOut, Settings, Shield, Trophy, User, LayoutGrid } from 'lucide-react';
import { Link, match, useRouter } from './lib/router';
import { Loading, useToast } from './lib/ui';
import { Logo } from './lib/Logo';
import { useSession } from './state/session';
import { credits } from './net/api';
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
  if ((p = match('/table/:id', path))) return <TablePage tableId={p.id!} />;
  else if (path === '/lobby') page = <LobbyPage />;
  else if ((p = match('/profile/:id', path))) page = <ProfilePage userId={p.id!} />;
  else if (path === '/leaderboards') page = <LeaderboardsPage />;
  else if (path === '/settings') page = <SettingsPage />;
  else if (path.startsWith('/admin')) page = <Suspense fallback={<Loading />}><AdminPage /></Suspense>;
  else page = <div className="empty"><strong>Page not found</strong><Link to="/lobby">Go to the lobby</Link></div>;

  return <Shell>{page}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { me, logout, can } = useSession();
  const { path } = useRouter();
  const [menu, setMenu] = useState(false);
  if (!me) return null;
  const nav = [
    { to: '/lobby', label: 'Lobby', icon: <LayoutGrid size={18} /> },
    { to: '/leaderboards', label: 'Leaderboards', icon: <Trophy size={18} /> },
    { to: `/profile/${me.user.id}`, label: 'Profile', icon: <User size={18} /> },
    ...(can('admin.access') ? [{ to: '/admin', label: 'Admin', icon: <Shield size={18} /> }] : []),
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/lobby" className="brand" aria-label="NOIR lobby"><Logo size={30} withWord /></Link>
        <nav className="topnav" aria-label="Main">
          {nav.map((n) => <Link key={n.to} to={n.to} className={`navlink ${path.startsWith(n.to) ? 'active' : ''}`} aria-current={path.startsWith(n.to) ? 'page' : undefined}>{n.icon}<span>{n.label}</span></Link>)}
        </nav>
        <div className="topright">
          <div className="wallet" title="Game credits. Non-redeemable, with no cash value."><Crown size={16} className="gold" /><span className="num">{credits(me.credits.wallet)}</span></div>
          <NotificationsButton />
          <div style={{ position: 'relative' }}>
            <button className="btn btn-ghost avatar-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span className="avatar sm">{me.user.displayName.slice(0, 1).toUpperCase()}</span><span className="hide-sm">{me.user.displayName}</span>
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
      <main className="page">{children}</main>
      <nav className="bottomnav" aria-label="Main">
        {nav.map((n) => <Link key={n.to} to={n.to} className={`bnav ${path.startsWith(n.to) ? 'active' : ''}`}>{n.icon}<span>{n.label}</span></Link>)}
      </nav>
    </div>
  );
}
