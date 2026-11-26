// Settings & security: two-factor, password, devices, sign-in history.
import { api, fill, field, h, icon, input, load, session, toast, when } from '../core.js';

export function settingsPage(host) {
  fill(host, h('div.narrow', { style: { display: 'grid', gap: 'var(--s4)' } },
    h('h1.display.page-title', 'Settings & security'),
    mfaCard(), passwordCard(), sessionsCard(), historyCard()));
}

function mfaCard() {
  const el = h('section.card.card-pad', { style: { display: 'grid', gap: 'var(--s3)' } });
  const title = () => h('h2.panel-title', icon('shield-check'), ' Two-factor authentication');
  const me = session.me;
  if (me.user.mfaEnabled) {
    return fill(el, title(), h('p', h('span.badge.badge-green', 'Enabled'), ' Your account requires an authenticator code at sign-in.'));
  }
  const start = () => fill(el, title(),
    h('p.muted', `Protect your account with an authenticator app (Aegis, Google Authenticator, 1Password, Authy…).${me.user.staffMfaRequired ? ' Required for staff accounts.' : ''}`),
    h('button.btn.btn-primary', { style: { justifySelf: 'start' }, onclick: async () => {
      try { setup(await api.post('/auth/mfa/setup')); } catch (e) { toast({ title: 'Error', body: e.message, tone: 'error' }); }
    } }, 'Set up two-factor'));
  const setup = (s) => {
    const code = input({ class: 'num', inputmode: 'numeric', maxlength: 6 });
    const enable = h('button.btn.btn-primary', { style: { justifySelf: 'start' }, disabled: true }, 'Verify and enable');
    code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, ''); enable.disabled = code.value.length !== 6; });
    enable.addEventListener('click', async () => {
      try {
        const r = await api.post('/auth/mfa/enable', { code: code.value });
        showCodes(r.recoveryCodes);
        toast({ title: 'Two-factor enabled', tone: 'success' });
        await session.refresh();
      } catch (e) { toast({ title: 'Could not enable', body: e.message, tone: 'error' }); }
    });
    fill(el, title(),
      h('p', 'In your authenticator app, add an account manually with this key (time-based, 6 digits):'),
      h('code.secret.num', { 'aria-label': 'Setup key' }, s.secret.match(/.{1,4}/g).join(' ')),
      h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'On a phone you can tap: ', h('a', { href: s.otpauthUrl }, 'open in authenticator')),
      field('Code from the app', code), enable);
  };
  const showCodes = (codes) => fill(el, title(),
    h('p', h('strong', 'Save these recovery codes now.'), ' Each works once if you lose your phone. They will not be shown again.'),
    h('pre.codes.num', codes.join('\n')),
    h('button.btn', { onclick: () => fill(el, title(), h('p', h('span.badge.badge-green', 'Enabled'), ' Your account requires an authenticator code at sign-in.')) }, 'I have saved them'));
  start();
  return el;
}

function passwordCard() {
  const current = input({ type: 'password', autocomplete: 'current-password' });
  const next = input({ type: 'password', autocomplete: 'new-password' });
  const confirm = input({ type: 'password', autocomplete: 'new-password' });
  const confirmField = field('Confirm', confirm);
  const btn = h('button.btn', { style: { justifySelf: 'start' }, disabled: true }, 'Change password');
  const sync = () => {
    confirmField.setError(confirm.value && confirm.value !== next.value ? 'Does not match' : null);
    btn.disabled = !current.value || next.value.length < 10 || confirm.value !== next.value;
  };
  for (const i of [current, next, confirm]) i.addEventListener('input', sync);
  btn.addEventListener('click', async () => {
    try {
      await api.post('/auth/password', { currentPassword: current.value, newPassword: next.value });
      toast({ title: 'Password changed', body: 'Other devices were signed out.', tone: 'success' });
      current.value = next.value = confirm.value = ''; sync();
    } catch (e) { toast({ title: 'Could not change password', body: e.message, tone: 'error' }); }
  });
  return h('section.card.card-pad', { style: { display: 'grid', gap: 'var(--s3)' } },
    h('h2.panel-title', icon('key-round'), ' Password'),
    h('div.grid-2', field('Current password', current), h('span'), field('New password', next, { hint: 'At least 10 characters.' }), confirmField),
    btn);
}

function sessionsCard() {
  const body = h('div');
  const reload = load(body, () => api.get('/auth/sessions'), (d) => h('ul.mini-list', d.sessions.map((x) => h('li',
    h('span', { style: { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' } }, (x.user_agent ?? 'Unknown device').slice(0, 60), h('br'),
      h('span.subtle', { style: { fontSize: 'var(--fs-xs)' } }, `${x.ip ?? ''} · last active ${when(x.last_seen_at)}`)),
    x.current ? h('span.badge.badge-green', 'This device') : h('button.btn.btn-sm', { onclick: async () => { await api.del(`/auth/sessions/${x.id}`); reload(); } }, 'Sign out')))));
  return h('section.card.card-pad', h('h2.panel-title', icon('laptop'), ' Devices & sessions'), body);
}

function historyCard() {
  const body = h('div');
  load(body, () => api.get('/auth/login-history'), (d) => h('table.table-list',
    h('thead', h('tr', h('th', 'When'), h('th', 'Result'), h('th', 'IP'))),
    h('tbody', d.events.slice(0, 15).map((e) => h('tr', h('td', when(e.created_at)),
      h('td', e.success ? h('span.badge.badge-green', 'Success') : h('span.badge.badge-red', e.reason ?? 'Failed')),
      h('td.num', e.ip ?? ''))))));
  return h('section.card.card-pad', h('h2.panel-title', 'Sign-in history'), body);
}
