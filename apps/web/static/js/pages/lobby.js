// Lobby: welcome card, live table list, side panels and lobby chat.
import { api, credits, emit, empty, field, fill, fmt, h, icon, input, link, listen, modal, navigate, RANK_NAMES, select, session, toast } from '../core.js';
import { chatPanel } from './chat.js';

export function lobbyPage(host) {
  const can = (p) => session.can(p);
  let tables = null;
  let filter = 'all';
  let sort = 'blinds';

  const welcome = h('section.welcome.card.card-pad');
  const list = h('div');
  const filters = h('div.filters');
  const side = h('aside.side');
  const chat = chatPanel('lobby');

  fill(host, h('div.lobby',
    welcome,
    h('section.tables.card.card-pad', { 'aria-labelledby': 'tables-h' },
      h('div.section-head', h('h2.panel-title', { id: 'tables-h', style: { margin: '0' } }, icon('spade'), ' Tables'), filters),
      list,
      h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s3)' } }, 'Have a private table link? Open it directly; you will be asked for its access code.')),
    side));

  function paintWelcome() {
    const me = session.me;
    if (!me) return;
    const p = me.progress;
    const pct = p && p.nextLevelXp ? Math.min(100, Math.round(((p.xp - p.levelXp) / (p.nextLevelXp - p.levelXp)) * 100)) : 100;
    const seated = (tables ?? []).reduce((a, t) => a + t.seated, 0);
    fill(welcome,
      h('div',
        h('p.subtle', { style: { fontSize: 'var(--fs-xs)', letterSpacing: '0.12em', textTransform: 'uppercase' } }, 'Welcome back'),
        h('h1.display', { style: { fontSize: 'var(--fs-3xl)', lineHeight: '1.05' } }, me.user.displayName),
        p && h('div', { style: { marginTop: 'var(--s3)', display: 'grid', gap: '6px', maxWidth: '360px' } },
          h('div', { style: { display: 'flex', gap: 'var(--s2)', alignItems: 'center' } },
            h('span.badge.badge-gold', `Level ${p.level}`), h('span.badge', RANK_NAMES[p.rank] ?? p.rank),
            h('span.subtle.num', { style: { fontSize: 'var(--fs-xs)' } }, `${fmt(p.xp)} XP${p.nextLevelXp ? ` / ${fmt(p.nextLevelXp)}` : ''}`)),
          h('div.progress', { role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Level progress' }, h('i', { style: { width: `${pct}%` } })))),
      h('div.welcome-stats',
        h('div', h('span.subtle', 'Wallet'), h('strong.num', credits(me.credits.wallet))),
        h('div', h('span.subtle', 'On tables'), h('strong.num', credits(me.credits.onTables))),
        h('div', h('span.subtle', 'Players seated'), h('strong.num', seated)),
        h('div.welcome-actions',
          h('button.btn.btn-primary.btn-lg', { onclick: quickJoin }, icon('zap', 18), ' Quick join'),
          h('button.btn.btn-lg', { onclick: openCreate }, icon('plus', 18), can('tables.manage') ? ' Create table' : ' Private table'))));
  }

  function paintFilters() {
    fill(filters,
      h('div.seg', { role: 'radiogroup', 'aria-label': 'Filter tables' },
        ['all', 'open', 'public', 'private'].map((f) => h(`button.seg-btn${filter === f ? '.on' : ''}`, { role: 'radio', 'aria-checked': String(filter === f), onclick: () => { filter = f; paintFilters(); paintList(); } },
          f === 'open' ? 'Open seats' : f[0].toUpperCase() + f.slice(1)))),
      select([['blinds', 'Sort: blinds'], ['seats', 'Sort: free seats'], ['name', 'Sort: name']], { style: { width: 'auto', minHeight: '36px' }, 'aria-label': 'Sort tables', value: sort, onchange: (e) => { sort = e.target.value; paintList(); } }));
  }

  function paintList() {
    if (tables === null) return fill(list, h('div', { style: { display: 'grid', gap: '8px' } }, [0, 1, 2].map(() => h('div.skeleton', { style: { height: '64px' } }))));
    let shown = [...tables];
    if (filter === 'public') shown = shown.filter((t) => !t.isPrivate);
    if (filter === 'private') shown = shown.filter((t) => t.isPrivate);
    if (filter === 'open') shown = shown.filter((t) => t.seated < t.maxSeats);
    shown.sort((a, b) => sort === 'blinds' ? a.bigBlind - b.bigBlind : sort === 'seats' ? (b.maxSeats - b.seated) - (a.maxSeats - a.seated) : a.name.localeCompare(b.name));
    if (!shown.length) {
      return fill(list, empty('spade', 'No tables match', can('tables.manage') ? 'Create the first table for your community.' : 'Create a private table and invite friends.',
        h('button.btn', { onclick: openCreate }, icon('plus'), ' Create table')));
    }
    fill(list, h('ul.table-cards', shown.map((t) => h('li.table-card',
      h('div.tc-main', h('strong', t.name), h('span.subtle', { style: { fontSize: 'var(--fs-xs)' } }, `No-Limit Hold'em · Buy-in ${fmt(t.minBuyIn)}–${fmt(t.maxBuyIn)}`)),
      h('div.tc-meta',
        h('span.badge.num', `${fmt(t.smallBlind)}/${fmt(t.bigBlind)}`),
        h('span.badge', icon('users', 12), ` ${t.seated}/${t.maxSeats}`),
        t.isPrivate ? h('span.badge.badge-gold', icon('lock', 12), ' Private') : h('span.badge.badge-green', 'Public'),
        t.status !== 'open' && h('span.badge.badge-red', t.status)),
      h('button.btn', { onclick: () => navigate(`/table/${t.id}`) }, t.seated < t.maxSeats ? 'Join ' : 'Watch ', icon('arrow-right'))))));
  }

  function quickJoin() {
    const wallet = session.me?.credits.wallet ?? 0;
    const t = (tables ?? []).filter((x) => !x.isPrivate && x.status === 'open' && x.seated < x.maxSeats && x.minBuyIn <= wallet).sort((a, b) => b.seated - a.seated)[0];
    if (!t) return toast({ title: 'No table available', body: wallet ? 'No open seat matches your balance right now.' : 'You need game credits to sit down. Ask an administrator.', tone: 'error' });
    navigate(`/table/${t.id}?sit=1`);
  }

  function openCreate() { createTableModal(can('tables.manage')); }

  // Side panels.
  const panel = (title, iconName, ...body) => h('section.card.card-pad', h('h2.panel-title', iconName && icon(iconName), iconName ? ` ${title}` : title), ...body);
  const annBox = h('div', { style: { display: 'contents' } });
  const lbBox = h('div');
  const friendsBox = h('div');
  const recentBox = h('div', { style: { display: 'contents' } });
  fill(side, annBox,
    panel('Top players', 'trophy', lbBox, link('/leaderboards', { style: { fontSize: 'var(--fs-sm)' } }, 'All leaderboards')),
    panel('Friends', 'users', friendsBox),
    recentBox,
    h('section.card', { style: { overflow: 'hidden' } }, h('h2.panel-title', { style: { padding: 'var(--s4) var(--s4) 0' } }, 'Lobby chat'), chat.el));
  const small = (t) => h('p.subtle', { style: { fontSize: 'var(--fs-sm)' } }, t);
  api.get('/announcements').then((r) => {
    if (r.announcements.length) fill(annBox, panel('Announcements', 'megaphone', h('div', { style: { display: 'grid', gap: 'var(--s3)' } }, r.announcements.map((a) => h('div', h('strong', a.title), h('p.muted', { style: { fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' } }, a.body))))));
  }).catch(() => undefined);
  api.get('/leaderboards/level').then((r) => fill(lbBox, r.entries.length
    ? h('ol.mini-lb', r.entries.slice(0, 5).map((e) => h('li', h('span.rank', e.rank), link(`/profile/${e.userId}`, e.displayName), h('span.num.subtle', `Lv ${e.value}`))))
    : small('No rankings yet.'))).catch(() => fill(lbBox, small('No rankings yet.')));
  api.get('/friends').then((r) => fill(friendsBox, r.friends.length
    ? h('ul.mini-list', r.friends.map((f) => h('li', h(`span.dot${f.online ? '.on' : ''}`, { 'aria-label': f.online ? 'At a table' : 'Away' }), link(`/profile/${f.id}`, f.display_name), h('span.subtle.num', `Lv ${f.level}`))))
    : small('Add friends from their profile.'))).catch(() => fill(friendsBox, small('Add friends from their profile.')));
  api.get('/me/hands').then((r) => {
    if (r.hands.length) fill(recentBox, panel('Recent hands', 'history', h('ul.mini-list', r.hands.slice(0, 5).map((x) => h('li', h('span', x.table_name), h(`span.num.${x.net > 0 ? 'gold' : 'subtle'}`, `${x.net > 0 ? '+' : ''}${fmt(x.net)}`))))));
  }).catch(() => undefined);

  // Live table list.
  const subscribe = () => void emit('lobby:subscribe').then((a) => { if (a.ok && a.data) { tables = a.data; paintList(); paintWelcome(); } });
  const stop = listen({
    connect: subscribe,
    'lobby:tables': (incoming) => {
      const priv = (tables ?? []).filter((t) => t.isPrivate && !incoming.some((x) => x.id === t.id));
      tables = [...incoming, ...priv];
      paintList(); paintWelcome();
    },
  });
  const stopSession = session.changed.on(paintWelcome);
  subscribe();
  chat.start();
  paintWelcome(); paintFilters(); paintList();

  if (new URLSearchParams(location.search).get('create') === '1') { history.replaceState(null, '', '/lobby'); openCreate(); }

  return () => { stop(); stopSession(); chat.destroy(); };
}

function createTableModal(canPublic) {
  const name = input({ maxlength: 40, placeholder: 'Friday Night' });
  const num = (v, min = 1) => input({ class: 'num', type: 'number', min, value: v });
  const seats = select([2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, `${n} players`]), { value: 6 });
  const timer = select([15, 20, 25, 30, 45, 60].map((n) => [n, `${n} seconds`]), { value: 25 });
  const sb = num(5), bb = num(10), minBuy = num(200), maxBuy = num(2000);
  const isPrivate = h('input', { type: 'checkbox', checked: !canPublic });
  const code = input({ minlength: 4, maxlength: 32 });
  const duration = select([[0, 'Until closed'], ...[60, 120, 180, 240, 360].map((m) => [m, `${m / 60} hours`])], { value: 0 });
  const privBox = h('div.grid-2', field('Access code', code, { hint: 'Share it with your guests' }), field('Duration', duration));
  const err = h('p.error-text', { role: 'alert', hidden: true });
  const create = h('button.btn.btn-primary', { disabled: true }, 'Create table');
  const syncPriv = () => { privBox.hidden = !isPrivate.checked; };
  isPrivate.addEventListener('change', syncPriv);
  name.addEventListener('input', () => { create.disabled = name.value.trim().length < 3; });
  syncPriv();

  const m = modal({
    title: 'Create a table',
    body: [
      field('Table name', name),
      h('div.grid-2', field('Seats', seats), field('Action timer', timer), field('Small blind', sb), field('Big blind', bb),
        field('Min buy-in', minBuy, { hint: 'At least 10 big blinds' }), field('Max buy-in', maxBuy)),
      canPublic && h('label.check', isPrivate, ' Private table'),
      privBox, err,
    ],
    footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), create],
  });
  name.focus();
  create.addEventListener('click', async () => {
    create.disabled = true; create.textContent = 'Creating…'; err.hidden = true;
    try {
      const body = {
        name: name.value, maxSeats: Number(seats.value), smallBlind: Number(sb.value), bigBlind: Number(bb.value),
        minBuyIn: Number(minBuy.value), maxBuyIn: Number(maxBuy.value), actionSeconds: Number(timer.value), isPrivate: isPrivate.checked,
        ...(isPrivate.checked ? { accessCode: code.value } : {}), ...(isPrivate.checked && Number(duration.value) ? { durationMinutes: Number(duration.value) } : {}),
      };
      const r = await api.post('/tables', body);
      m.close();
      navigate(`/table/${r.table.id}`);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      create.disabled = false; create.textContent = 'Create table';
    }
  });
}
