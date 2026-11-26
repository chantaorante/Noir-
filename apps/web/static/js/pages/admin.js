// Administration console. Every control here is also enforced by the server (permission checks,
// staff MFA, step-up for high-risk actions, audit logging); hiding a button is never the protection.
import { api, ApiError, credits, day, empty, field, fill, fmt, h, icon, input, link, load, loading, modal, navigate, newId, select, session, toast, when } from '../core.js';

/** Runs a high-risk call; if the server asks for step-up, prompts for a TOTP code and retries once. */
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'STEP_UP_REQUIRED') throw e;
    const code = await stepUpPrompt();
    if (!code) throw new Error('Cancelled.');
    await api.post('/auth/step-up', { code });
    return fn();
  }
}

function stepUpPrompt() {
  return new Promise((resolve) => {
    let result = null;
    const code = input({ class: 'num', inputmode: 'numeric', maxlength: 6, autofocus: true });
    const ok = h('button.btn.btn-primary', { disabled: true }, 'Confirm');
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, ''); ok.disabled = code.value.length !== 6; });
    const m = modal({
      title: "Confirm it's you",
      body: [h('p.muted', 'This is a sensitive action. Enter the current code from your authenticator app.'), field('Authenticator code', code)],
      footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), ok],
      onClose: () => resolve(result),
    });
    const submit = () => { result = code.value; m.close(); };
    ok.addEventListener('click', submit);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) submit(); });
  });
}

const fail = (title) => (e) => toast({ title, body: e.message, tone: 'error' });
const table = (heads, rows) => h('table.table-list', h('thead', h('tr', heads.map((x) => (typeof x === 'string' ? h('th', x) : x)))), h('tbody', rows));
const th = (label, style) => h('th', { style }, label);
const right = { textAlign: 'right' };

const TABS = [
  ['dashboard', 'Dashboard', 'activity', 'system.view', dashboard],
  ['users', 'Users', 'users', 'users.view', usersTab],
  ['credits', 'Credits', 'coins', 'credits.view', ledgerTab],
  ['invites', 'Invitations', 'ticket', 'users.create', invitesTab],
  ['tables', 'Tables', 'spade', 'tables.manage', tablesTab],
  ['moderation', 'Moderation', 'shield-alert', 'chat.moderate', moderationTab],
  ['audit', 'Audit & security', 'file-text', 'audit.view', auditTab],
  ['config', 'Configuration', 'settings-2', 'system.view', configTab],
  ['announce', 'Announcements', 'megaphone', 'announcements.manage', announceTab],
];

export function adminPage(host) {
  if (session.me.user.staffMfaRequired) {
    return fill(host, empty('shield', 'Two-factor authentication required', 'Staff accounts must enable two-factor authentication before using admin tools.', link('/settings', { class: 'btn btn-primary' }, 'Enable two-factor')));
  }
  const tabs = TABS.filter((t) => session.can(t[3]));
  const current = location.pathname.split('/')[2] ?? tabs[0]?.[0] ?? 'dashboard';
  const body = h('section.admin-body');
  fill(host, h('div.admin',
    h('nav.admin-nav.card', { 'aria-label': 'Administration' }, tabs.map(([key, label, ic]) => h(`button.admin-tab${current === key ? '.on' : ''}`, { 'aria-current': current === key ? 'page' : undefined, onclick: () => navigate(`/admin/${key}`) }, icon(ic), label))),
    body));
  const tab = tabs.find((t) => t[0] === current);
  if (tab) tab[4](body);
}

const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`);

function dashboard(el) {
  load(el, () => api.get('/admin/dashboard'), (x) => {
    const memUsed = x.server.memTotal - x.server.memFree;
    const tiles = [
      ['Registered users', fmt(x.users)], ['Active (24 h)', fmt(x.activeUsers24h)], ['Online now', fmt(x.online)], ['Active tables', `${x.activeTables} / ${x.tables}`],
      ['Active tournaments', fmt(x.activeTournaments)], ['Hands played', fmt(x.handsPlayed)], ['CPU load (1 min)', `${x.server.load[0].toFixed(2)} / ${x.server.cpus} cores`],
      ['RAM used', `${bytes(memUsed)} / ${bytes(x.server.memTotal)}`], ['Disk free', x.server.disk ? `${bytes(x.server.disk.free)} / ${bytes(x.server.disk.total)}` : 'n/a'],
      ['Database size', bytes(x.database.bytes)], ['App memory', bytes(x.server.rss)], ['Last backup', x.backup ? `${x.backup.ok ? 'OK' : 'FAILED'} · ${when(x.backup.finished_at)}` : 'None recorded'],
    ];
    const card = (title, ...c) => h('div.card.card-pad', h('h3.panel-title', title), ...c);
    return h('div', { style: { display: 'grid', gap: 'var(--s4)' } },
      h('div.tiles', tiles.map(([k, v]) => h('div.tile.card', h('span.subtle', k), h('strong.num', v)))),
      h('div.grid-2',
        card('Recent registrations', h('ul.mini-list', x.recentRegistrations.map((u) => h('li', h('span', u.username), h('span.subtle', day(u.created_at)))))),
        card('Recent security events', x.recentSecurityEvents.length ? h('ul.mini-list', x.recentSecurityEvents.map((e) => h('li', h(`span.badge${e.severity === 'high' ? '.badge-red' : ''}`, e.severity), h('span', e.kind), h('span.subtle', when(e.created_at))))) : h('p.subtle', 'None.')),
        card('Recent admin activity', h('ul.mini-list', x.recentAdminActivity.map((e) => h('li', h('span', e.actor ?? 'system'), h('span', e.action), h('span.subtle', when(e.created_at)))))),
        h('div.card.card-pad', h('h3.panel-title', icon('database', 14), ' Server'), h('p.muted.num', `Uptime ${Math.floor(x.server.uptimeSec / 3600)} h ${Math.floor((x.server.uptimeSec % 3600) / 60)} min · Database OK`))));
  });
}

function usersTab(el) {
  let query = '';
  const q = input({ placeholder: 'Search username, name or player ID', 'aria-label': 'Search users' });
  const list = h('div.card', { style: { overflowX: 'auto' } });
  const reload = () => load(list, () => api.get(`/admin/users?q=${encodeURIComponent(query)}`), (d) => table(
    ['ID', 'User', 'Role', 'Status', 'Level', th('Wallet', right)],
    d.users.map((u) => {
      const open = () => userDetail(u.id, reload);
      return h('tr', { style: { cursor: 'pointer' }, tabindex: 0, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
        h('td.num.subtle', u.public_id), h('td', h('strong', u.display_name), ' ', h('span.subtle', `@${u.username}`)), h('td', u.role),
        h('td', h(`span.badge.${u.status === 'active' ? 'badge-green' : 'badge-red'}`, u.status)), h('td.num', u.level), h('td.num', { style: right }, fmt(u.balance)));
    })));
  fill(el, h('div', { style: { display: 'grid', gap: 'var(--s4)' } },
    h('div.admin-toolbar',
      h('form.search', { onsubmit: (e) => { e.preventDefault(); query = q.value; reload(); } }, icon('search'), q),
      session.can('users.create') && h('button.btn.btn-primary', { onclick: () => createUser(reload) }, 'Create account')),
    list));
  reload();
}

function createUser(done) {
  const username = input(), displayName = input(), email = input({ type: 'email' });
  const role = select([['player', 'Player'], ['moderator', 'Moderator'], ...(session.me.user.role === 'owner' ? [['admin', 'Administrator']] : [])]);
  const create = h('button.btn.btn-primary', 'Create');
  const m = modal({
    title: 'Create account',
    body: [field('Username', username), field('Display name', displayName), field('Email (optional)', email), field('Role', role)],
    footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), create],
    onClose: done,
  });
  create.addEventListener('click', async () => {
    try {
      const r = await run(() => api.post('/admin/users', { username: username.value, displayName: displayName.value, role: role.value, ...(email.value ? { email: email.value } : {}) }));
      const url = `${location.origin}${r.setupPath}`;
      m.setBody(h('p', 'Account created. Send this one-time setup link to the user privately. It expires in 72 hours. You never see their password.'),
        h('code.secret', { style: { wordBreak: 'break-all' } }, url),
        h('button.btn', { onclick: () => void navigator.clipboard.writeText(url) }, 'Copy link'));
      m.setFooter(h('button.btn.btn-primary', { onclick: () => m.close() }, 'Done'));
    } catch (e) { fail('Could not create')(e); }
  });
}

function userDetail(id, done) {
  const can = (p) => session.can(p);
  const m = modal({ title: 'User', body: loading(), onClose: done });
  const act = async (label, fn) => { try { await run(fn); toast({ title: label, tone: 'success' }); refresh(); } catch (e) { fail('Action failed')(e); } };
  const reason = (what) => window.prompt(`Reason for ${what} (recorded in the audit log):`)?.trim();
  const extra = h('div', { style: { display: 'contents' } });

  async function refresh() {
    let d;
    try { d = await api.get(`/admin/users/${id}`); } catch (e) { m.setBody(h('p.error-text', e.message)); return; }
    const u = d.user;
    m.el.querySelector('#modal-title').textContent = `${u.display_name} (@${u.username})`;
    const kv = (k, v) => h('div.kv', h('span', k), h('span', v));
    const status = (s, r, extraBody = {}) => () => { const why = reason(r); if (why) void act(s === 'active' ? 'User reactivated' : s === 'banned' ? 'User banned' : 'User suspended', () => api.post(`/admin/users/${id}/status`, { status: s, reason: why, ...extraBody })); };
    m.setBody(
      kv('Player ID', h('span.num', u.public_id)),
      kv('Role / status', `${u.role} · ${u.status}${u.suspended_until ? ` until ${when(u.suspended_until)}` : ''}`),
      kv('2FA', u.totp_enabled ? 'Enabled' : 'Not enabled'),
      kv('Level / XP', h('span.num', `${u.level} / ${fmt(u.xp_total)}`)),
      d.credits && kv('Credits', h('span.num', `${credits(d.credits.wallet)} wallet · ${fmt(d.credits.onTables)} on tables · ledger ${d.credits.ledgerIntact ? 'intact' : 'INCONSISTENT'}`)),
      kv('Hands played', h('span.num', fmt(d.stats?.hands_played))),
      kv('Open reports', d.reports.filter((r) => r.status === 'open').length),
      kv('Active sessions', d.sessions.length),
      h('hr.divider'),
      h('div.btn-wrap',
        can('credits.grant') && [h('button.btn', { onclick: () => creditForm('grant') }, 'Grant credits'), h('button.btn', { onclick: () => creditForm('correction') }, 'Correct balance')],
        can('users.suspend') && (u.status === 'active'
          ? [h('button.btn', { onclick: status('suspended', 'suspension', { until: new Date(Date.now() + 7 * 864e5).toISOString() }) }, 'Suspend 7 days'), h('button.btn.btn-danger', { onclick: status('banned', 'ban') }, 'Ban')]
          : h('button.btn', { onclick: status('active', 'reactivation') }, 'Reactivate')),
        can('chat.moderate') && h('button.btn', { onclick: () => { const r = reason('chat mute'); if (r) void act('Muted for 24 h', () => api.post(`/admin/users/${id}/mute`, { minutes: 1440, reason: r })); } }, 'Mute 24 h'),
        can('users.revoke_sessions') && h('button.btn', { onclick: () => void act('Sessions revoked', () => api.post(`/admin/users/${id}/revoke-sessions`)) }, 'Revoke sessions'),
        can('users.reset_password') && h('button.btn', { onclick: async () => {
          try { const r = await run(() => api.post(`/admin/users/${id}/reset-password`)); fill(extra, h('p.muted', 'One-time link, valid 60 minutes. Send it privately:'), h('code.secret', { style: { wordBreak: 'break-all' } }, `${location.origin}${r.resetPath}`)); }
          catch (e) { fail('Failed')(e); }
        } }, 'Password reset link'),
        can('roles.assign') && select([['', 'Change role…'], ['player', 'Player'], ['moderator', 'Moderator'], ['admin', 'Administrator']], { style: { width: 'auto' }, 'aria-label': 'Change role', onchange: (e) => { if (e.target.value) void act('Role changed', () => api.post(`/admin/users/${id}/role`, { role: e.target.value })); } })),
      extra);
  }

  function creditForm(kind) {
    const amount = input({ class: 'num', type: 'number' });
    const why = input();
    const rec = h('button.btn.btn-primary', { disabled: true }, 'Record entry');
    const sync = () => { rec.disabled = !Number(amount.value) || why.value.trim().length < 5; };
    amount.addEventListener('input', sync); why.addEventListener('input', sync);
    const key = newId(); // one idempotency key per form, so a double click cannot record twice
    rec.addEventListener('click', async () => {
      rec.disabled = true;
      await act('Ledger entry recorded', () => api.post('/admin/credits', { userId: id, amount: Math.trunc(Number(amount.value)), kind, reason: why.value, idempotencyKey: key }));
      fill(extra);
    });
    fill(extra, h('div.card.card-pad', { style: { display: 'grid', gap: 'var(--s3)' } },
      h('strong', kind === 'grant' ? 'Grant virtual credits' : 'Correction (compensating entry)'),
      field('Amount (ALL)', amount, { hint: kind === 'correction' ? 'Negative to remove, positive to add back.' : 'Positive whole number.' }),
      field('Reason (required, audited)', why),
      h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'Game credits only. Non-redeemable, with no cash value.'),
      h('div.btn-wrap', h('button.btn.btn-ghost', { onclick: () => fill(extra) }, 'Cancel'), rec)));
    amount.focus();
  }

  void refresh();
}

function ledgerTab(el) {
  let type = '';
  const list = h('div.card', { style: { overflowX: 'auto' } });
  const reload = () => load(list, () => api.get(`/admin/credits/ledger${type ? `?type=${type}` : ''}`), (d) => table(
    ['When', 'User', 'Type', th('Amount', right), th('Before → After', right), 'By', 'Reason'],
    d.entries.map((e) => h('tr', h('td.subtle', when(e.created_at)), h('td', e.username), h('td', h('span.badge', e.entry_type)),
      h(`td.num${e.amount > 0 ? '.gold' : ''}`, { style: right }, `${e.amount > 0 ? '+' : ''}${fmt(e.amount)}`),
      h('td.num.subtle', { style: right }, `${fmt(e.balance_before)} → ${fmt(e.balance_after)}`),
      h('td', e.admin_name ?? '—'), h('td', e.reason ?? e.reference_type ?? '')))));
  const exportCsv = async () => {
    try {
      const csv = await run(() => api.get(`/admin/credits/export${type ? `?type=${type}` : ''}`));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = h('a', { href: url, download: 'noir-ledger.csv' });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { fail('Export failed')(e); }
  };
  fill(el, h('div', { style: { display: 'grid', gap: 'var(--s4)' } },
    h('div.admin-toolbar',
      select([['', 'All entry types'], ...['ADMIN_GRANT', 'ADMIN_CORRECTION', 'TABLE_BUY_IN', 'TABLE_CASH_OUT', 'TOURNAMENT_ENTRY', 'TOURNAMENT_REFUND'].map((t) => [t, t])], { style: { width: 'auto' }, 'aria-label': 'Entry type', onchange: (e) => { type = e.target.value; reload(); } }),
      session.can('credits.export') && h('button.btn', { onclick: exportCsv }, 'Export CSV')),
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'Append-only ledger. Balances are derived from entries; corrections are new compensating entries, never edits. Denomination ALL is a display label for non-redeemable game credits.'),
    list));
  reload();
}

function invitesTab(el) {
  const role = select([['player', 'Player'], ['moderator', 'Moderator']]);
  const uses = input({ class: 'num', type: 'number', min: 1, max: 100, value: 1 });
  const hours = input({ class: 'num', type: 'number', min: 1, max: 720, value: 72 });
  const note = input();
  const result = h('div', { style: { display: 'contents' } });
  const list = h('div.card', { style: { overflowX: 'auto' } });
  const reload = () => load(list, () => api.get('/admin/invitations'), (d) => table(['Created', 'Role', 'Uses', 'Expires', 'Note'],
    d.invitations.map((i) => h('tr', h('td', day(i.created_at)), h('td', i.role), h('td.num', `${i.uses}/${i.max_uses}`), h('td', when(i.expires_at)), h('td', i.note ?? '')))));
  fill(el, h('div', { style: { display: 'grid', gap: 'var(--s4)' } },
    h('div.card.card-pad', { style: { display: 'grid', gap: 'var(--s3)' } },
      h('h3.panel-title', 'New invitation'),
      h('div.grid-2', field('Role', role), field('Uses', uses), field('Valid for (hours)', hours), field('Note', note)),
      h('button.btn.btn-primary', { style: { justifySelf: 'start' }, onclick: async () => {
        try {
          const r = await run(() => api.post('/admin/invitations', { role: role.value, maxUses: Number(uses.value), expiresInHours: Number(hours.value), note: note.value || undefined }));
          fill(result, h('p.muted', 'Share this link privately. The code is shown only once:'), h('code.secret', { style: { wordBreak: 'break-all' } }, `${location.origin}/register?code=${r.code}`));
          reload();
        } catch (e) { fail('Failed')(e); }
      } }, 'Create invitation'),
      result),
    list));
  reload();
}

function tablesTab(el) {
  const reload = () => load(el, () => api.get('/admin/tables'), (d) => {
    const set = async (id, status) => { try { await api.post(`/admin/tables/${id}/status`, { status }); reload(); } catch (e) { fail('Failed')(e); } };
    if (!d.tables.length) return h('div.card', empty('spade', 'No tables', 'Create tables from the lobby.'));
    return h('div.card', { style: { overflowX: 'auto' } }, table(['Name', 'Blinds', 'Seated', 'Type', 'Status', ''],
      d.tables.map((x) => h('tr', h('td', link(`/table/${x.id}`, x.name)), h('td.num', `${x.smallBlind}/${x.bigBlind}`), h('td.num', `${x.seated}/${x.maxSeats}`), h('td', x.isPrivate ? 'Private' : 'Public'), h('td', x.status),
        h('td.btn-wrap',
          x.status === 'open' ? h('button.btn.btn-sm', { onclick: () => set(x.id, 'paused') }, 'Pause') : h('button.btn.btn-sm', { onclick: () => set(x.id, 'open') }, 'Resume'),
          h('button.btn.btn-sm.btn-danger', { onclick: () => { if (window.confirm('Close this table? Seated players are cashed out after the current hand.')) void set(x.id, 'closed'); } }, 'Close'))))));
  });
  reload();
}

function moderationTab(el) {
  const reload = () => load(el, () => api.get('/admin/reports'), (d) => {
    const set = async (id, status) => { try { await api.post(`/admin/reports/${id}`, { status }); reload(); } catch (e) { fail('Failed')(e); } };
    return h('div.card', { style: { overflowX: 'auto' } },
      !d.reports.length ? empty('shield-alert', 'No reports') : table(['When', 'Reporter', 'Target', 'Category', 'Details', 'Status', ''],
        d.reports.map((x) => h('tr', h('td.subtle', when(x.created_at)), h('td', x.reporter), h('td', link(`/profile/${x.target_id}`, x.target)), h('td', x.category), h('td', { style: { maxWidth: '280px' } }, x.details ?? ''), h('td', x.status),
          h('td.btn-wrap', x.status === 'open' && [h('button.btn.btn-sm', { onclick: () => set(x.id, 'actioned') }, 'Actioned'), h('button.btn.btn-sm.btn-ghost', { onclick: () => set(x.id, 'dismissed') }, 'Dismiss')])))),
      h('p.subtle', { style: { padding: 'var(--s3)', fontSize: 'var(--fs-xs)' } }, 'Statistical alerts are evidence for review, never automatic bans.'));
  });
  reload();
}

function auditTab(el) {
  const audit = h('div');
  const sec = h('div');
  fill(el, h('div', { style: { display: 'grid', gap: 'var(--s4)' } },
    h('div.card.card-pad', h('h3.panel-title', 'Administrator audit log'), audit),
    h('div.card.card-pad', h('h3.panel-title', 'Security events'), sec)));
  const code = (v, n) => h('code', { style: { fontSize: '11px' } }, JSON.stringify(v).slice(0, n));
  load(audit, () => api.get('/admin/audit'), (d) => [
    h('p', d.chainIntact ? h('span.badge.badge-green', 'Hash chain intact') : h('span.badge.badge-red', `Chain broken at entry ${d.firstBrokenId}`)),
    h('div', { style: { overflowX: 'auto' } }, table(['When', 'Actor', 'Action', 'Target', 'Details'],
      d.entries.map((e) => h('tr', h('td.subtle', when(e.created_at)), h('td', e.actor ?? 'system'), h('td', e.action), h('td.subtle', `${e.target_type ?? ''} ${e.target_id?.slice(0, 8) ?? ''}`), h('td', code(e.details, 120)))))),
  ]);
  load(sec, () => api.get('/admin/security-events'), (d) => h('div', { style: { overflowX: 'auto' } }, table(['When', 'Severity', 'Kind', 'IP', 'Details'],
    d.events.map((e) => h('tr', h('td.subtle', when(e.created_at)), h('td', e.severity), h('td', e.kind), h('td.num', e.ip ?? ''), h('td', code(e.details, 100)))))));
}

function configTab(el) {
  const editable = ['maintenance', 'xp_rules', 'chat', 'leaderboards'];
  const reload = () => load(el, () => api.get('/admin/config'), (d) => h('div', { style: { display: 'grid', gap: 'var(--s4)' } }, d.config.map((row) => {
    if (!editable.includes(row.key)) return h('div.card.card-pad', { style: { display: 'grid', gap: 'var(--s2)' } }, h('h3.panel-title', row.key), h('code', { style: { fontSize: '12px' } }, JSON.stringify(row.value)));
    const ta = h('textarea.textarea.num', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', minHeight: '110px' }, 'aria-label': `${row.key} JSON` });
    ta.value = JSON.stringify(row.value, null, 2);
    return h('div.card.card-pad', { style: { display: 'grid', gap: 'var(--s2)' } }, h('h3.panel-title', row.key), ta,
      h('button.btn', { style: { justifySelf: 'start' }, onclick: async () => {
        try { const v = JSON.parse(ta.value); await run(() => api.put(`/admin/config/${row.key}`, v)); toast({ title: 'Saved', tone: 'success' }); reload(); }
        catch (e) { fail('Not saved')(e); }
      } }, 'Save'));
  })));
  reload();
}

function announceTab(el) {
  const title = input({ maxlength: 120 });
  const body = h('textarea.textarea', { maxlength: 2000 });
  const pub = h('button.btn.btn-primary', { style: { justifySelf: 'start' }, disabled: true }, 'Publish announcement');
  const sync = () => { pub.disabled = title.value.length < 3 || !body.value; };
  title.addEventListener('input', sync); body.addEventListener('input', sync);
  pub.addEventListener('click', async () => {
    try { await api.post('/admin/announcements', { title: title.value, body: body.value }); toast({ title: 'Published', tone: 'success' }); title.value = ''; body.value = ''; sync(); }
    catch (e) { fail('Failed')(e); }
  });
  fill(el, h('div.card.card-pad', { style: { display: 'grid', gap: 'var(--s3)', maxWidth: '640px' } }, field('Title', title), field('Message', body), pub));
}
