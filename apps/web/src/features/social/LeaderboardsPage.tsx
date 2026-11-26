import { useState } from 'react';
import { Trophy } from 'lucide-react';
import { api, fmt } from '../../net/api';
import { Link } from '../../lib/router';
import { Empty, ErrorState, Loading, useLoad } from '../../lib/ui';
import { useSession } from '../../state/session';

export function LeaderboardsPage() {
  const { me } = useSession();
  const boards = useLoad(() => api.get<{ boards: { key: string; label: string }[] }>('/leaderboards'));
  const [key, setKey] = useState('level');
  const board = useLoad(() => api.get<{ label: string; entries: { rank: number; userId: string; displayName: string; value: number }[] }>(`/leaderboards/${key}`), [key]);
  return (
    <div className="narrow">
      <h1 className="display page-title">Leaderboards</h1>
      <div className="tabs" role="tablist">
        {(boards.data?.boards ?? []).map((b) => <button key={b.key} role="tab" aria-selected={key === b.key} className="tab" onClick={() => setKey(b.key)}>{b.label}</button>)}
      </div>
      <div className="card">
        {board.loading ? <Loading /> : board.error ? <ErrorState message={board.error} retry={board.reload} /> : !board.data?.entries.length ? <Empty icon={<Trophy size={32} />} title="No rankings yet" body="Play some hands to appear here." /> : (
          <table className="table-list">
            <thead><tr><th style={{ width: 64 }}>Rank</th><th>Player</th><th style={{ textAlign: 'right' }}>{board.data.label}</th></tr></thead>
            <tbody>{board.data.entries.map((e) => (
              <tr key={e.userId} className={e.userId === me?.user.id ? 'me-row' : ''}>
                <td className="num"><span className={`rank-badge r${Math.min(e.rank, 4)}`}>{e.rank}</span></td>
                <td><Link to={`/profile/${e.userId}`}>{e.displayName}</Link></td>
                <td className="num" style={{ textAlign: 'right' }}>{fmt(e.value)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--s3)' }}>Rankings use server-recorded play only. Ties share a rank. Suspended accounts are excluded.</p>
    </div>
  );
}
