// Entry point: session check, app shell (top bar, sidebar, bottom nav) and page routing.
import { api, closeSocket, fill, fmt, getSocket, h, icon, initials, link, listen, logo, match, navigate, route, session, toast, loading, empty } from './core.js';
import { loginPage, registerPage, resetPasswordPage } from './pages/auth.js';
import { lobbyPage } from './pages/lobby.js';
import { tablePage } from './pages/table.js';
import { profilePage } from './pages/profile.js';
import { leaderboardsPage } from './pages/leaderboards.js';
import { settingsPage } from './pages/settings.js';
import { notificationsButton } from './pages/notifications.js';

const root = document.getElementById('root');
let shell = null; // { el, main, update(), destroy(), tableMode, userId }
let cleanupPage = null;

function pageFor(path) {
  let p;
  if ((p = match('/table/:id', path))) return { tableMode: true, mount: (el) => tablePage(el, p.id) };
  if (path === '/lobby') return { mount: lobbyPage };
  if ((p = match('/profile/:id', path))) return { mount: (el) => profilePage(el, p.id) };
  if (path === '/leaderboards') return { mount: leaderboardsPage };
  if (path === '/settings') return { mount: settingsPage };
  if (path.startsWith('/admin')) return { mount: async (el) => (await import('./pages/admin.js')).adminPage(el) };
  return { mount: (el) => { fill(el, empty(null, 'Page not found', null, link('/lobby', 'Go to the lobby'))); } };
}

async function render() {
  const path = location.pathname;
  if (typeof cleanupPage === 'function') cleanupPage();
  cleanupPage = null;
  const me = session.me;
  if (path === '/reset-password' || !me) {
    destroyShell();
    const host = h('div');
    fill(root, host);
    cleanupPage = path === '/reset-password' ? resetPasswordPage(host) : path === '/register' ? registerPage(host) : loginPage(host);
    return;
  }
  if (path === '/' || path === '/register') return navigate('/lobby', true);
  const page = pageFor(path);
  const tableMode = !!page.tableMode;
  if (!shell || shell.tableMode !== tableMode || shell.userId !== me.user.id) {
    destroyShell();
    shell = buildShell(tableMode);
    fill(root, shell.el);
  }
  shell.update();
  const host = h('div.page-host', { style: { display: 'contents' } });
  fill(shell.main, host);
  cleanupPage = await page.mount(host);
}

function destroyShell() {
  shell?.destroy();
  shell = null;
}

function buildShell(tableMode) {
  const me = session.me;
  const can = (p) => session.can(p);
  const online = h('span.online.mono.hide-sm', { hidden: true });
  const walletNum = h('span.num.mono');
  const pillnav = h('nav.pillnav', { 'aria-label': 'Sections' });
  const banners = h('div', { style: { display: 'contents' } });
  const menuBox = h('div', { style: { position: 'relative' } });
  const notif = notificationsButton();

  let menuOpen = false;
  const menuBtn = h('button.btn.btn-ghost.avatar-btn', { 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => toggleMenu(!menuOpen) },
    h('span.avatar.sm', initials(me.user.displayName)),
    h('span.who.hide-sm', h('strong', me.user.displayName), h('span.label', me.user.role)));
  const menu = h('div.menu.card', { role: 'menu', hidden: true, onmouseleave: () => toggleMenu(false) },
    link('/settings', { role: 'menuitem', class: 'menu-item', onclick: () => toggleMenu(false) }, icon('settings'), ' Settings & security'),
    h('button.menu-item', { role: 'menuitem', onclick: () => void session.logout() }, icon('log-out'), ' Sign out'));
  function toggleMenu(v) { menuOpen = v; menu.hidden = !v; menuBtn.setAttribute('aria-expanded', String(v)); }
  menuBox.append(menuBtn, menu);

  const sections = [
    { title: 'Play', items: [['/lobby', 'Lobby', 'layout-grid'], ['/leaderboards', 'Leaderboards', 'trophy']] },
    { title: 'You', items: [[`/profile/${me.user.id}`, 'Profile', 'user'], ['/settings', 'Settings & security', 'settings']] },
    ...(can('admin.access') ? [{ title: 'Staff', items: [['/admin', 'Admin', 'shield']] }] : []),
  ];
  const mobileNav = [['/lobby', 'Lobby', 'layout-grid'], ['/leaderboards', 'Leaderboards', 'trophy'], [`/profile/${me.user.id}`, 'Profile', 'user'], ...(can('admin.access') ? [['/admin', 'Admin', 'shield']] : [])];
  const navLinks = [];
  const navLink = (to, cls, ...children) => { const a = link(to, { class: cls }, ...children); a.dataset.to = to; a.dataset.base = cls; navLinks.push(a); return a; };

  const sidebar = h('aside.sidebar.card', { 'aria-label': 'Main' },
    sections.map((s) => h('nav.side-section', { 'aria-label': s.title }, h('span.label', s.title), s.items.map(([to, label, ic]) => navLink(to, 'side-link', icon(ic, 17), h('span', label))))),
    h('div.side-promo', icon('spade', 18, 'gold'), h('strong', 'Your private table'), h('p', 'Invite your circle with an access code. Game credits only.'),
      h('button.btn.btn-primary.btn-sm.btn-block', { onclick: () => navigate('/lobby?create=1') }, icon('plus', 14), ' Create private table')),
    h('p.label.side-foot', 'NOIR v0.1.0 · game credits only'));
  const bottomnav = h('nav.bottomnav', { 'aria-label': 'Main' }, mobileNav.map(([to, label, ic]) => navLink(to, 'bnav', icon(ic, 18), h('span', label))));
  const main = h('main.page');
  const el = h(`div.shell${tableMode ? '.table-mode' : ''}`,
    h('header.topbar',
      link('/lobby', { class: 'brand', 'aria-label': 'NOIR lobby' }, logo(38, true)),
      pillnav,
      h('div.topright', online,
        h('div.wallet', { title: 'Game credits. Non-redeemable, with no cash value.' }, icon('crown', 15, 'gold'), walletNum),
        notif.el, menuBox)),
    banners,
    h('div.frame', sidebar, main),
    bottomnav);

  // Online count: unique signed-in players with a live connection.
  let stopped = false;
  const loadOnline = () => api.get('/tables').then((r) => { if (stopped) return; online.hidden = false; fill(online, h('i.dot.on'), ` ${r.online} online`); }).catch(() => undefined);
  void loadOnline();
  const first = setTimeout(loadOnline, 2500);
  const every = setInterval(loadOnline, 30_000);

  // Session-wide socket events.
  const stopSocket = listen({
    notify: (n) => toast({ title: n.title, body: n.body, tone: 'success' }),
    'session:revoked': () => { session.me = null; closeSocket(); session.changed.emit(); },
    'credits:changed': () => void session.refresh(),
    'table:left': () => void session.refresh(),
  });
  const stopSession = session.changed.on(() => shell?.update());

  function lastTable() {
    const m = match('/table/:id', location.pathname);
    try {
      if (m) sessionStorage.setItem('noir.lastTable', m.id);
      return sessionStorage.getItem('noir.lastTable');
    } catch { return m?.id ?? null; }
  }

  function update() {
    const me = session.me;
    if (!me) return;
    walletNum.textContent = `${fmt(me.credits.wallet)} ALL`;
    const path = location.pathname;
    const active = (to) => (to.startsWith('/table/') ? path.startsWith('/table/') : path.startsWith(to));
    const lt = lastTable();
    const pills = [['/lobby', 'Lobby'], ...(lt ? [[`/table/${lt}`, 'Table']] : []), ['/leaderboards', 'Leaderboards']];
    fill(pillnav, pills.map(([to, label]) => link(to, { class: `pill ${active(to) ? 'active' : ''}`, 'aria-current': active(to) ? 'page' : undefined }, label)));
    for (const a of navLinks) {
      const on = active(a.dataset.to);
      a.className = `${a.dataset.base} ${on ? 'active' : ''}`;
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    fill(banners,
      me.user.staffMfaRequired && h('div.banner', 'Staff accounts must enable two-factor authentication before using admin tools. ', link('/settings', 'Enable it now')),
      me.user.mustChangePassword && h('div.banner', 'Please set a new password in ', link('/settings', 'Settings'), '.'));
  }

  return {
    el, main, update, tableMode, userId: me.user.id,
    destroy() { stopped = true; clearTimeout(first); clearInterval(every); stopSocket(); stopSession(); notif.destroy(); },
  };
}

// Re-render on navigation and on sign-in / sign-out.
route.on(() => void render());
let signedIn; // undefined until the first session check
session.changed.on(() => {
  const now = session.me?.user.id ?? null;
  if (now !== signedIn) { signedIn = now; if (now) getSocket(); void render(); }
});

fill(root, loading());
session.refresh().catch(() => {
  fill(root, h('div.empty', { role: 'alert' }, h('strong', 'Cannot reach the server.'), h('button.btn', { onclick: () => location.reload() }, 'Try again')));
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
