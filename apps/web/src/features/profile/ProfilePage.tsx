import { useEffect, useState } from 'react';
import { Award, Ban, Flag, Gift, Lock, UserPlus, VolumeX } from 'lucide-react';
import { RANK_NAMES } from '@noir/shared';
import { api, fmt } from '../../net/api';
import { ErrorState, Field, Loading, Modal, useLoad, useToast } from '../../lib/ui';
import { useSession } from '../../state/session';

interface Profile {
  profile: { id: string; playerId: number; username: string; displayName: string; avatarKey: string; bio: string | null; favoriteMode: string; level: number; xp: number; rank: string; joinedAt: string; status: string; isFriend: boolean };
  stats: Record<string, number>;
  achievements: { key: string; name: string; description: string; rarity: string; threshold: number; progress: number; unlocked_at: string | null }[];
  giftsReceived: { item_key: string; name: string; rarity: string; n: number }[];
}

export function ProfilePage({ userId }: { userId: string }) {
  const { me } = useSession();
  const toast = useToast();
  const p = useLoad(() => api.get<Profile>(`/profiles/${userId}`), [userId]);
  const quests = useLoad(() => (userId === me?.user.id ? api.get<{ quests: { key: string; name: string; period: string; target: number; progress: number; xp_reward: number; completed_at: string | null }[] }>('/me/quests') : Promise.resolve(null)), [userId]);
  const [report, setReport] = useState(false);
  const [editing, setEditing] = useState(false);
  if (p.loading) return <Loading />;
  if (p.error || !p.data) return <ErrorState message={p.error ?? 'Not found'} retry={p.reload} />;
  const { profile: pr, stats: s, achievements, giftsReceived } = p.data;
  const mine = pr.id === me?.user.id;
  const doAct = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast({ title: msg, tone: 'success' }); p.reload(); } catch (e) { toast({ title: 'Not possible', body: (e as Error).message, tone: 'error' }); } };
  const statRows: [string, string][] = [
    ['Hands played', fmt(s.handsPlayed)], ['Hands won', fmt(s.handsWon)], ['Win rate', `${s.winRate}%`], ['Showdowns', fmt(s.showdowns)],
    ['Showdowns won', fmt(s.showdownsWon)], ['Folds', fmt(s.folds)], ['Average pot won', fmt(s.avgPotWon)], ['Largest pot', fmt(s.largestPot)],
    ['Tournaments', fmt(s.tournamentsPlayed)], ['Tournament wins', fmt(s.tournamentWins)], ['Current streak', fmt(s.currentStreak)], ['Best streak', fmt(s.bestStreak)],
  ];
  return (
    <div className="profile">
      <section className="card card-pad profile-head">
        <span className="avatar xl">{pr.displayName.slice(0, 1).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="display" style={{ fontSize: 'var(--fs-2xl)' }}>{pr.displayName}</h1>
          <p className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>@{pr.username} · Player ID {pr.playerId} · Joined {new Date(pr.joinedAt).toLocaleDateString()}</p>
          <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginTop: 'var(--s2)' }}>
            <span className="badge badge-gold">Level {pr.level}</span>
            <span className="badge">{RANK_NAMES[pr.rank as keyof typeof RANK_NAMES] ?? pr.rank}</span>
            <span className="badge num">{fmt(pr.xp)} XP</span>
            <span className="badge">{pr.status}</span>
            <span className="badge">{pr.favoriteMode}</span>
          </div>
          {pr.bio && <p style={{ marginTop: 'var(--s3)', whiteSpace: 'pre-wrap' }}>{pr.bio}</p>}
        </div>
        <div className="profile-actions">
          {mine ? <button className="btn" onClick={() => setEditing(true)}>Edit profile</button> : (
            <>
              {!pr.isFriend && <button className="btn" onClick={() => doAct(() => api.post('/friends/requests', { userId: pr.id }), 'Friend request sent')}><UserPlus size={16} /> Add friend</button>}
              <button className="btn btn-ghost" onClick={() => doAct(() => api.post(`/mutes/${pr.id}`), 'Player muted')}><VolumeX size={16} /> Mute</button>
              <button className="btn btn-ghost" onClick={() => doAct(() => api.post(`/blocks/${pr.id}`), 'Player blocked')}><Ban size={16} /> Block</button>
              <button className="btn btn-ghost" onClick={() => setReport(true)}><Flag size={16} /> Report</button>
            </>
          )}
        </div>
      </section>

      <section className="card card-pad">
        <h2 className="panel-title">Statistics</h2>
        <dl className="stat-grid">{statRows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}</dl>
      </section>

      {mine && quests.data && (
        <section className="card card-pad">
          <h2 className="panel-title">Missions</h2>
          <div style={{ display: 'grid', gap: 'var(--s3)' }}>
            {quests.data.quests.map((q) => (
              <div key={q.key} className="quest">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{q.name} <span className="badge">{q.period}</span></span><span className="subtle num">{q.completed_at ? 'Complete' : `${q.progress}/${q.target}`} · +{q.xp_reward} XP</span></div>
                <div className="progress"><i style={{ width: `${Math.min(100, (q.progress / q.target) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card card-pad">
        <h2 className="panel-title"><Award size={16} /> Achievements</h2>
        <div className="ach-grid">
          {achievements.map((a) => (
            <div key={a.key} className={`ach ${a.unlocked_at ? 'unlocked' : ''} rarity-${a.rarity}`} title={a.description}>
              <span className="ach-icon">{a.unlocked_at ? <Award size={22} /> : <Lock size={18} />}</span>
              <strong>{a.name}</strong>
              <span className="subtle">{a.description}</span>
              <span className={`badge rar-${a.rarity}`}>{a.rarity}</span>
              {!a.unlocked_at && <div className="progress" style={{ width: '100%' }}><i style={{ width: `${Math.min(100, (a.progress / a.threshold) * 100)}%` }} /></div>}
            </div>
          ))}
        </div>
      </section>

      <section className="card card-pad">
        <h2 className="panel-title"><Gift size={16} /> Gifts received</h2>
        {giftsReceived.length === 0 ? <p className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>No gifts yet.</p> : (
          <div style={{ display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' }}>{giftsReceived.map((g) => <span key={g.item_key} className={`badge rar-${g.rarity}`}>{g.name} × {g.n}</span>)}</div>
        )}
      </section>

      {report && <ReportModal targetId={pr.id} onClose={() => setReport(false)} />}
      {editing && <EditProfile initial={pr} onClose={() => { setEditing(false); p.reload(); }} />}
    </div>
  );
}

function ReportModal({ targetId, onClose }: { targetId: string; onClose: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState('chat_abuse');
  const [details, setDetails] = useState('');
  return (
    <Modal title="Report player" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={async () => { try { await api.post('/reports', { targetUserId: targetId, category, details }); toast({ title: 'Report sent', body: 'A moderator will review it.', tone: 'success' }); onClose(); } catch (e) { toast({ title: 'Could not send', body: (e as Error).message, tone: 'error' }); } }}>Send report</button></>}>
      <Field label="Reason"><select className="select" value={category} onChange={(e) => setCategory(e.target.value)}><option value="chat_abuse">Abusive chat</option><option value="cheating">Cheating</option><option value="collusion">Collusion</option><option value="spam">Spam</option><option value="other">Other</option></select></Field>
      <Field label="Details (optional)"><textarea className="textarea" maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
    </Modal>
  );
}

const AVATARS = ['default', 'ace', 'king', 'queen', 'jack', 'club', 'diamond', 'heart', 'spade', 'crown', 'chip', 'moon'];
function EditProfile({ initial, onClose }: { initial: Profile['profile']; onClose: () => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [f, setF] = useState({ displayName: initial.displayName, bio: initial.bio ?? '', avatarKey: initial.avatarKey });
  useEffect(() => undefined, []);
  return (
    <Modal title="Edit profile" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => { try { await api.patch('/me/profile', f); await refresh(); onClose(); } catch (e) { toast({ title: 'Could not save', body: (e as Error).message, tone: 'error' }); } }}>Save</button></>}>
      <Field label="Display name"><input className="input" maxLength={32} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></Field>
      <Field label="Avatar"><select className="select" value={f.avatarKey} onChange={(e) => setF({ ...f, avatarKey: e.target.value })}>{AVATARS.map((a) => <option key={a} value={a}>{a[0]!.toUpperCase() + a.slice(1)}</option>)}</select></Field>
      <Field label="Bio" hint={`${f.bio.length}/280`}><textarea className="textarea" maxLength={280} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
    </Modal>
  );
}
