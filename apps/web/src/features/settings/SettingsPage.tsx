import { useState } from 'react';
import { KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { api } from '../../net/api';
import { Field, Loading, useLoad, useToast } from '../../lib/ui';
import { useSession } from '../../state/session';

export function SettingsPage() {
  return (
    <div className="narrow" style={{ display: 'grid', gap: 'var(--s4)' }}>
      <h1 className="display page-title">Settings & security</h1>
      <MfaCard />
      <PasswordCard />
      <SessionsCard />
      <HistoryCard />
    </div>
  );
}

function MfaCard() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  if (me?.user.mfaEnabled && !recovery) return <section className="card card-pad"><h2 className="panel-title"><ShieldCheck size={16} /> Two-factor authentication</h2><p><span className="badge badge-green">Enabled</span> Your account requires an authenticator code at sign-in.</p></section>;
  return (
    <section className="card card-pad" style={{ display: 'grid', gap: 'var(--s3)' }}>
      <h2 className="panel-title"><ShieldCheck size={16} /> Two-factor authentication</h2>
      {recovery ? (
        <>
          <p><strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They will not be shown again.</p>
          <pre className="codes num">{recovery.join('\n')}</pre>
          <button className="btn" onClick={() => setRecovery(null)}>I have saved them</button>
        </>
      ) : !setup ? (
        <>
          <p className="muted">Protect your account with an authenticator app (Aegis, Google Authenticator, 1Password, Authy…).{me?.user.staffMfaRequired ? ' Required for staff accounts.' : ''}</p>
          <button className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={async () => { try { setSetup(await api.post('/auth/mfa/setup')); } catch (e) { toast({ title: 'Error', body: (e as Error).message, tone: 'error' }); } }}>Set up two-factor</button>
        </>
      ) : (
        <>
          <p>In your authenticator app, add an account manually with this key (time-based, 6 digits):</p>
          <code className="secret num" aria-label="Setup key">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>On a phone you can tap: <a href={setup.otpauthUrl}>open in authenticator</a></p>
          <Field label="Code from the app"><input className="input num" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
          <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={code.length !== 6} onClick={async () => {
            try { const r = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code }); setRecovery(r.recoveryCodes); await refresh(); toast({ title: 'Two-factor enabled', tone: 'success' }); }
            catch (e) { toast({ title: 'Could not enable', body: (e as Error).message, tone: 'error' }); }
          }}>Verify and enable</button>
        </>
      )}
    </section>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  return (
    <section className="card card-pad" style={{ display: 'grid', gap: 'var(--s3)' }}>
      <h2 className="panel-title"><KeyRound size={16} /> Password</h2>
      <div className="grid-2">
        <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
        <span />
        <Field label="New password" hint="At least 10 characters."><input className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
        <Field label="Confirm" error={f.confirm && f.confirm !== f.newPassword ? 'Does not match' : null}><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
      </div>
      <button className="btn" style={{ justifySelf: 'start' }} disabled={!f.currentPassword || f.newPassword.length < 10 || f.confirm !== f.newPassword} onClick={async () => {
        try { await api.post('/auth/password', { currentPassword: f.currentPassword, newPassword: f.newPassword }); toast({ title: 'Password changed', body: 'Other devices were signed out.', tone: 'success' }); setF({ currentPassword: '', newPassword: '', confirm: '' }); }
        catch (e) { toast({ title: 'Could not change password', body: (e as Error).message, tone: 'error' }); }
      }}>Change password</button>
    </section>
  );
}

function SessionsCard() {
  const s = useLoad(() => api.get<{ sessions: { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean }[] }>('/auth/sessions'));
  return (
    <section className="card card-pad">
      <h2 className="panel-title"><Laptop size={16} /> Devices & sessions</h2>
      {s.loading ? <Loading /> : (
        <ul className="mini-list">
          {s.data?.sessions.map((x) => (
            <li key={x.id}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{(x.user_agent ?? 'Unknown device').slice(0, 60)}<br /><span className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>{x.ip} · last active {new Date(x.last_seen_at).toLocaleString()}</span></span>
              {x.current ? <span className="badge badge-green">This device</span> : <button className="btn btn-sm" onClick={async () => { await api.del(`/auth/sessions/${x.id}`); s.reload(); }}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryCard() {
  const h = useLoad(() => api.get<{ events: { success: boolean; reason: string | null; ip: string | null; created_at: string }[] }>('/auth/login-history'));
  return (
    <section className="card card-pad">
      <h2 className="panel-title">Sign-in history</h2>
      {h.loading ? <Loading /> : (
        <table className="table-list"><thead><tr><th>When</th><th>Result</th><th>IP</th></tr></thead>
          <tbody>{h.data?.events.slice(0, 15).map((e, i) => <tr key={i}><td>{new Date(e.created_at).toLocaleString()}</td><td>{e.success ? <span className="badge badge-green">Success</span> : <span className="badge badge-red">{e.reason ?? 'Failed'}</span>}</td><td className="num">{e.ip}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  );
}
