// Sign in, invitation sign-up and password reset.
import { api, ApiError, field, fill, h, icon, input, link, logo, navigate, session } from '../core.js';

function frame(title, subtitle, ...children) {
  return h('main.auth-wrap',
    h('div.auth-card.card',
      h('div', { style: { display: 'grid', justifyItems: 'center', gap: 'var(--s2)', marginBottom: 'var(--s6)' } },
        logo(44), h('h1.display', { style: { fontSize: 'var(--fs-2xl)' } }, title),
        subtitle && h('p.muted', { style: { fontSize: 'var(--fs-sm)', textAlign: 'center' } }, subtitle)),
      ...children),
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s4)', textAlign: 'center' } }, 'Private invitation-only community. Game credits only, non-redeemable, no cash value.'));
}

const errorLine = () => { const p = h('p.error-text', { role: 'alert', hidden: true }); p.set = (m) => { p.textContent = m ?? ''; p.hidden = !m; }; return p; };

export function loginPage(host) {
  let step = 'password'; // password | totp | recovery
  const username = input({ autocomplete: 'username', required: true, autofocus: true });
  const password = input({ type: 'password', autocomplete: 'current-password', required: true });
  const totp = input({ class: 'num', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '\\d{6}', maxlength: 6, style: { letterSpacing: '0.4em', textAlign: 'center', fontSize: 'var(--fs-lg)' } });
  const recovery = input({ autocomplete: 'off', maxlength: 10, style: { letterSpacing: '0.2em', textAlign: 'center', fontSize: 'var(--fs-lg)' } });
  totp.addEventListener('input', () => { totp.value = totp.value.replace(/\D/g, ''); sync(); });
  recovery.addEventListener('input', () => { recovery.value = recovery.value.replace(/[^A-Za-z0-9]/g, ''); sync(); });
  username.addEventListener('input', () => sync());
  password.addEventListener('input', () => sync());

  const fields = h('div', { style: { display: 'grid', gap: 'var(--s4)' } });
  const toggle = h('button.btn.btn-ghost.btn-sm', { type: 'button', hidden: true, onclick: () => { step = step === 'recovery' ? 'totp' : 'recovery'; err.set(null); show(); } });
  const err = errorLine();
  const submit = h('button.btn.btn-primary.btn-lg.btn-block', 'Sign in');
  let busy = false;

  function sync() {
    const ready = username.value && password.value && (step === 'password' || (step === 'totp' ? totp.value.length === 6 : recovery.value.length === 10));
    submit.disabled = busy || !ready;
  }
  function show() {
    if (step === 'password') fill(fields, field('Username', username), field('Password', password));
    else if (step === 'totp') fill(fields, field('Authenticator code', totp, { hint: 'Open your authenticator app and enter the 6-digit code.' }));
    else fill(fields, field('Recovery code', recovery, { hint: 'One of the codes you saved when you enabled two-factor. Each works once.' }));
    toggle.hidden = step === 'password';
    toggle.textContent = step === 'recovery' ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code';
    fill(submit, step === 'password' ? 'Sign in' : [icon('shield-check', 18), ' Verify']);
    (step === 'password' ? username : step === 'totp' ? totp : recovery).focus();
    sync();
  }

  const form = h('form', { style: { display: 'grid', gap: 'var(--s4)' }, novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    busy = true; sync(); err.set(null);
    const label = submit.textContent;
    submit.textContent = 'Signing in…';
    try {
      const extra = step === 'totp' ? { totp: totp.value } : step === 'recovery' ? { recoveryCode: recovery.value.trim() } : {};
      await api.post('/auth/login', { username: username.value, password: password.value, ...extra });
      await session.refresh();
      return;
    } catch (ex) {
      if (ex instanceof ApiError && ex.code === 'MFA_REQUIRED') { step = 'totp'; busy = false; show(); return; }
      err.set(ex.message);
    }
    busy = false;
    submit.textContent = label;
    show();
  } }, fields, toggle, err, submit,
  h('p.muted', { style: { fontSize: 'var(--fs-sm)', textAlign: 'center' } }, 'Have an invitation? ', link('/register', 'Create your account')));

  fill(host, frame('NOIR', 'Sign in to take your seat.', form));
  show();
}

export function registerPage(host) {
  const inviteCode = input({ required: true, value: new URLSearchParams(location.search).get('code') ?? '' });
  const username = input({ autocomplete: 'username', pattern: '[A-Za-z0-9_]{3,20}', required: true });
  const displayName = input({ maxlength: 32, required: true });
  const password = input({ type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const confirm = input({ type: 'password', autocomplete: 'new-password', required: true });
  const confirmField = field('Confirm password', confirm);
  const checkMatch = () => { const bad = confirm.value.length > 0 && confirm.value !== password.value; confirmField.setError(bad ? 'Passwords do not match.' : null); confirm.setAttribute('aria-invalid', String(bad)); return !bad; };
  confirm.addEventListener('input', checkMatch);
  password.addEventListener('input', checkMatch);
  const err = errorLine();
  const submit = h('button.btn.btn-primary.btn-lg.btn-block', 'Create account');
  const form = h('form', { style: { display: 'grid', gap: 'var(--s4)' }, onsubmit: async (e) => {
    e.preventDefault();
    if (!checkMatch()) return;
    submit.disabled = true; submit.textContent = 'Creating…'; err.set(null);
    try {
      await api.post('/auth/register', { inviteCode: inviteCode.value, username: username.value, displayName: displayName.value, password: password.value });
      history.replaceState(null, '', '/lobby');
      await session.refresh();
    } catch (ex) {
      err.set(ex.message);
      submit.disabled = false; submit.textContent = 'Create account';
    }
  } },
  field('Invitation code', inviteCode),
  field('Username', username, { hint: '3–20 letters, digits or underscores. Used to sign in.' }),
  field('Display name', displayName),
  field('Password', password, { hint: 'At least 10 characters.' }),
  confirmField, err, submit,
  h('p.muted', { style: { fontSize: 'var(--fs-sm)', textAlign: 'center' } }, link('/', 'Back to sign in')));
  fill(host, frame('Join NOIR', 'Accounts are created by invitation.', form));
}

export function resetPasswordPage(host) {
  const token = location.hash.slice(1);
  const pw = input({ type: 'password', autocomplete: 'new-password', minlength: 10, required: true, autofocus: true });
  const confirm = input({ type: 'password', autocomplete: 'new-password', required: true });
  const err = errorLine();
  const box = h('div');
  const form = h('form', { style: { display: 'grid', gap: 'var(--s4)' }, onsubmit: async (e) => {
    e.preventDefault();
    if (pw.value !== confirm.value) return err.set('Passwords do not match.');
    try {
      await api.post('/auth/password-reset', { token, newPassword: pw.value });
      history.replaceState(null, '', '/reset-password');
      fill(box, h('div', { style: { display: 'grid', gap: 'var(--s4)' } }, h('p', 'Your password is set.'), h('button.btn.btn-primary.btn-block', { onclick: () => navigate('/', true) }, 'Sign in')));
    } catch (ex) { err.set(ex.message); }
  } },
  field('New password', pw, { hint: 'At least 10 characters.' }),
  field('Confirm password', confirm),
  !token && h('p.error-text', 'This page needs the link you were given.'),
  err,
  h('button.btn.btn-primary.btn-lg.btn-block', { disabled: !token }, 'Save password'));
  fill(box, form);
  fill(host, frame('Set your password', 'This link works once.', box));
}
