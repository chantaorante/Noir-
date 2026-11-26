import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../../net/api';
import { useSession } from '../../state/session';
import { Link, useRouter } from '../../lib/router';
import { Field } from '../../lib/ui';
import { Logo } from '../../lib/Logo';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="auth-wrap">
      <div className="auth-card card">
        <div style={{ display: 'grid', justifyItems: 'center', gap: 'var(--s2)', marginBottom: 'var(--s6)' }}>
          <Logo size={44} />
          <h1 className="display" style={{ fontSize: 'var(--fs-2xl)' }}>{title}</h1>
          {subtitle && <p className="muted" style={{ fontSize: 'var(--fs-sm)', textAlign: 'center' }}>{subtitle}</p>}
        </div>
        {children}
      </div>
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--s4)', textAlign: 'center' }}>Private invitation-only community. Game credits only, non-redeemable, no cash value.</p>
    </main>
  );
}

export function LoginPage() {
  const { refresh } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password, ...(needTotp ? (useRecovery ? { recoveryCode: recovery.trim() } : { totp }) : {}) });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setNeedTotp(true);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="NOIR" subtitle="Sign in to take your seat.">
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--s4)' }} noValidate>
        {!needTotp ? (
          <>
            <Field label="Username"><input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus /></Field>
            <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          </>
        ) : useRecovery ? (
          <Field label="Recovery code" hint="One of the codes you saved when you enabled two-factor. Each works once.">
            <input className="input" autoComplete="off" maxLength={10} value={recovery} onChange={(e) => setRecovery(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} autoFocus style={{ letterSpacing: '0.2em', textAlign: 'center', fontSize: 'var(--fs-lg)' }} />
          </Field>
        ) : (
          <Field label="Authenticator code" hint="Open your authenticator app and enter the 6-digit code.">
            <input className="input num" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} autoFocus style={{ letterSpacing: '0.4em', textAlign: 'center', fontSize: 'var(--fs-lg)' }} />
          </Field>
        )}
        {needTotp && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setUseRecovery(!useRecovery); setError(null); }}>{useRecovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}</button>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password || (needTotp && (useRecovery ? recovery.length !== 10 : totp.length !== 6))}>{busy ? 'Signing in…' : needTotp ? <><ShieldCheck size={18} /> Verify</> : 'Sign in'}</button>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)', textAlign: 'center' }}>Have an invitation? <Link to="/register">Create your account</Link></p>
      </form>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const { refresh } = useSession();
  const { navigate } = useRouter();
  const [f, setF] = useState({ inviteCode: new URLSearchParams(location.search).get('code') ?? '', username: '', displayName: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const { confirm: _c, ...body } = f;
      await api.post('/auth/register', body);
      await refresh();
      navigate('/lobby', true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Join NOIR" subtitle="Accounts are created by invitation.">
      <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--s4)' }}>
        <Field label="Invitation code"><input className="input" value={f.inviteCode} onChange={set('inviteCode')} required /></Field>
        <Field label="Username" hint="3–20 letters, digits or underscores. Used to sign in."><input className="input" autoComplete="username" value={f.username} onChange={set('username')} pattern="[A-Za-z0-9_]{3,20}" required /></Field>
        <Field label="Display name"><input className="input" value={f.displayName} onChange={set('displayName')} maxLength={32} required /></Field>
        <Field label="Password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} minLength={10} required /></Field>
        <Field label="Confirm password" error={mismatch ? 'Passwords do not match.' : null}><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} aria-invalid={mismatch} required /></Field>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)', textAlign: 'center' }}><Link to="/">Back to sign in</Link></p>
      </form>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const { navigate } = useRouter();
  const token = location.hash.slice(1);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== confirm) return setError('Passwords do not match.');
    try {
      await api.post('/auth/password-reset', { token, newPassword: pw });
      history.replaceState(null, '', '/reset-password');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <AuthFrame title="Set your password" subtitle="This link works once.">
      {done ? (
        <div style={{ display: 'grid', gap: 'var(--s4)' }}><p>Your password is set.</p><button className="btn btn-primary btn-block" onClick={() => navigate('/', true)}>Sign in</button></div>
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--s4)' }}>
          <Field label="New password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={10} required autoFocus /></Field>
          <Field label="Confirm password"><input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></Field>
          {!token && <p className="error-text">This page needs the link you were given.</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="btn btn-primary btn-lg btn-block" disabled={!token}>Save password</button>
        </form>
      )}
    </AuthFrame>
  );
}
