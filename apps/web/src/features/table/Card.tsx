import { memo } from 'react';

const SUIT: Record<string, { sym: string; red: boolean; name: string }> = {
  s: { sym: '♠', red: false, name: 'spades' }, h: { sym: '♥', red: true, name: 'hearts' },
  d: { sym: '♦', red: true, name: 'diamonds' }, c: { sym: '♣', red: false, name: 'clubs' },
};
const RANK_NAME: Record<string, string> = { T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

export const PlayingCard = memo(function PlayingCard({ card, size = 'md', faceDown = false, verified, highlight = false, className = '' }: { card?: string | null; size?: 'sm' | 'md' | 'lg'; faceDown?: boolean; verified?: 'pending' | 'ok' | 'fail' | undefined; highlight?: boolean; className?: string }) {
  if (!card || faceDown) {
    return <div className={`pcard back ${size} ${className}`} aria-label="Face-down card" role="img"><div className="back-pattern" /></div>;
  }
  const r = card[0]!;
  const s = SUIT[card[1]!]!;
  const rank = r === 'T' ? '10' : r;
  return (
    <div className={`pcard face ${size} ${s.red ? 'red' : 'black'} ${highlight ? 'hl' : ''} ${className}`} role="img" aria-label={`${RANK_NAME[r] ?? r} of ${s.name}${verified === 'ok' ? ', verified' : ''}`}>
      <span className="pc-rank">{rank}</span>
      <span className="pc-suit">{s.sym}</span>
      <span className="pc-center" aria-hidden="true">{s.sym}</span>
      {verified === 'fail' && <span className="pc-warn" title="This card failed fairness verification">!</span>}
    </div>
  );
});
