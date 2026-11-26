import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, Gift, LogOut, MessageSquare, PauseCircle, PlayCircle, ShieldCheck, ShieldAlert, Coins, User, X } from 'lucide-react';
import { api, credits, fmt } from '../../net/api';
import { useSession } from '../../state/session';
import { Link, useRouter } from '../../lib/router';
import { Field, Loading, Modal, useToast } from '../../lib/ui';
import { ChatPanel } from '../social/Chat';
import { PlayingCard } from './Card';
import { Dealer, useDealerQueue } from './Dealer';
import { useTable, type HandV, type Options, type PlayerV } from './useTable';
import type { SeatView } from '@noir/shared';

const GIFT_ICON: Record<string, string> = { rose: '🌹', champagne: '🥂', gold_star: '⭐', trophy: '🏆', applause: '👏' };

function useReducedMotion() {
  const [r, setR] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}

function usePortrait() {
  const [p, setP] = useState(() => innerHeight > innerWidth * 1.1);
  useEffect(() => {
    const on = () => setP(innerHeight > innerWidth * 1.1);
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return p;
}

/** Seat coordinates (percent of the felt box) on an ellipse, rotated so the viewer sits bottom-centre. */
function seatPos(seat: number, maxSeats: number, anchor: number, portrait: boolean) {
  const angle = Math.PI / 2 + ((seat - anchor) * 2 * Math.PI) / maxSeats;
  const rx = portrait ? 44 : 47;
  const ry = portrait ? 45 : 43;
  return { x: 50 + rx * Math.cos(angle), y: 50 + ry * Math.sin(angle) };
}

export function TablePage({ tableId }: { tableId: string }) {
  const { me, refresh } = useSession();
  const { navigate } = useRouter();
  const toast = useToast();
  const [code, setCode] = useState<string | null>(null);
  const t = useTable(tableId, me!.user.id, code);
  const reduced = useReducedMotion();
  const portrait = usePortrait();
  const [sitSeat, setSitSeat] = useState<number | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [fairOpen, setFairOpen] = useState(false);
  const [seatMenu, setSeatMenu] = useState<SeatView | null>(null);
  const [flights, setFlights] = useState<{ id: number; seat: number }[]>([]);
  const flightId = useRef(0);
  const feltRef = useRef<HTMLDivElement>(null);

  const anchor = t.mySeat ?? 0;
  const maxSeats = t.table?.maxSeats ?? 6;
  const onDealCard = useCallback((seat: number) => {
    const id = ++flightId.current;
    setFlights((f) => [...f, { id, seat }]);
    setTimeout(() => setFlights((f) => f.filter((x) => x.id !== id)), 650);
  }, []);
  const onBoard = useCallback(() => undefined, []);
  const pose = useDealerQueue(t.cues, reduced, onDealCard, onBoard);

  // Auto-open the buy-in for quick join.
  useEffect(() => {
    if (!t.table || t.mySeat !== null || !location.search.includes('sit=1')) return;
    const free = Array.from({ length: t.table.maxSeats }, (_, i) => i).find((i) => !t.seats.some((s) => s.seat === i));
    if (free !== undefined) setSitSeat(free);
    history.replaceState(null, '', location.pathname);
  }, [t.table, t.mySeat, t.seats]);

  if (t.error && (t.error.code === 'PRIVATE' || t.error.code === 'BAD_CODE')) return <AccessCode error={t.error.code === 'BAD_CODE' ? t.error.message : null} onSubmit={setCode} onBack={() => navigate('/lobby')} />;
  if (t.error) return <div className="empty"><strong>{t.error.message}</strong><Link to="/lobby">Back to the lobby</Link></div>;
  if (!t.table) return <Loading label="Joining table" />;

  const hand = t.hand;
  const me_ = hand?.players.find((p) => p.playerId === me!.user.id) ?? null;
  const mySeatView = t.seats.find((s) => s.userId === me!.user.id) ?? null;
  const totalPot = (hand?.pots.reduce((a, p) => a + p.amount, 0) ?? 0) + (hand?.players.reduce((a, p) => a + p.streetCommitted, 0) ?? 0);
  const fairness = hand?.fairness ?? null;
  const myContributed = fairness?.contributions.some((c) => c.playerId === me!.user.id) ?? false;

  return (
    <div className={`table-page ${portrait ? 'portrait' : 'landscape'}`}>
      <header className="table-top">
        <Link to="/lobby" className="btn btn-ghost btn-sm" aria-label="Back to lobby"><ArrowLeft size={16} /><span className="hide-sm">Lobby</span></Link>
        <div className="tt-title">
          <strong>{t.table.name}</strong>
          <span className="subtle num">NLHE · {fmt(t.table.smallBlind)}/{fmt(t.table.bigBlind)}{hand ? ` · Hand #${hand.handNo}` : ''}</span>
        </div>
        <div className="tt-actions">
          <button className="btn btn-ghost btn-sm tooltip" data-tip="Fairness" aria-label="Fairness details" onClick={() => setFairOpen(true)}>
            {Object.values(t.verify).includes('fail') ? <ShieldAlert size={16} className="danger" /> : <ShieldCheck size={16} className="gold" />}
          </button>
          <button className="btn btn-ghost btn-sm" aria-label="Table chat" aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}><MessageSquare size={16} /></button>
          {mySeatView && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => void t.sitOut(!mySeatView.sittingOut)} aria-label={mySeatView.sittingOut ? 'Sit back in' : 'Sit out next hand'}>
                {mySeatView.sittingOut ? <PlayCircle size={16} /> : <PauseCircle size={16} />}<span className="hide-sm">{mySeatView.sittingOut ? 'Sit in' : 'Sit out'}</span>
              </button>
              <button className="btn btn-ghost btn-sm" onClick={async () => { const r = await t.leave(); if (r.ok) { void refresh(); toast({ title: 'You left the table', body: 'Your chips return to your wallet after the hand.' }); } }}><LogOut size={16} /><span className="hide-sm">Leave</span></button>
            </>
          )}
        </div>
      </header>

      {t.status !== 'open' && <div className="banner">This table is {t.status}.</div>}

      <div className="table-stage">
        <div className="dealer-wrap" aria-hidden={reduced}><Dealer pose={reduced ? 'idle' : pose} /></div>
        <div className="felt" ref={feltRef}>
          <div className="felt-inner">
            <div className="felt-logo display" aria-hidden="true">NOIR</div>
            <div className="board" aria-label="Community cards">
              {[0, 1, 2, 3, 4].map((i) => {
                const c = hand?.board[i];
                const winningHand = hand?.ended && hand.winners.length > 0;
                return c ? <PlayingCard key={`${hand!.handId}-${i}`} card={c} size={portrait ? 'md' : 'lg'} verified={t.verify[c]} className="deal-in" highlight={!!winningHand && false} /> : <div key={i} className={`card-slot ${portrait ? 'md' : 'lg'}`} />;
              })}
            </div>
            <div className="pot" aria-live="polite">
              {totalPot > 0 && <><Coins size={16} className="gold" /><span className="num">Pot {fmt(totalPot)}</span></>}
              {hand && hand.pots.length > 1 && <span className="subtle num side-pots">{hand.pots.map((p, i) => `${i === 0 ? 'Main' : `Side ${i}`} ${fmt(p.amount)}`).join(' · ')}</span>}
            </div>
            {hand?.ended && hand.winners.length > 0 && (
              <div className="winner-banner" role="status">
                {hand.winners.map((w, i) => {
                  const seat = t.seats.find((s) => s.seat === w.seat);
                  return <span key={i}><strong>{seat?.displayName ?? `Seat ${w.seat + 1}`}</strong> wins {fmt(w.amount)}{w.handName ? ` with ${w.handName}` : ''}</span>;
                })}
              </div>
            )}
          </div>

          {Array.from({ length: maxSeats }, (_, seat) => {
            const pos = seatPos(seat, maxSeats, anchor, portrait);
            const sv = t.seats.find((s) => s.seat === seat) ?? null;
            const pv = hand?.players.find((p) => p.seat === seat && p.playerId === sv?.userId) ?? null;
            return (
              <SeatBox key={seat} seat={seat} pos={pos} sv={sv} pv={pv} hand={hand} isMe={sv?.userId === me!.user.id} verify={t.verify} portrait={portrait}
                canSit={!mySeatView && !sv && t.status === 'open'} onSit={() => setSitSeat(seat)} onOpen={() => sv && setSeatMenu(sv)}
                offset={t.serverOffset} actionSeconds={t.table!.actionSeconds} gift={t.gifts.find((g) => g.toUserId === sv?.userId)} />
            );
          })}

          {flights.map((f) => {
            const to = seatPos(f.seat, maxSeats, anchor, portrait);
            return <div key={f.id} className="flight" style={{ '--tx': `${to.x}%`, '--ty': `${to.y}%` } as React.CSSProperties}><PlayingCard faceDown size="sm" /></div>;
          })}
        </div>
      </div>

      <footer className="action-dock">
        {me_ && hand && !hand.ended && hand.toActSeat === me_.seat && hand.options ? (
          <ActionBar options={hand.options} hand={hand} me={me_} bigBlind={t.table.bigBlind} pot={totalPot} act={t.act} />
        ) : mySeatView ? (
          <div className="dock-status">
            {mySeatView.stack === 0 && !me_ ? <RebuyInline min={t.table.minBuyIn} max={t.table.maxBuyIn} wallet={me!.credits.wallet} onRebuy={async (a) => { const r = await t.rebuy(a); if (!r.ok) toast({ title: 'Could not add chips', body: r.error, tone: 'error' }); else void refresh(); }} />
              : me_ && hand && !hand.ended ? <span className="muted">{me_.status === 'folded' ? 'You folded. Next hand soon.' : `Waiting for ${t.seats.find((s) => s.seat === hand.toActSeat)?.displayName ?? 'next street'}…`}</span>
              : <span className="muted">{mySeatView.sittingOut ? 'You are sitting out.' : t.seats.length < 2 ? 'Waiting for another player…' : 'Next hand starting…'}</span>}
          </div>
        ) : (
          <div className="dock-status"><span className="muted">You are watching. Pick an empty seat to play.</span></div>
        )}
      </footer>

      <aside className={`table-chat ${chatOpen ? 'open' : ''}`} aria-hidden={!chatOpen}>
        <div className="tc-head"><strong>Table chat</strong><button className="btn btn-ghost btn-icon btn-sm" aria-label="Close chat" onClick={() => setChatOpen(false)}><X size={16} /></button></div>
        <ChatPanel channel={`table:${tableId}`} compact ready={!!t.table} />
      </aside>

      {sitSeat !== null && (
        <BuyInModal min={t.table.minBuyIn} max={t.table.maxBuyIn} wallet={me!.credits.wallet} seat={sitSeat} onClose={() => setSitSeat(null)}
          onConfirm={async (amount) => {
            const r = await t.sit(sitSeat, amount);
            if (r.ok) { setSitSeat(null); void refresh(); } else toast({ title: 'Could not sit down', body: r.error, tone: 'error' });
          }} />
      )}
      {fairOpen && <FairnessModal hand={hand} verify={t.verify} contributed={myContributed} seated={!!mySeatView} onClose={() => setFairOpen(false)} />}
      {seatMenu && <SeatMenu seat={seatMenu} isMe={seatMenu.userId === me!.user.id} tableId={tableId} onClose={() => setSeatMenu(null)} />}
    </div>
  );
}

function SeatBox({ seat, pos, sv, pv, hand, isMe, verify, portrait, canSit, onSit, onOpen, offset, actionSeconds, gift }: {
  seat: number; pos: { x: number; y: number }; sv: SeatView | null; pv: PlayerV | null; hand: HandV | null; isMe: boolean; verify: Record<string, string>; portrait: boolean;
  canSit: boolean; onSit: () => void; onOpen: () => void; offset: number; actionSeconds: number; gift: { item: string; fromName: string } | undefined;
}) {
  const style = { left: `${pos.x}%`, top: `${pos.y}%` } as React.CSSProperties;
  if (!sv) {
    return (
      <div className="seat empty" style={style}>
        {canSit ? <button className="btn btn-sm seat-sit" onClick={onSit} aria-label={`Sit at seat ${seat + 1}`}>Sit</button> : <span className="subtle seat-num" aria-hidden="true">{seat + 1}</span>}
      </div>
    );
  }
  const acting = hand && !hand.ended && hand.toActSeat === seat;
  const folded = pv?.status === 'folded';
  const isWinner = hand?.ended && hand.winners.some((w) => w.seat === seat);
  // Bet chips sit between the seat and the centre.
  const bx = pos.x + (50 - pos.x) * 0.42;
  const by = pos.y + (50 - pos.y) * 0.42;
  return (
    <>
      <div className={`seat ${isMe ? 'me' : ''} ${acting ? 'acting' : ''} ${folded ? 'folded' : ''} ${isWinner ? 'winner' : ''} ${!sv.connected ? 'away' : ''}`} style={style}>
        <div className="seat-cards">
          {pv && pv.holeCount > 0 && !folded && (pv.hole
            ? pv.hole.map((c) => <PlayingCard key={c} card={c} size={isMe ? (portrait ? 'md' : 'lg') : 'sm'} verified={verify[c] as 'ok' | 'fail' | 'pending' | undefined} className="deal-in" />)
            : [0, 1].map((i) => <PlayingCard key={i} faceDown size="sm" />))}
        </div>
        <button className="seat-plate" onClick={onOpen} aria-label={`${sv.displayName}, stack ${sv.stack}${acting ? ', acting' : ''}`}>
          {acting && hand?.deadline && <TimerRing deadline={hand.deadline} offset={offset} total={actionSeconds * 1000} />}
          <span className="avatar">{sv.displayName.slice(0, 1).toUpperCase()}</span>
          <span className="seat-info">
            <span className="seat-name">{sv.displayName}</span>
            <span className="seat-stack num">{fmt(pv ? pv.stack : sv.stack)}</span>
          </span>
          {hand && hand.buttonSeat === seat && <span className="dealer-btn" aria-label="Dealer button">D</span>}
        </button>
        {(pv?.lastAction || pv?.handName || sv.sittingOut || !sv.connected) && (
          <span className={`seat-tag ${isWinner ? 'gold' : ''}`}>{isWinner && pv?.handName ? pv.handName : pv?.handName ?? pv?.lastAction ?? (!sv.connected ? 'Away' : 'Sitting out')}</span>
        )}
        {gift && <span className="gift-pop" aria-live="polite" title={`Gift from ${gift.fromName}`}>{GIFT_ICON[gift.item] ?? '🎁'}</span>}
      </div>
      {pv && pv.streetCommitted > 0 && (
        <div className="bet" style={{ left: `${bx}%`, top: `${by}%` }}><i className="chip" /><span className="num">{fmt(pv.streetCommitted)}</span></div>
      )}
    </>
  );
}

function TimerRing({ deadline, offset, total }: { deadline: number; offset: number; total: number }) {
  const [left, setLeft] = useState(() => Math.max(0, deadline - (Date.now() + offset)));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, deadline - (Date.now() + offset))), 200);
    return () => clearInterval(id);
  }, [deadline, offset]);
  const frac = Math.min(1, left / total);
  return (
    <svg className={`timer-ring ${frac < 0.25 ? 'low' : ''}`} viewBox="0 0 44 44" aria-label={`${Math.ceil(left / 1000)} seconds left`}>
      <circle cx="22" cy="22" r="20" pathLength={1} strokeDasharray={`${frac} 1`} />
    </svg>
  );
}

function ActionBar({ options, hand, me, bigBlind, pot, act }: { options: Options; hand: HandV; me: PlayerV; bigBlind: number; pot: number; act: (t: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin', a?: number) => Promise<{ ok: boolean; error?: string }> }) {
  const toast = useToast();
  const aggressive = options.canBet || options.canRaise;
  const [amount, setAmount] = useState(options.minTo);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAmount(options.minTo), [options.minTo, hand.seq]);
  const send = async (type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin', a?: number) => {
    if (busy) return;
    setBusy(true);
    const r = await act(type, a);
    setBusy(false);
    if (!r.ok) toast({ title: 'Action not accepted', body: r.error, tone: 'error' });
  };
  // Keyboard shortcuts: F fold, C check/call, R bet/raise, A all-in.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') void send('fold');
      if (k === 'c') void send(options.canCheck ? 'check' : 'call');
      if (k === 'r' && aggressive) void send(options.canBet ? 'bet' : 'raise', amount);
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  });
  const presets = [
    { label: '½ Pot', v: Math.round(hand.currentBet + (pot + options.callAmount) / 2) },
    { label: '¾ Pot', v: Math.round(hand.currentBet + ((pot + options.callAmount) * 3) / 4) },
    { label: 'Pot', v: hand.currentBet + pot + options.callAmount },
  ].map((p) => ({ ...p, v: Math.min(options.maxTo, Math.max(options.minTo, p.v)) }));
  const clamp = (v: number) => Math.min(options.maxTo, Math.max(options.minTo, Math.round(v)));
  const isAllIn = amount >= options.maxTo;
  return (
    <div className="action-bar" role="group" aria-label="Your action">
      {aggressive && options.maxTo > options.minTo && (
        <div className="raise-row">
          <div className="presets">{presets.map((p) => <button key={p.label} className="btn btn-sm" onClick={() => setAmount(p.v)}>{p.label}</button>)}<button className="btn btn-sm" onClick={() => setAmount(options.maxTo)}>All-in</button></div>
          <input type="range" className="slider" min={options.minTo} max={options.maxTo} step={Math.max(1, Math.floor(bigBlind / 2))} value={amount} onChange={(e) => setAmount(clamp(Number(e.target.value)))} aria-label="Bet amount" />
          <input className="input num amount" type="number" inputMode="numeric" min={options.minTo} max={options.maxTo} value={amount} onChange={(e) => setAmount(Number(e.target.value))} onBlur={() => setAmount(clamp(amount))} aria-label="Bet amount" />
        </div>
      )}
      <div className="action-row">
        <button className="btn btn-lg act-fold" disabled={busy} onClick={() => send('fold')}>Fold</button>
        {options.canCheck ? <button className="btn btn-lg act-check" disabled={busy} onClick={() => send('check')}>Check</button>
          : <button className="btn btn-lg act-call" disabled={busy} onClick={() => send('call')}>{options.callAmount >= me.stack ? 'Call all-in' : 'Call'} <span className="num">{fmt(options.callAmount)}</span></button>}
        {aggressive && <button className="btn btn-primary btn-lg act-raise" disabled={busy} onClick={() => send(isAllIn ? 'allin' : options.canBet ? 'bet' : 'raise', isAllIn ? undefined : amount)}>{isAllIn ? 'All-in' : options.canBet ? 'Bet' : 'Raise to'} <span className="num">{fmt(isAllIn ? options.maxTo : amount)}</span></button>}
      </div>
    </div>
  );
}

function BuyInModal({ min, max, wallet, seat, onClose, onConfirm }: { min: number; max: number; wallet: number; seat: number; onClose: () => void; onConfirm: (a: number) => Promise<void> }) {
  const cap = Math.min(max, wallet);
  const [v, setV] = useState(Math.min(cap, Math.max(min, Math.round((min + max) / 2))));
  const [busy, setBusy] = useState(false);
  const enough = wallet >= min;
  return (
    <Modal title={`Take seat ${seat + 1}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!enough || busy} onClick={async () => { setBusy(true); await onConfirm(v); setBusy(false); }}>{busy ? 'Sitting…' : `Buy in for ${fmt(v)}`}</button></>}>
      {enough ? (
        <>
          <p className="muted">Wallet: <strong className="num">{credits(wallet)}</strong></p>
          <input type="range" className="slider" min={min} max={cap} value={v} onChange={(e) => setV(Number(e.target.value))} aria-label="Buy-in amount" />
          <Field label="Buy-in" hint={`Between ${fmt(min)} and ${fmt(cap)}`}><input className="input num" type="number" min={min} max={cap} value={v} onChange={(e) => setV(Math.min(cap, Math.max(min, Number(e.target.value) || min)))} /></Field>
          <p className="subtle" style={{ fontSize: 'var(--fs-xs)' }}>Game credits only. Non-redeemable, with no cash value.</p>
        </>
      ) : <p className="error-text">You need at least {credits(min)} to sit here. Your wallet holds {credits(wallet)}.</p>}
    </Modal>
  );
}

function RebuyInline({ min, max, wallet, onRebuy }: { min: number; max: number; wallet: number; onRebuy: (a: number) => void }) {
  const amount = Math.min(max, wallet);
  return amount >= min ? <button className="btn btn-primary" onClick={() => onRebuy(amount)}>Add {fmt(amount)} chips</button> : <span className="muted">Out of chips. Not enough credits in your wallet to rebuy.</span>;
}

function AccessCode({ error, onSubmit, onBack }: { error: string | null; onSubmit: (c: string) => void; onBack: () => void }) {
  const [v, setV] = useState('');
  return (
    <Modal title="Private table" onClose={onBack} footer={<><button className="btn btn-ghost" onClick={onBack}>Back</button><button className="btn btn-primary" disabled={v.length < 4} onClick={() => onSubmit(v)}>Enter</button></>}>
      <Field label="Access code" error={error}><input className="input" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function FairnessModal({ hand, verify, contributed, seated, onClose }: { hand: HandV | null; verify: Record<string, string>; contributed: boolean; seated: boolean; onClose: () => void }) {
  const f = hand?.fairness;
  const entries = Object.entries(verify);
  const ok = entries.filter(([, s]) => s === 'ok').length;
  const bad = entries.filter(([, s]) => s === 'fail');
  return (
    <Modal title="Fairness" onClose={onClose}>
      {!f ? <p className="muted">The next hand's deck commitment will appear here.</p> : (
        <div style={{ display: 'grid', gap: 'var(--s3)', fontSize: 'var(--fs-sm)' }}>
          <p>Before this hand, the server committed to its shuffled deck. Every card you have seen has been checked on <em>your</em> device against that commitment.</p>
          <div className="kv"><span>Deck commitment</span><code>{f.root.slice(0, 16)}…{f.root.slice(-8)}</code></div>
          <div className="kv"><span>Entropy mix</span><code>{f.mix.slice(0, 16)}…</code></div>
          <div className="kv"><span>Player contributions</span><span>{f.contributions.length}{seated ? (contributed ? ' (including yours)' : ' (yours was not included)') : ''}</span></div>
          <div className="kv"><span>Cards verified</span><span className={bad.length ? 'danger' : 'gold'}>{ok} verified{bad.length ? `, ${bad.length} FAILED` : ''}</span></div>
          {seated && !contributed && <p className="subtle">Your device contributes randomness for the next hand automatically while you are seated.</p>}
          <p className="subtle">Opponents' folded cards are never revealed. See FAIRNESS_AND_AUDIT.md for the full protocol and its limits.</p>
        </div>
      )}
    </Modal>
  );
}

function SeatMenu({ seat, isMe, tableId, onClose }: { seat: SeatView; isMe: boolean; tableId: string; onClose: () => void }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<{ key: string; name: string; remaining_today: number }[] | null>(null);
  useEffect(() => { if (!isMe) void api.get<{ items: { key: string; name: string; remaining_today: number }[] }>('/gifts/catalog').then((r) => setCatalog(r.items)).catch(() => setCatalog([])); }, [isMe]);
  const send = async (itemKey: string) => {
    try {
      await api.post('/gifts', { toUserId: seat.userId, itemKey, tableId });
      toast({ title: 'Gift sent', tone: 'success' });
      onClose();
    } catch (e) {
      toast({ title: 'Could not send gift', body: (e as Error).message, tone: 'error' });
    }
  };
  const items = useMemo(() => catalog ?? [], [catalog]);
  return (
    <Modal title={seat.displayName} onClose={onClose}>
      <p className="muted">Level {seat.level} · Stack <span className="num">{fmt(seat.stack)}</span></p>
      <Link to={`/profile/${seat.userId}`} className="btn"><User size={16} /> View profile</Link>
      {!isMe && (
        <div>
          <p className="panel-title"><Gift size={14} /> Send a gift <span className="subtle" style={{ textTransform: 'none', letterSpacing: 0 }}>(cosmetic only)</span></p>
          {catalog === null ? <div className="spinner" /> : (
            <div className="gift-grid">
              {items.map((g) => <button key={g.key} className="btn gift-btn" disabled={g.remaining_today <= 0} onClick={() => send(g.key)}><span aria-hidden="true">{GIFT_ICON[g.key] ?? '🎁'}</span>{g.name}<span className="subtle num">{g.remaining_today} left</span></button>)}
            </div>
          )}
        </div>
      )}
      <p className="subtle" style={{ fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center', gap: 6 }}><Clock size={12} /> {seat.connected ? 'Connected' : 'Disconnected'}{seat.sittingOut ? ' · Sitting out' : ''}</p>
    </Modal>
  );
}
