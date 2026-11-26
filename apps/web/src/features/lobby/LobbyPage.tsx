import { useEffect, useMemo, useState } from 'react';
import { Lock, Plus, Spade, Users, Zap, Megaphone, Trophy, History, ArrowRight } from 'lucide-react';
import type { TableSummary } from '@noir/shared';
import { RANK_NAMES } from '@noir/shared';
import { api, credits, fmt } from '../../net/api';
import { emit, getSocket } from '../../net/socket';
import { useSession } from '../../state/session';
import { Link, useRouter } from '../../lib/router';
import { Empty, Field, Modal, useLoad, useToast } from '../../lib/ui';
import { ChatPanel } from '../social/Chat';

type Filter = 'all' | 'public' | 'private' | 'open';
type Sort = 'blinds' | 'seats' | 'name';

export function LobbyPage() {
  const { me, can } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('blinds');
  const [creating, setCreating] = useState(() => new URLSearchParams(location.search).get('create') === '1');
  const ann = useLoad(() => api.get<{ announcements: { id: string; title: string; body: string }[] }>('/announcements'));
  const lb = useLoad(() => api.get<{ entries: { rank: number; userId: string; displayName: string; value: number }[] }>('/leaderboards/level'));
  const friends = useLoad(() => api.get<{ friends: { id: string; display_name: string; online: boolean; level: number }[] }>('/friends'));
  const recent = useLoad(() => api.get<{ hands: { id: string; table_name: string; net: number; ended_at: string }[] }>('/me/hands'));

  useEffect(() => {
    const s = getSocket();
    const load = () => void emit<TableSummary[]>('lobby:subscribe').then((a) => a.ok && a.data && setTables(a.data));
    load();
    s.on('connect', load);
    const on = (list: TableSummary[]) => setTables((prev) => {
      const priv = (prev ?? []).filter((t) => t.isPrivate);
      return [...list, ...priv.filter((p) => !list.some((t) => t.id === p.id))];
    });
    s.on('lobby:tables', on);
    return () => { s.off('lobby:tables', on); s.off('connect', load); };
  }, []);

  const shown = useMemo(() => {
    let list = [...(tables ?? [])];
    if (filter === 'public') list = list.filter((t) => !t.isPrivate);
    if (filter === 'private') list = list.filter((t) => t.isPrivate);
    if (filter === 'open') list = list.filter((t) => t.seated < t.maxSeats);
    list.sort((a, b) => sort === 'blinds' ? a.bigBlind - b.bigBlind : sort === 'seats' ? (b.maxSeats - b.seated) - (a.maxSeats - a.seated) : a.name.localeCompare(b.name));
    return list;
  }, [tables, filter, sort]);

  const activePlayers = (tables ?? []).reduce((a, t) => a + t.seated, 0);
  const quickJoin = () => {
    const wallet = me?.credits.wallet ?? 0;
    const t = (tables ?? []).filter((x) => !x.isPrivate && x.status === 'open' && x.seated < x.maxSeats && x.minBuyIn <= wallet).sort((a, b) => b.seated - a.seated)[0];
    if (!t) return toast({ title: 'No table available', body: wallet ? 'No open seat matches your balance right now.' : 'You need game credits to sit down. Ask an administrator.', tone: 'error' });
    navigate(`/table/${t.id}?sit=1`);
  };
  const p = me!.progress;
  const pct = p && p.nextLevelXp ? Math.min(100, Math.round(((p.xp - p.levelXp) / (p.nextLevelXp - p.levelXp)) * 100)) : 100;

  return (
    <div className="lobby">
      <section className="welcome card card-pad">
        <div>
          <p className="subtle" style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Welcome back</p>
          <h1 className="display" style={{ fontSize: 'var(--fs-3xl)', lineHeight: 1.05 }}>{me!.user.displayName}</h1>
          {p && (
            <div style={{ marginTop: 'var(--s3)', display: 'grid', gap: 6, maxWidth: 360 }}>
              <div style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center' }}>
                <span className="badge badge-gold">Level {p.level}</span>
                <span className="badge">{RANK_NAMES[p.rank as keyof typeof RANK_NAMES] ?? p.rank}</span>
                <span className="subtle num" style={{ fontSize: 'var(--fs-xs)' }}>{fmt(p.xp)} XP{p.nextLevelXp ? ` / ${fmt(p.nextLevelXp)}` : ''}</span>
              </div>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Level progress"><i style={{ width: `${pct}%` }} /></div>
            </div>
          )}
        </div>
        <div className="welcome-stats">
          <div><span className="subtle">Wallet</span><strong className="num">{credits(me!.credits.wallet)}</strong></div>
          <div><span className="subtle">On tables</span><strong className="num">{credits(me!.credits.onTables)}</strong></div>
          <div><span className="subtle">Players seated</span><strong className="num">{activePlayers}</strong></div>
          <div className="welcome-actions">
            <button className="btn btn-primary btn-lg" onClick={quickJoin}><Zap size={18} /> Quick join</button>
            <button className="btn btn-lg" onClick={() => setCreating(true)}><Plus size={18} /> {can('tables.manage') ? 'Create table' : 'Private table'}</button>
          </div>
        </div>
      </section>

      <section className="tables card card-pad" aria-labelledby="tables-h">
        <div className="section-head">
          <h2 id="tables-h" className="panel-title" style={{ margin: 0 }}><Spade size={16} /> Tables</h2>
          <div className="filters">
            <div className="seg" role="radiogroup" aria-label="Filter tables">
              {(['all', 'open', 'public', 'private'] as Filter[]).map((f) => <button key={f} role="radio" aria-checked={filter === f} className={`seg-btn ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f === 'open' ? 'Open seats' : f[0]!.toUpperCase() + f.slice(1)}</button>)}
            </div>
            <select className="select" style={{ width: 'auto', minHeight: 36 }} aria-label="Sort tables" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="blinds">Sort: blinds</option><option value="seats">Sort: free seats</option><option value="name">Sort: name</option>
            </select>
          </div>
        </div>
        {tables === null ? <div style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>
          : shown.length === 0 ? <Empty icon={<Spade size={32} />} title="No tables match" body={can('tables.manage') ? 'Create the first table for your community.' : 'Create a private table and invite friends.'} action={<button className="btn" onClick={() => setCreating(true)}><Plus size={16} /> Create table</button>} />
          : (
            <ul className="table-cards">
              {shown.map((t) => (
                <li key={t.id} className="table-card">
                  <div className="tc-main">
                    <strong>{t.name}</strong>
                    <span className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>No-Limit Hold'em · Buy-in {fmt(t.minBuyIn)}–{fmt(t.maxBuyIn)}</span>
                  </div>
                  <div className="tc-meta">
                    <span className="badge num">{fmt(t.smallBlind)}/{fmt(t.bigBlind)}</span>
                    <span className="badge"><Users size={12} /> {t.seated}/{t.maxSeats}</span>
                    {t.isPrivate ? <span className="badge badge-gold"><Lock size={12} /> Private</span> : <span className="badge badge-green">Public</span>}
                    {t.status !== 'open' && <span className="badge badge-red">{t.status}</span>}
                  </div>
                  <button className="btn" onClick={() => navigate(`/table/${t.id}`)}>{t.seated < t.maxSeats ? 'Join' : 'Watch'} <ArrowRight size={16} /></button>
                </li>
              ))}
            </ul>
          )}
        <p className="subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--s3)' }}>Have a private table link? Open it directly; you will be asked for its access code.</p>
      </section>

      <aside className="side">
        {(ann.data?.announcements.length ?? 0) > 0 && (
          <section className="card card-pad">
            <h2 className="panel-title"><Megaphone size={16} /> Announcements</h2>
            <div style={{ display: 'grid', gap: 'var(--s3)' }}>{ann.data!.announcements.map((a) => <div key={a.id}><strong>{a.title}</strong><p className="muted" style={{ fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap' }}>{a.body}</p></div>)}</div>
          </section>
        )}
        <section className="card card-pad">
          <h2 className="panel-title"><Trophy size={16} /> Top players</h2>
          {lb.data?.entries.length ? (
            <ol className="mini-lb">{lb.data.entries.slice(0, 5).map((e) => <li key={e.userId}><span className="rank">{e.rank}</span><Link to={`/profile/${e.userId}`}>{e.displayName}</Link><span className="num subtle">Lv {e.value}</span></li>)}</ol>
          ) : <p className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>No rankings yet.</p>}
          <Link to="/leaderboards" style={{ fontSize: 'var(--fs-sm)' }}>All leaderboards</Link>
        </section>
        <section className="card card-pad">
          <h2 className="panel-title"><Users size={16} /> Friends</h2>
          {friends.data?.friends.length ? (
            <ul className="mini-list">{friends.data.friends.map((f) => <li key={f.id}><span className={`dot ${f.online ? 'on' : ''}`} aria-label={f.online ? 'At a table' : 'Away'} /><Link to={`/profile/${f.id}`}>{f.display_name}</Link><span className="subtle num">Lv {f.level}</span></li>)}</ul>
          ) : <p className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>Add friends from their profile.</p>}
        </section>
        {(recent.data?.hands.length ?? 0) > 0 && (
          <section className="card card-pad">
            <h2 className="panel-title"><History size={16} /> Recent hands</h2>
            <ul className="mini-list">{recent.data!.hands.slice(0, 5).map((h) => <li key={h.id}><span>{h.table_name}</span><span className={`num ${h.net > 0 ? 'gold' : 'subtle'}`}>{h.net > 0 ? '+' : ''}{fmt(h.net)}</span></li>)}</ul>
          </section>
        )}
        <section className="card" style={{ overflow: 'hidden' }}>
          <h2 className="panel-title" style={{ padding: 'var(--s4) var(--s4) 0' }}>Lobby chat</h2>
          <ChatPanel channel="lobby" />
        </section>
      </aside>

      {creating && <CreateTableModal canPublic={can('tables.manage')} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/table/${id}`)} />}
    </div>
  );
}

function CreateTableModal({ canPublic, onClose, onCreated }: { canPublic: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', maxSeats: 6, smallBlind: 5, bigBlind: 10, minBuyIn: 200, maxBuyIn: 2000, actionSeconds: 25, isPrivate: !canPublic, accessCode: '', durationMinutes: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { durationMinutes, accessCode, ...rest } = f;
      const body = { ...rest, ...(f.isPrivate ? { accessCode } : {}), ...(durationMinutes ? { durationMinutes } : {}) };
      const r = await api.post<{ table: { id: string } }>('/tables', body);
      onCreated(r.table.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Create a table" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || f.name.trim().length < 3} onClick={submit}>{busy ? 'Creating…' : 'Create table'}</button></>}>
      <Field label="Table name"><input className="input" value={f.name} maxLength={40} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Friday Night" /></Field>
      <div className="grid-2">
        <Field label="Seats"><select className="select" value={f.maxSeats} onChange={num('maxSeats')}>{[2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{n} players</option>)}</select></Field>
        <Field label="Action timer"><select className="select" value={f.actionSeconds} onChange={num('actionSeconds')}>{[15, 20, 25, 30, 45, 60].map((n) => <option key={n} value={n}>{n} seconds</option>)}</select></Field>
        <Field label="Small blind"><input className="input num" type="number" min={1} value={f.smallBlind} onChange={num('smallBlind')} /></Field>
        <Field label="Big blind"><input className="input num" type="number" min={1} value={f.bigBlind} onChange={num('bigBlind')} /></Field>
        <Field label="Min buy-in" hint="At least 10 big blinds"><input className="input num" type="number" min={1} value={f.minBuyIn} onChange={num('minBuyIn')} /></Field>
        <Field label="Max buy-in"><input className="input num" type="number" min={1} value={f.maxBuyIn} onChange={num('maxBuyIn')} /></Field>
      </div>
      {canPublic && <label className="check"><input type="checkbox" checked={f.isPrivate} onChange={(e) => setF({ ...f, isPrivate: e.target.checked })} /> Private table</label>}
      {f.isPrivate && (
        <div className="grid-2">
          <Field label="Access code" hint="Share it with your guests"><input className="input" value={f.accessCode} minLength={4} maxLength={32} onChange={(e) => setF({ ...f, accessCode: e.target.value })} /></Field>
          <Field label="Duration"><select className="select" value={f.durationMinutes} onChange={num('durationMinutes')}><option value={0}>Until closed</option>{[60, 120, 180, 240, 360].map((m) => <option key={m} value={m}>{m / 60} hours</option>)}</select></Field>
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  );
}
