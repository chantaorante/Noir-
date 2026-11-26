import { useEffect, useRef, useState } from 'react';
import type { Cue } from './useTable';

/**
 * Animated dealer: a layered SVG character with two articulated arms (shoulder → elbow → hand).
 * It reacts to server events via "cues" and is PRESENTATION ONLY: nothing here influences the game.
 * Poses are CSS transforms on SVG groups, so they are GPU-composited and cheap on phones.
 * If cues arrive faster than they can be played, the queue fast-forwards so it never lags the table.
 */
export type Pose = 'idle' | 'collect' | 'shuffle' | 'cut' | 'deal' | 'board' | 'sweep' | 'reveal' | 'push';

const DURATION: Record<Pose, number> = { idle: 0, collect: 500, shuffle: 1100, cut: 450, deal: 260, board: 420, sweep: 520, reveal: 600, push: 500 };

export function useDealerQueue(cues: Cue[], reduced: boolean, onDealCard: (seat: number) => void, onBoard: (count: number) => void) {
  const [pose, setPose] = useState<Pose>('idle');
  const queue = useRef<{ pose: Pose; seat?: number; count?: number }[]>([]);
  const seen = useRef(0);
  const running = useRef(false);

  useEffect(() => {
    for (const c of cues) {
      if (c.id <= seen.current) continue;
      seen.current = c.id;
      if (c.kind === 'shuffle') queue.current.push({ pose: 'collect' }, { pose: 'shuffle' }, { pose: 'cut' });
      if (c.kind === 'deal') for (let round = 0; round < 2; round++) for (const s of c.seats ?? []) queue.current.push({ pose: 'deal', seat: s });
      if (c.kind === 'board') queue.current.push({ pose: 'board', count: c.count ?? 1 });
      if (c.kind === 'sweep') queue.current.push({ pose: 'sweep' });
      if (c.kind === 'reveal') queue.current.push({ pose: 'reveal' });
      if (c.kind === 'award') queue.current.push({ pose: 'push' });
    }
    if (running.current) return;
    running.current = true;
    const step = () => {
      const next = queue.current.shift();
      if (!next) { running.current = false; setPose('idle'); return; }
      // Fast-forward when behind so animation never trails the authoritative state.
      const speed = reduced ? 0 : queue.current.length > 12 ? 0.25 : queue.current.length > 6 ? 0.5 : 1;
      setPose(next.pose);
      if (next.pose === 'deal' && next.seat !== undefined && !reduced) onDealCard(next.seat);
      if (next.pose === 'board' && !reduced) onBoard(next.count ?? 1);
      setTimeout(step, DURATION[next.pose] * speed);
    };
    step();
  }, [cues, reduced, onDealCard, onBoard]);

  return pose;
}

export function Dealer({ pose }: { pose: Pose }) {
  return (
    <svg className={`dealer pose-${pose}`} viewBox="0 0 320 200" role="img" aria-label={`Dealer ${pose === 'idle' ? 'waiting' : pose}`}>
      <defs>
        <linearGradient id="dl-jacket" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#24262b" /><stop offset="1" stopColor="#101114" /></linearGradient>
        <linearGradient id="dl-skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d9b38f" /><stop offset="1" stopColor="#b88c69" /></linearGradient>
        <linearGradient id="dl-vest" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2c2417" /><stop offset="1" stopColor="#15110a" /></linearGradient>
        <radialGradient id="dl-shadow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#000" stopOpacity="0.55" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="160" cy="196" rx="140" ry="16" fill="url(#dl-shadow)" />
      <g className="dl-body">
        {/* torso */}
        <path d="M88 200 C 92 140, 118 118, 160 116 C 202 118, 228 140, 232 200 Z" fill="url(#dl-jacket)" />
        <path d="M136 120 L160 176 L184 120 C 176 118, 168 117, 160 117 C 152 117, 144 118, 136 120 Z" fill="#ece8e0" />
        <path d="M128 124 L160 200 L192 124 L184 120 L160 176 L136 120 Z" fill="url(#dl-vest)" />
        <path d="M150 128 L160 136 L170 128 L160 124 Z" fill="#c9a96a" />
        <circle cx="160" cy="154" r="2" fill="#c9a96a" /><circle cx="160" cy="168" r="2" fill="#c9a96a" />
        {/* head */}
        <g className="dl-head">
          <rect x="150" y="98" width="20" height="20" rx="6" fill="url(#dl-skin)" />
          <ellipse cx="160" cy="78" rx="24" ry="28" fill="url(#dl-skin)" />
          <path d="M136 74 C 136 52, 150 44, 162 44 C 178 44, 186 56, 185 72 C 178 62, 166 58, 150 62 C 144 64, 140 68, 136 74 Z" fill="#1d1712" />
          <g className="dl-eyes"><ellipse cx="151" cy="80" rx="2.2" ry="2.6" fill="#1b1411" /><ellipse cx="169" cy="80" rx="2.2" ry="2.6" fill="#1b1411" /></g>
          <path d="M153 94 Q160 98 167 94" stroke="#7a4f3a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
      </g>
      {/* left arm (viewer's left) */}
      <g className="dl-arm left" style={{ transformOrigin: '106px 140px' }}>
        <path d="M100 136 C 92 150, 88 164, 92 176 L108 178 C 108 166, 112 154, 116 144 Z" fill="url(#dl-jacket)" />
        <g className="dl-fore" style={{ transformOrigin: '100px 176px' }}>
          <path d="M92 174 C 96 182, 108 186, 124 186 L126 176 C 114 176, 106 172, 106 168 Z" fill="url(#dl-jacket)" />
          <rect x="118" y="174" width="8" height="12" rx="2" fill="#ece8e0" />
          <g className="dl-hand" style={{ transformOrigin: '130px 180px' }}>
            <path d="M126 172 C 136 170, 144 174, 146 180 C 144 186, 136 189, 126 188 Z" fill="url(#dl-skin)" />
            <g className="dl-deck"><rect x="132" y="170" width="16" height="22" rx="2" fill="#13151a" stroke="#c9a96a" strokeWidth="0.8" /><rect x="134" y="172" width="12" height="18" rx="1.5" fill="none" stroke="#c9a96a" strokeOpacity="0.5" strokeWidth="0.5" /></g>
          </g>
        </g>
      </g>
      {/* right arm */}
      <g className="dl-arm right" style={{ transformOrigin: '214px 140px' }}>
        <path d="M220 136 C 228 150, 232 164, 228 176 L212 178 C 212 166, 208 154, 204 144 Z" fill="url(#dl-jacket)" />
        <g className="dl-fore" style={{ transformOrigin: '220px 176px' }}>
          <path d="M228 174 C 224 182, 212 186, 196 186 L194 176 C 206 176, 214 172, 214 168 Z" fill="url(#dl-jacket)" />
          <rect x="194" y="174" width="8" height="12" rx="2" fill="#ece8e0" />
          <g className="dl-hand" style={{ transformOrigin: '190px 180px' }}>
            <path d="M194 172 C 184 170, 176 174, 174 180 C 176 186, 184 189, 194 188 Z" fill="url(#dl-skin)" />
            <g className="dl-card"><rect x="168" y="168" width="14" height="20" rx="2" fill="#13151a" stroke="#c9a96a" strokeWidth="0.8" /></g>
          </g>
        </g>
      </g>
    </svg>
  );
}
