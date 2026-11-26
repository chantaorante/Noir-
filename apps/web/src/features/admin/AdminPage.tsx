import { useState } from 'react';
import { Activity, Coins, Database, FileText, Megaphone, Search, Settings2, Shield, ShieldAlert, Spade, Ticket, Users } from 'lucide-react';
import { api, ApiError, credits, fmt } from '../../net/api';
import { Link, useRouter } from '../../lib/router';
import { Empty, ErrorState, Field, Loading, Modal, newId, useLoad, useToast } from '../../lib/ui';
import { useSession } from '../../state/session';

/**
 * Administration console. Every control here is also enforced by the server (permission checks,
 * staff MFA, step-up for high-risk actions, audit logging); hiding a button is never the protection.
 */

/** Runs a high-risk call; if the server asks for step-up, prompts for a TOTP code and retries once. */
function useStepUp() {
  const [prompt, setPrompt] = useState<{ resolve: (code: string | null) => void } | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'STEP_UP_REQUIRED') throw e;
      const code = await new Promise<string | null>((resolve) => setPrompt({ resolve }));
      setPrompt(null);
      if (!code) throw new Error('Cancelled.');
      await api.post('/auth/step-up', { code });
      return fn();
    }
  };
  const ui = prompt ? <StepUpModal onDone={(c) => prompt.resolve(c)} /> : null;
  return { run, ui };
}

function StepUpModal({ onDone }: { onDone: (code: string | null) => void }) {
  const [code, setCode] = useState('');
  return (
    <Modal title="Confirm it's you" onClose={() => onDone(null)} footer={<><button className="btn btn-ghost" onClick={() => onDone(null)}>Cancel</button><button className="btn btn-primary" disabled={code.length !== 6} onClick={() => onDone(code)}>Confirm</button></>}>
      <p className="muted">This is a sensitive action. Enter the current code from your authenticator app.</p>
      <Field label="Authenticator code"><input className="input num" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
    </Modal>
  );
}

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: Activity, perm: 'system.view' },
  { key: 'users', label: 'Users', icon: Users, perm: 'users.view' },
  { key: 'credits', label: 'Credits', icon: Coins, perm: 'credits.view' },
  { key: 'invites', label: 'Invitations', icon: Ticket, perm: 'users.create' },
  { key: 'tables', label: 'Tables', icon: Spade, perm: 'tables.manage' },
  { key: 'moderation', label: 'Moderation', icon: ShieldAlert, perm: 'chat.moderate' },
  { key: 'audit', label: 'Audit & security', icon: FileText, perm: 'audit.view' },
  { key: 'config', label: 'Configuration', icon: Settings2, perm: 'system.view' },
  { key: 'announce', label: 'Announcements', icon: Megaphone, perm: 'announcements.manage' },
] as const;

export default function AdminPage() {
  const { me, can } = useSession();
  const { path, navigate } = useRouter();
  const tabs = TABS.filter((t) => can(t.perm));
  const current = path.split('/')[2] ?? tabs[0]?.key ?? 'dashboard';
  const stepUp = useStepUp();
  if (me?.user.staffMfaRequired) return <Empty icon={<Shield size={32} />} title="Two-factor authentication required" body="Staff accounts must enable two-factor authentication before using admin tools." action={<Link to="/settings" className="btn btn-primary">Enable two-factor</Link>} />;
  return (
    <div className="admin">
      <nav className="admin-nav card" aria-label="Administration">
        {tabs.map((t) => <button key={t.key} className={`admin-tab ${current === t.key ? 'on' : ''}`} aria-current={current === t.key ? 'page' : undefined} onClick={() => navigate(`/admin/${t.key}`)}><t.icon size={16} />{t.label}</button>)}
      </nav>
      <section className="admin-body">
        {current === 'dashboard' && <Dashboard />}
        {current === 'users' && <UsersTab run={stepUp.run} />}
        {current === 'credits' && <LedgerTab run={stepUp.run} />}
        {current === 'invites' && <InvitesTab run={stepUp.run} />}
        {current === 'tables' && <TablesTab />}
        {current === 'moderation' && <ModerationTab />}
        {current === 'audit' && <AuditTab />}
        {current === 'config' && <ConfigTab run={stepUp.run} />}
        {current === 'announce' && <AnnounceTab />}
      </section>
      {stepUp.ui}
    </div>
  );
}

type Run = <T>(fn: () => Promise<T>) => Promise<T>;
const bytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`);

function Dashboard() {
  const d = useLoad(() => api.get<any>('/admin/dashboard'));
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorState message={d.error} retry={d.reload} />;
  const x = d.data;
  const memUsed = x.server.memTotal - x.server.memFree;
  const tiles: [string, string][] = [
    ['Registered users', fmt(x.users)], ['Active (24 h)', fmt(x.activeUsers24h)], ['Online now', fmt(x.online)], ['Active tables', `${x.activeTables} / ${x.tables}`],
    ['Active tournaments', fmt(x.activeTournaments)], ['Hands played', fmt(x.handsPlayed)], ['CPU load (1 min)', `${x.server.load[0].toFixed(2)} / ${x.server.cpus} cores`],
    ['RAM used', `${bytes(memUsed)} / ${bytes(x.server.memTotal)}`], ['Disk free', x.server.disk ? `${bytes(x.server.disk.free)} / ${bytes(x.server.disk.total)}` : 'n/a'],
    ['Database size', bytes(x.database.bytes)], ['App memory', bytes(x.server.rss)], ['Last backup', x.backup ? `${x.backup.ok ? 'OK' : 'FAILED'} · ${new Date(x.backup.finished_at).toLocaleString()}` : 'None recorded'],
  ];
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <div className="tiles">{tiles.map(([k, v]) => <div key={k} className="tile card"><span className="subtle">{k}</span><strong className="num">{v}</strong></div>)}</div>
      <div className="grid-2">
        <div className="card card-pad"><h3 className="panel-title">Recent registrations</h3><ul className="mini-list">{x.recentRegistrations.map((u: any) => <li key={u.id}><span>{u.username}</span><span className="subtle">{new Date(u.created_at).toLocaleDateString()}</span></li>)}</ul></div>
        <div className="card card-pad"><h3 className="panel-title">Recent security events</h3>{x.recentSecurityEvents.length ? <ul className="mini-list">{x.recentSecurityEvents.map((e: any, i: number) => <li key={i}><span className={`badge ${e.severity === 'high' ? 'badge-red' : ''}`}>{e.severity}</span><span>{e.kind}</span><span className="subtle">{new Date(e.created_at).toLocaleString()}</span></li>)}</ul> : <p className="subtle">None.</p>}</div>
        <div className="card card-pad"><h3 className="panel-title">Recent admin activity</h3><ul className="mini-list">{x.recentAdminActivity.map((e: any, i: number) => <li key={i}><span>{e.actor ?? 'system'}</span><span>{e.action}</span><span className="subtle">{new Date(e.created_at).toLocaleString()}</span></li>)}</ul></div>
        <div className="card card-pad"><h3 className="panel-title"><Database size={14} /> Server</h3><p className="muted num">Uptime {Math.floor(x.server.uptimeSec / 3600)} h {Math.floor((x.server.uptimeSec % 3600) / 60)} min · Database OK</p></div>
      </div>
    </div>
  );
}

function UsersTab({ run }: { run: Run }) {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useLoad(() => api.get<{ users: any[] }>(`/admin/users?q=${encodeURIComponent(query)}`), [query]);
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <div className="admin-toolbar">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="search"><Search size={16} /><input className="input" placeholder="Search username, name or player ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" /></form>
        {can('users.create') && <button className="btn btn-primary" onClick={() => setCreating(true)}>Create account</button>}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        {list.loading ? <Loading /> : (
          <table className="table-list">
            <thead><tr><th>ID</th><th>User</th><th>Role</th><th>Status</th><th>Level</th><th style={{ textAlign: 'right' }}>Wallet</th></tr></thead>
            <tbody>{list.data?.users.map((u) => (
              <tr key={u.id} onClick={() => setSelected(u.id)} style={{ cursor: 'pointer' }} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(u.id)}>
                <td className="num subtle">{u.public_id}</td><td><strong>{u.display_name}</strong> <span className="subtle">@{u.username}</span></td><td>{u.role}</td>
                <td><span className={`badge ${u.status === 'active' ? 'badge-green' : 'badge-red'}`}>{u.status}</span></td><td className="num">{u.level}</td><td className="num" style={{ textAlign: 'right' }}>{fmt(u.balance)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {selected && <UserDetail id={selected} run={run} onClose={() => { setSelected(null); list.reload(); }} />}
      {creating && <CreateUser run={run} onClose={() => { setCreating(false); list.reload(); }} />}
    </div>
  );
}

function CreateUser({ run, onClose }: { run: Run; onClose: () => void }) {
  const toast = useToast();
  const { me } = useSession();
  const [f, setF] = useState({ username: '', displayName: '', email: '', role: 'player' });
  const [link, setLink] = useState<string | null>(null);
  return (
    <Modal title="Create account" onClose={onClose} footer={link ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => {
      try { const r = await run(() => api.post<{ setupPath: string }>('/admin/users', { username: f.username, displayName: f.displayName, role: f.role, ...(f.email ? { email: f.email } : {}) })); setLink(`${location.origin}${r.setupPath}`); }
      catch (e) { toast({ title: 'Could not create', body: (e as Error).message, tone: 'error' }); }
    }}>Create</button></>}>
      {link ? (
        <>
          <p>Account created. Send this one-time setup link to the user privately. It expires in 72 hours. You never see their password.</p>
          <code className="secret" style={{ wordBreak: 'break-all' }}>{link}</code>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(link)}>Copy link</button>
        </>
      ) : (
        <>
          <Field label="Username"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
          <Field label="Display name"><input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
          <Field label="Email (optional)"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Role"><select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="player">Player</option><option value="moderator">Moderator</option>{me?.user.role === 'owner' && <option value="admin">Administrator</option>}</select></Field>
        </>
      )}
    </Modal>
  );
}

function UserDetail({ id, run, onClose }: { id: string; run: Run; onClose: () => void }) {
  const toast = useToast();
  const { can } = useSession();
  const d = useLoad(() => api.get<any>(`/admin/users/${id}`), [id]);
  const [credit, setCredit] = useState<{ kind: 'grant' | 'correction'; amount: string; reason: string } | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<unknown>) => { try { await run(fn); toast({ title: label, tone: 'success' }); d.reload(); } catch (e) { toast({ title: 'Action failed', body: (e as Error).message, tone: 'error' }); } };
  const reason = (what: string) => window.prompt(`Reason for ${what} (recorded in the audit log):`)?.trim();
  if (d.loading) return <Modal title="User" onClose={onClose}><Loading /></Modal>;
  if (!d.data) return null;
  const u = d.data.user;
  return (
    <Modal title={`${u.display_name} (@${u.username})`} onClose={onClose}>
      <div className="kv"><span>Player ID</span><span className="num">{u.public_id}</span></div>
      <div className="kv"><span>Role / status</span><span>{u.role} · {u.status}{u.suspended_until ? ` until ${new Date(u.suspended_until).toLocaleString()}` : ''}</span></div>
      <div className="kv"><span>2FA</span><span>{u.totp_enabled ? 'Enabled' : 'Not enabled'}</span></div>
      <div className="kv"><span>Level / XP</span><span className="num">{u.level} / {fmt(u.xp_total)}</span></div>
      {d.data.credits && <div className="kv"><span>Credits</span><span className="num">{credits(d.data.credits.wallet)} wallet · {fmt(d.data.credits.onTables)} on tables · ledger {d.data.credits.ledgerIntact ? 'intact' : 'INCONSISTENT'}</span></div>}
      <div className="kv"><span>Hands played</span><span className="num">{fmt(d.data.stats?.hands_played)}</span></div>
      <div className="kv"><span>Open reports</span><span>{d.data.reports.filter((r: any) => r.status === 'open').length}</span></div>
      <div className="kv"><span>Active sessions</span><span>{d.data.sessions.length}</span></div>
      <hr className="divider" />
      <div className="btn-wrap">
        {can('credits.grant') && <><button className="btn" onClick={() => setCredit({ kind: 'grant', amount: '', reason: '' })}>Grant credits</button><button className="btn" onClick={() => setCredit({ kind: 'correction', amount: '', reason: '' })}>Correct balance</button></>}
        {can('users.suspend') && (u.status === 'active'
          ? <><button className="btn" onClick={() => { const r = reason('suspension'); if (r) void act('User suspended', () => api.post(`/admin/users/${id}/status`, { status: 'suspended', reason: r, until: new Date(Date.now() + 7 * 864e5).toISOString() })); }}>Suspend 7 days</button><button className="btn btn-danger" onClick={() => { const r = reason('ban'); if (r) void act('User banned', () => api.post(`/admin/users/${id}/status`, { status: 'banned', reason: r })); }}>Ban</button></>
          : <button className="btn" onClick={() => { const r = reason('reactivation'); if (r) void act('User reactivated', () => api.post(`/admin/users/${id}/status`, { status: 'active', reason: r })); }}>Reactivate</button>)}
        {can('chat.moderate') && <button className="btn" onClick={() => { const r = reason('chat mute'); if (r) void act('Muted for 24 h', () => api.post(`/admin/users/${id}/mute`, { minutes: 1440, reason: r })); }}>Mute 24 h</button>}
        {can('users.revoke_sessions') && <button className="btn" onClick={() => void act('Sessions revoked', () => api.post(`/admin/users/${id}/revoke-sessions`))}>Revoke sessions</button>}
        {can('users.reset_password') && <button className="btn" onClick={async () => { try { const r = await run(() => api.post<{ resetPath: string }>(`/admin/users/${id}/reset-password`)); setResetLink(`${location.origin}${r.resetPath}`); } catch (e) { toast({ title: 'Failed', body: (e as Error).message, tone: 'error' }); } }}>Password reset link</button>}
        {can('roles.assign') && <select className="select" style={{ width: 'auto' }} aria-label="Change role" value="" onChange={(e) => e.target.value && void act('Role changed', () => api.post(`/admin/users/${id}/role`, { role: e.target.value }))}><option value="">Change role…</option><option value="player">Player</option><option value="moderator">Moderator</option><option value="admin">Administrator</option></select>}
      </div>
      {resetLink && <><p className="muted">One-time link, valid 60 minutes. Send it privately:</p><code className="secret" style={{ wordBreak: 'break-all' }}>{resetLink}</code></>}
      {credit && (
        <div className="card card-pad" style={{ display: 'grid', gap: 'var(--s3)' }}>
          <strong>{credit.kind === 'grant' ? 'Grant virtual credits' : 'Correction (compensating entry)'}</strong>
          <Field label="Amount (ALL)" hint={credit.kind === 'correction' ? 'Negative to remove, positive to add back.' : 'Positive whole number.'}><input className="input num" type="number" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} /></Field>
          <Field label="Reason (required, audited)"><input className="input" value={credit.reason} onChange={(e) => setCredit({ ...credit, reason: e.target.value })} /></Field>
          <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>Game credits only. Non-redeemable, with no cash value.</p>
          <div className="btn-wrap"><button className="btn btn-ghost" onClick={() => setCredit(null)}>Cancel</button><button className="btn btn-primary" disabled={!Number(credit.amount) || credit.reason.trim().length < 5} onClick={async () => {
            const key = newId();
            await act('Ledger entry recorded', () => api.post('/admin/credits', { userId: id, amount: Math.trunc(Number(credit.amount)), kind: credit.kind, reason: credit.reason, idempotencyKey: key }));
            setCredit(null);
          }}>Record entry</button></div>
        </div>
      )}
    </Modal>
  );
}

function LedgerTab({ run }: { run: Run }) {
  const { can } = useSession();
  const toast = useToast();
  const [type, setType] = useState('');
  const l = useLoad(() => api.get<{ entries: any[] }>(`/admin/credits/ledger${type ? `?type=${type}` : ''}`), [type]);
  const exportCsv = async () => {
    try {
      const csv = await run(() => api.get<string>(`/admin/credits/export${type ? `?type=${type}` : ''}`));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = 'noir-ledger.csv'; a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast({ title: 'Export failed', body: (e as Error).message, tone: 'error' }); }
  };
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <div className="admin-toolbar">
        <select className="select" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Entry type">
          <option value="">All entry types</option>{['ADMIN_GRANT', 'ADMIN_CORRECTION', 'TABLE_BUY_IN', 'TABLE_CASH_OUT', 'TOURNAMENT_ENTRY', 'TOURNAMENT_REFUND'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {can('credits.export') && <button className="btn" onClick={exportCsv}>Export CSV</button>}
      </div>
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>Append-only ledger. Balances are derived from entries; corrections are new compensating entries, never edits. Denomination ALL is a display label for non-redeemable game credits.</p>
      <div className="card" style={{ overflowX: 'auto' }}>
        {l.loading ? <Loading /> : (
          <table className="table-list">
            <thead><tr><th>When</th><th>User</th><th>Type</th><th style={{ textAlign: 'right' }}>Amount</th><th style={{ textAlign: 'right' }}>Before → After</th><th>By</th><th>Reason</th></tr></thead>
            <tbody>{l.data?.entries.map((e) => (
              <tr key={e.id}><td className="subtle">{new Date(e.created_at).toLocaleString()}</td><td>{e.username}</td><td><span className="badge">{e.entry_type}</span></td>
                <td className={`num ${e.amount > 0 ? 'gold' : ''}`} style={{ textAlign: 'right' }}>{e.amount > 0 ? '+' : ''}{fmt(e.amount)}</td><td className="num subtle" style={{ textAlign: 'right' }}>{fmt(e.balance_before)} → {fmt(e.balance_after)}</td>
                <td>{e.admin_name ?? '—'}</td><td>{e.reason ?? e.reference_type ?? ''}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function InvitesTab({ run }: { run: Run }) {
  const toast = useToast();
  const inv = useLoad(() => api.get<{ invitations: any[] }>('/admin/invitations'));
  const [code, setCode] = useState<string | null>(null);
  const [f, setF] = useState({ role: 'player', maxUses: 1, expiresInHours: 72, note: '' });
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <div className="card card-pad" style={{ display: 'grid', gap: 'var(--s3)' }}>
        <h3 className="panel-title">New invitation</h3>
        <div className="grid-2">
          <Field label="Role"><select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="player">Player</option><option value="moderator">Moderator</option></select></Field>
          <Field label="Uses"><input className="input num" type="number" min={1} max={100} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: Number(e.target.value) })} /></Field>
          <Field label="Valid for (hours)"><input className="input num" type="number" min={1} max={720} value={f.expiresInHours} onChange={(e) => setF({ ...f, expiresInHours: Number(e.target.value) })} /></Field>
          <Field label="Note"><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        </div>
        <button className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={async () => { try { const r = await run(() => api.post<{ code: string }>('/admin/invitations', { ...f, note: f.note || undefined })); setCode(r.code); inv.reload(); } catch (e) { toast({ title: 'Failed', body: (e as Error).message, tone: 'error' }); } }}>Create invitation</button>
        {code && <><p className="muted">Share this link privately. The code is shown only once:</p><code className="secret" style={{ wordBreak: 'break-all' }}>{`${location.origin}/register?code=${code}`}</code></>}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table-list"><thead><tr><th>Created</th><th>Role</th><th>Uses</th><th>Expires</th><th>Note</th></tr></thead>
          <tbody>{inv.data?.invitations.map((i) => <tr key={i.id}><td>{new Date(i.created_at).toLocaleDateString()}</td><td>{i.role}</td><td className="num">{i.uses}/{i.max_uses}</td><td>{new Date(i.expires_at).toLocaleString()}</td><td>{i.note}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function TablesTab() {
  const toast = useToast();
  const t = useLoad(() => api.get<{ tables: any[] }>('/admin/tables'));
  const set = async (id: string, status: string) => { try { await api.post(`/admin/tables/${id}/status`, { status }); t.reload(); } catch (e) { toast({ title: 'Failed', body: (e as Error).message, tone: 'error' }); } };
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      {t.loading ? <Loading /> : !t.data?.tables.length ? <Empty icon={<Spade size={28} />} title="No tables" body="Create tables from the lobby." /> : (
        <table className="table-list"><thead><tr><th>Name</th><th>Blinds</th><th>Seated</th><th>Type</th><th>Status</th><th /></tr></thead>
          <tbody>{t.data.tables.map((x) => <tr key={x.id}><td><Link to={`/table/${x.id}`}>{x.name}</Link></td><td className="num">{x.smallBlind}/{x.bigBlind}</td><td className="num">{x.seated}/{x.maxSeats}</td><td>{x.isPrivate ? 'Private' : 'Public'}</td><td>{x.status}</td>
            <td className="btn-wrap">{x.status === 'open' ? <button className="btn btn-sm" onClick={() => set(x.id, 'paused')}>Pause</button> : <button className="btn btn-sm" onClick={() => set(x.id, 'open')}>Resume</button>}<button className="btn btn-sm btn-danger" onClick={() => window.confirm('Close this table? Seated players are cashed out after the current hand.') && set(x.id, 'closed')}>Close</button></td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function ModerationTab() {
  const r = useLoad(() => api.get<{ reports: any[] }>('/admin/reports'));
  const set = async (id: string, status: string) => { await api.post(`/admin/reports/${id}`, { status }); r.reload(); };
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      {r.loading ? <Loading /> : !r.data?.reports.length ? <Empty icon={<ShieldAlert size={28} />} title="No reports" /> : (
        <table className="table-list"><thead><tr><th>When</th><th>Reporter</th><th>Target</th><th>Category</th><th>Details</th><th>Status</th><th /></tr></thead>
          <tbody>{r.data.reports.map((x) => <tr key={x.id}><td className="subtle">{new Date(x.created_at).toLocaleString()}</td><td>{x.reporter}</td><td><Link to={`/profile/${x.target_id}`}>{x.target}</Link></td><td>{x.category}</td><td style={{ maxWidth: 280 }}>{x.details}</td><td>{x.status}</td>
            <td className="btn-wrap">{x.status === 'open' && <><button className="btn btn-sm" onClick={() => set(x.id, 'actioned')}>Actioned</button><button className="btn btn-sm btn-ghost" onClick={() => set(x.id, 'dismissed')}>Dismiss</button></>}</td></tr>)}</tbody>
        </table>
      )}
      <p className="subtle" style={{ padding: 'var(--s3)', fontSize: 'var(--fs-xs)' }}>Statistical alerts are evidence for review, never automatic bans.</p>
    </div>
  );
}

function AuditTab() {
  const a = useLoad(() => api.get<{ entries: any[]; chainIntact: boolean; firstBrokenId: number | null }>('/admin/audit'));
  const s = useLoad(() => api.get<{ events: any[] }>('/admin/security-events'));
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      <div className="card card-pad">
        <h3 className="panel-title">Administrator audit log</h3>
        {a.data && <p>{a.data.chainIntact ? <span className="badge badge-green">Hash chain intact</span> : <span className="badge badge-red">Chain broken at entry {a.data.firstBrokenId}</span>}</p>}
        <div style={{ overflowX: 'auto' }}><table className="table-list"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>{a.data?.entries.map((e) => <tr key={e.id}><td className="subtle">{new Date(e.created_at).toLocaleString()}</td><td>{e.actor ?? 'system'}</td><td>{e.action}</td><td className="subtle">{e.target_type} {e.target_id?.slice(0, 8)}</td><td><code style={{ fontSize: 11 }}>{JSON.stringify(e.details).slice(0, 120)}</code></td></tr>)}</tbody></table></div>
      </div>
      <div className="card card-pad">
        <h3 className="panel-title">Security events</h3>
        <div style={{ overflowX: 'auto' }}><table className="table-list"><thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>IP</th><th>Details</th></tr></thead>
          <tbody>{s.data?.events.map((e) => <tr key={e.id}><td className="subtle">{new Date(e.created_at).toLocaleString()}</td><td>{e.severity}</td><td>{e.kind}</td><td className="num">{e.ip}</td><td><code style={{ fontSize: 11 }}>{JSON.stringify(e.details).slice(0, 100)}</code></td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

function ConfigTab({ run }: { run: Run }) {
  const toast = useToast();
  const c = useLoad(() => api.get<{ config: { key: string; value: any }[] }>('/admin/config'));
  const [edit, setEdit] = useState<Record<string, string>>({});
  const editable = ['maintenance', 'xp_rules', 'chat', 'leaderboards'];
  if (c.loading) return <Loading />;
  return (
    <div style={{ display: 'grid', gap: 'var(--s4)' }}>
      {c.data?.config.map((row) => (
        <div key={row.key} className="card card-pad" style={{ display: 'grid', gap: 'var(--s2)' }}>
          <h3 className="panel-title">{row.key}</h3>
          {editable.includes(row.key) ? (
            <>
              <textarea className="textarea num" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, minHeight: 110 }} value={edit[row.key] ?? JSON.stringify(row.value, null, 2)} onChange={(e) => setEdit({ ...edit, [row.key]: e.target.value })} aria-label={`${row.key} JSON`} />
              <button className="btn" style={{ justifySelf: 'start' }} onClick={async () => {
                try { const v = JSON.parse(edit[row.key] ?? JSON.stringify(row.value)); await run(() => api.put(`/admin/config/${row.key}`, v)); toast({ title: 'Saved', tone: 'success' }); c.reload(); }
                catch (e) { toast({ title: 'Not saved', body: (e as Error).message, tone: 'error' }); }
              }}>Save</button>
            </>
          ) : <code style={{ fontSize: 12 }}>{JSON.stringify(row.value)}</code>}
        </div>
      ))}
    </div>
  );
}

function AnnounceTab() {
  const toast = useToast();
  const [f, setF] = useState({ title: '', body: '' });
  return (
    <div className="card card-pad" style={{ display: 'grid', gap: 'var(--s3)', maxWidth: 640 }}>
      <Field label="Title"><input className="input" value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Message"><textarea className="textarea" value={f.body} maxLength={2000} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <button className="btn btn-primary" style={{ justifySelf: 'start' }} disabled={f.title.length < 3 || !f.body} onClick={async () => { try { await api.post('/admin/announcements', f); toast({ title: 'Published', tone: 'success' }); setF({ title: '', body: '' }); } catch (e) { toast({ title: 'Failed', body: (e as Error).message, tone: 'error' }); } }}>Publish announcement</button>
    </div>
  );
}
