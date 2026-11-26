// The poker table. PRESENTATION ONLY: it mirrors authoritative server events and never decides anything.
// Every action is a request the server validates; the page just renders what comes back.
import { api, credits, emit, field, fill, fmt, h, icon, initials, input, link, listen, loading, modal, navigate, newId, session, svg, toast } from '../core.js';
import { randomEntropy, verifyReveal } from '../fairness.js';
import { chatPanel } from './chat.js';
import { createDealer } from './dealer.js';

const GIFT_ICON = { rose: '🌹', champagne: '🥂', gold_star: '⭐', trophy: '🏆', applause: '👏' };
const SUIT = { s: ['♠', false, 'spades'], h: ['♥', true, 'hearts'], d: ['♦', true, 'diamonds'], c: ['♣', false, 'clubs'] };
const RANK_NAME = { T: '10', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

// ------------------------------------------------------------------ cards
function playingCard(card, { size = 'md', faceDown = false, verified, cls = '' } = {}) {
  if (!card || faceDown) return h(`div.pcard.back.${size}`, { class: cls, role: 'img', 'aria-label': 'Face-down card' }, h('div.back-pattern'));
  const r = card[0];
  const [sym, red, name] = SUIT[card[1]];
  return h(`div.pcard.face.${size}.${red ? 'red' : 'black'}`, { class: cls, role: 'img', 'aria-label': `${RANK_NAME[r] ?? r} of ${name}${verified === 'ok' ? ', verified' : ''}` },
    h('span.pc-rank', r === 'T' ? '10' : r), h('span.pc-suit', sym), h('span.pc-center', { 'aria-hidden': 'true' }, sym),
    verified === 'fail' && h('span.pc-warn', { title: 'This card failed fairness verification' }, '!'));
}

// ------------------------------------------------------------------ hand state from server events
function applyEvent(hand, ev, meta, mySeat) {
  if (ev.type === 'HAND_STARTED') {
    const same = hand?.handId === meta.handId;
    return {
      handId: meta.handId, handNo: same ? hand.handNo : (hand?.handNo ?? 0) + 1, street: 'preflop', buttonSeat: ev.buttonSeat, sbSeat: ev.sbSeat, bbSeat: ev.bbSeat,
      board: [], currentBet: 0, toActSeat: null, seq: meta.seq, pots: [], options: null, deadline: null, fairness: same ? hand.fairness : null, winners: [], ended: false,
      players: ev.players.map((p) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, streetCommitted: 0, status: 'active', hole: same ? hand.players.find((x) => x.seat === p.seat)?.hole ?? null : null, holeCount: 0 })),
    };
  }
  if (!hand || hand.handId !== meta.handId) return hand;
  const n = hand;
  n.seq = meta.seq;
  const P = (seat) => n.players.find((p) => p.seat === seat);
  switch (ev.type) {
    case 'ANTE_POSTED': { const p = P(ev.seat); if (p) { p.stack = ev.stack; if (ev.stack === 0) p.status = 'allin'; } break; }
    case 'BLIND_POSTED': { const p = P(ev.seat); if (p) { p.stack = ev.stack; p.streetCommitted = ev.amount; if (ev.allIn) p.status = 'allin'; } n.currentBet = Math.max(n.currentBet, ev.amount); break; }
    case 'HOLE_CARDS_DEALT': for (const s of ev.seats) { const p = P(s); if (p) p.holeCount = 2; } break;
    case 'PLAYER_ACTED': {
      const p = P(ev.seat);
      if (p) { p.stack = ev.stack; p.streetCommitted = ev.streetCommitted; p.lastAction = ev.allIn ? 'All-in' : ev.action[0].toUpperCase() + ev.action.slice(1); if (ev.action === 'fold') p.status = 'folded'; else if (ev.allIn) p.status = 'allin'; }
      n.currentBet = ev.currentBet; n.toActSeat = null; n.options = null; n.deadline = null;
      break;
    }
    case 'TURN': n.toActSeat = ev.seat; n.options = ev.seat === mySeat ? ev.options : null; n.deadline = meta.deadline ?? null; break;
    case 'STREET_DEALT': n.board = ev.board; n.street = ev.street; n.currentBet = 0; for (const p of n.players) { p.streetCommitted = 0; if (p.status !== 'folded') p.lastAction = undefined; } break;
    case 'POTS_UPDATED': n.pots = ev.pots; for (const p of n.players) p.streetCommitted = 0; break;
    case 'UNCALLED_RETURNED': { const p = P(ev.seat); if (p) { p.stack += ev.amount; p.streetCommitted = 0; } break; }
    case 'SHOWDOWN': n.street = 'showdown'; for (const r of ev.reveals) { const p = P(r.seat); if (p) { p.hole = r.cards; p.handName = r.hand.name; } } break;
    case 'POT_AWARDED': for (const w of ev.winners) n.winners.push({ ...w, potIndex: ev.potIndex, handName: ev.handName }); break;
    case 'HAND_ENDED': n.ended = true; n.street = 'complete'; n.toActSeat = null; n.options = null; n.deadline = null; for (const s of ev.stacks) { const p = P(s.seat); if (p) { p.stack = s.stack; p.streetCommitted = 0; } } break;
  }
  return n;
}

function handFromSnapshot(x) {
  if (!x) return null;
  return {
    handId: x.handId, handNo: x.handNo, street: x.street, buttonSeat: x.buttonSeat, sbSeat: x.sbSeat, bbSeat: x.bbSeat, board: x.board,
    currentBet: x.currentBet, toActSeat: x.toActSeat, seq: x.seq, pots: x.pots, options: x.options, deadline: x.deadline, fairness: x.fairness,
    winners: [], ended: x.street === 'complete',
    players: x.players.map((p) => ({ seat: p.seat, playerId: p.playerId, stack: p.stack, streetCommitted: p.streetCommitted, status: p.status, hole: p.hole, holeCount: p.holeCount })),
  };
}

/** Seat coordinates (percent of the felt box) on an ellipse, rotated so the viewer sits bottom-centre. */
function seatPos(seat, maxSeats, anchor) {
  const angle = Math.PI / 2 + ((seat - anchor) * 2 * Math.PI) / maxSeats;
  return { x: 50 + 46 * Math.cos(angle), y: 50 + 43 * Math.sin(angle) };
}

/**
 * The table is always laid out horizontally. On phones held upright, CSS rotates the whole table 90°
 * (see .table-page in app.css). Where the browser allows it (Android Chrome, installed app), the first tap
 * also enters full screen and locks landscape, so the phone really turns; iOS Safari keeps the CSS fallback.
 */
function landscapeLock() {
  if (!matchMedia('(pointer: coarse)').matches) return () => {};
  let entered = false;
  const lock = async () => {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); entered = true; }
      await screen.orientation?.lock?.('landscape');
    } catch { /* not supported here: the CSS rotation handles it */ }
  };
  addEventListener('pointerup', lock, { once: true });
  return () => {
    removeEventListener('pointerup', lock);
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
    if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
}

// ------------------------------------------------------------------ page
export function tablePage(host, tableId) {
  const myId = session.me.user.id;
  const st = { table: null, seats: [], mySeat: null, hand: null, serverOffset: 0, status: 'open' };
  let accessCode = null;
  let error = null;
  const verify = {};            // card -> 'pending' | 'ok' | 'fail'
  const fairnessByHand = {};    // handId -> commitment (survives the HAND_STARTED / handStarted ordering race)
  const pendingReveals = {};
  const gifts = [];
  const countedHands = new Set();
  let handsPlayed = 0;
  const animatedCards = new Set(); // cards that already played their deal-in animation
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => reducedMq.matches;
  let chatOpen = false;
  let fairModal = null;
  let codeModal = null;
  let destroyed = false;

  const fairnessOf = (hand) => hand?.fairness ?? (hand ? fairnessByHand[hand.handId] : null) ?? null;
  const mySeatView = () => st.seats.find((s) => s.userId === myId) ?? null;

  // ---------- static skeleton
  const feltInner = h('div.felt-inner');
  const board = h('div.board', { 'aria-label': 'Community cards' });
  const pot = h('div.pot', { 'aria-live': 'polite' });
  const winner = h('div', { style: { display: 'contents' } });
  feltInner.append(board, pot, winner);
  const seatsLayer = h('div', { style: { display: 'contents' } });
  const dealer = createDealer({ reduced, onDealCard: flyCard });
  const felt = h('div.felt', h('div.dealer-wrap', dealer.el), feltInner, seatsLayer);
  const dock = h('footer.action-dock');
  const head = h('div.tp-head');
  const meta = h('div.tp-meta.label');
  const stats = h('div.tp-stats');
  const topbar = h('header.table-top');
  const statusBanner = h('div', { style: { display: 'contents' } });
  const playersList = h('ul');
  const playersCount = h('span');
  const chat = chatPanel(`table:${tableId}`, { compact: true });
  const aside = h('aside.table-chat', { 'aria-label': 'Table chat and players' },
    h('div.tc-head', h('strong', 'Table chat'), h('span.label.tc-live', h('i.dot.on'), ' Connected'),
      h('button.btn.btn-ghost.btn-icon.btn-sm.tc-close', { 'aria-label': 'Close chat', onclick: () => setChat(false) }, icon('x', 16))),
    h('div.tc-chat', chat.el),
    h('div.tc-players', h('div.tc-players-head.label', h('span', 'At this table'), playersCount), playersList));
  const page = h('div.table-page',
    topbar, statusBanner,
    h('section.tp-main', head,
      h('div.tp-card', meta, h('div.table-stage', felt), dock, h('p.tp-note.label', 'Game credits only · non-redeemable · no real-money play')),
      stats),
    aside);

  function setChat(v) { chatOpen = v; aside.classList.toggle('open', v); schedule(); }

  // ---------- rendering (batched to one paint per frame)
  let queued = false;
  function schedule() { if (!queued && !destroyed) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } }

  function paint() {
    if (destroyed) return;
    if (error && (error.code === 'PRIVATE' || error.code === 'BAD_CODE')) return showAccessCode();
    if (error) return fill(host, h('div.empty', h('strong', error.message), link('/lobby', 'Back to the lobby')));
    if (!st.table) return fill(host, loading('Joining table'));
    if (page.parentNode !== host) fill(host, page);
    const t = st.table;
    const hand = st.hand;
    const msv = mySeatView();
    const meP = hand?.players.find((p) => p.playerId === myId) ?? null;
    const failed = Object.values(verify).includes('fail');
    const fairBtn = () => h('button.btn.btn-ghost.btn-sm.tooltip', { 'data-tip': 'Fairness', 'aria-label': 'Fairness details', onclick: openFairness },
      failed ? icon('shield-alert', 16, 'danger') : icon('shield-check', 16, 'gold'));
    const live = hand && !hand.ended;

    fill(topbar,
      link('/lobby', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Back to lobby' }, icon('arrow-left'), h('span.hide-sm', 'Lobby')),
      h('div.tt-title', h('strong', t.name), h('span.subtle.num', `NLHE · ${fmt(t.smallBlind)}/${fmt(t.bigBlind)}${hand ? ` · Hand #${hand.handNo}` : ''}`)),
      h('div.tt-actions', fairBtn(),
        h('button.btn.btn-ghost.btn-sm', { 'aria-label': 'Table chat', 'aria-expanded': String(chatOpen), onclick: () => setChat(!chatOpen) }, icon('message-square')),
        msv && [
          h('button.btn.btn-ghost.btn-sm', { 'aria-label': msv.sittingOut ? 'Sit back in' : 'Sit out next hand', onclick: () => void sitOut(!msv.sittingOut) },
            icon(msv.sittingOut ? 'play-circle' : 'pause-circle'), h('span.hide-sm', msv.sittingOut ? 'Sit in' : 'Sit out')),
          h('button.btn.btn-ghost.btn-sm', { onclick: leave }, icon('log-out'), h('span.hide-sm', 'Leave')),
        ]));
    fill(statusBanner, st.status !== 'open' && h('div.banner', `This table is ${st.status}.`));

    fill(head,
      h('div', h('span.label.tp-kicker', `${t.isPrivate ? 'Private' : 'Public'} cash table · game credits`), h('h1.tp-title', t.name)),
      h('div.tp-badges',
        h(`span.chip-badge${live ? '.live' : ''}`, h('i.dot.on'), live ? 'Live' : st.status === 'open' ? 'Waiting' : st.status),
        h('span.chip-badge.num', `${st.seats.length} / ${t.maxSeats} seats`),
        fairBtn(),
        msv && [
          h('button.btn.btn-sm', { onclick: () => void sitOut(!msv.sittingOut) }, icon(msv.sittingOut ? 'play-circle' : 'pause-circle', 15), msv.sittingOut ? 'Sit in' : 'Sit out'),
          h('button.btn.btn-sm', { onclick: leave }, icon('log-out', 15), 'Leave'),
        ]));
    fill(meta, h('span', 'Blinds ', h('b.gold.num', `${fmt(t.smallBlind)} / ${fmt(t.bigBlind)}`), ' · No limit'), h('span.num', hand ? `Hand #${hand.handNo}` : 'No hand yet'));

    // Board, pot, winners.
    fill(board, [0, 1, 2, 3, 4].map((i) => {
      const c = hand?.board[i];
      return c ? playingCard(c, { size: 'lg', verified: verify[c], cls: dealIn(hand.handId, c) }) : h('div.card-slot.lg');
    }));
    const totalPot = (hand?.pots.reduce((a, p) => a + p.amount, 0) ?? 0) + (hand?.players.reduce((a, p) => a + p.streetCommitted, 0) ?? 0);
    fill(pot,
      totalPot > 0 && [icon('coins', 16, 'gold'), h('span.num', `Pot ${fmt(totalPot)}`)],
      hand && hand.pots.length > 1 && h('span.subtle.num.side-pots', hand.pots.map((p, i) => `${i === 0 ? 'Main' : `Side ${i}`} ${fmt(p.amount)}`).join(' · ')));
    fill(winner, hand?.ended && hand.winners.length > 0 && h('div.winner-banner', { role: 'status' }, hand.winners.map((w) => {
      const seat = st.seats.find((s) => s.seat === w.seat);
      return h('span', h('strong', seat?.displayName ?? `Seat ${w.seat + 1}`), ` wins ${fmt(w.amount)}${w.handName ? ` with ${w.handName}` : ''}`);
    })));

    // Seats.
    const anchor = st.mySeat ?? 0;
    timerRing = null;
    fill(seatsLayer, Array.from({ length: t.maxSeats }, (_, seat) => seatBox(seat, seatPos(seat, t.maxSeats, anchor), msv)));

    paintDock(meP, msv, totalPot);

    fill(stats,
      h('div.tp-stat', h('span.label', 'Wallet'), h('strong.num', fmt(session.me?.credits.wallet)), h('span', 'credits')),
      h('div.tp-stat', h('span.label', 'At this table'), h('strong.num', msv ? fmt(meP ? meP.stack : msv.stack) : '—'), h('span', msv ? 'chips' : 'not seated')),
      h('div.tp-stat', h('span.label', 'Hands played'), h('strong.num', handsPlayed), h('span', 'this session')));

    playersCount.textContent = `${st.seats.length} players`;
    fill(playersList, [...st.seats].sort((a, b) => a.seat - b.seat).map((s) => {
      const pv = hand?.players.find((p) => p.seat === s.seat && p.playerId === s.userId);
      const role = hand && hand.buttonSeat === s.seat ? 'Dealer button' : live && hand.toActSeat === s.seat ? (s.userId === myId ? 'Your turn' : 'Acting') : pv?.status === 'folded' ? 'Folded' : s.sittingOut ? 'Sitting out' : !s.connected ? 'Away' : pv ? 'In hand' : 'Waiting';
      return h('li', h('button.tc-player', { onclick: () => seatMenu(s) },
        h(`span.avatar.sm.av-${s.seat % 6}`, initials(s.displayName)),
        h('span.tc-pname', h('strong', s.userId === myId ? `You · ${s.displayName}` : s.displayName), h('span', { class: role === 'Your turn' ? 'gold' : '' }, role)),
        h('span.num.mono', fmt(pv ? pv.stack : s.stack))));
    }), st.seats.length === 0 && h('li.subtle.tc-empty', 'Nobody is seated yet.'));

    if (fairModal) fairModal.setBody(fairnessBody());
  }

  function dealIn(handId, card) {
    const k = `${handId}:${card}`;
    if (animatedCards.has(k)) return '';
    animatedCards.add(k);
    return 'deal-in';
  }

  function seatBox(seat, pos, msv) {
    const style = { left: `${pos.x}%`, top: `${pos.y}%` };
    const sv = st.seats.find((s) => s.seat === seat) ?? null;
    const hand = st.hand;
    if (!sv) {
      const canSit = !msv && st.status === 'open';
      return h('div.seat.empty', { style }, canSit
        ? h('button.btn.btn-sm.seat-sit', { 'aria-label': `Sit at seat ${seat + 1}`, onclick: () => buyIn(seat) }, 'Sit')
        : h('span.subtle.seat-num', { 'aria-hidden': 'true' }, seat + 1));
    }
    const pv = hand?.players.find((p) => p.seat === seat && p.playerId === sv.userId) ?? null;
    const isMe = sv.userId === myId;
    const acting = hand && !hand.ended && hand.toActSeat === seat;
    const folded = pv?.status === 'folded';
    const isWinner = hand?.ended && hand.winners.some((w) => w.seat === seat);
    const gift = gifts.find((g) => g.toUserId === sv.userId);
    const cls = ['seat', isMe && 'me', acting && 'acting', folded && 'folded', isWinner && 'winner', !sv.connected && 'away'].filter(Boolean).join(' ');
    let ring = null;
    if (acting && hand.deadline) {
      const circle = svg('circle', { cx: 22, cy: 22, r: 20, pathLength: 1 });
      ring = svg('svg', { class: 'timer-ring', viewBox: '0 0 44 44' }, circle);
      timerRing = { ring, circle, deadline: hand.deadline, total: st.table.actionSeconds * 1000 };
      tickTimer();
    }
    const tag = pv?.handName ?? pv?.lastAction ?? (!sv.connected ? 'Away' : sv.sittingOut ? 'Sitting out' : null);
    const parts = [h(`div.${cls.split(' ').join('.')}`, { style },
      h('div.seat-cards', pv && pv.holeCount > 0 && !folded && (pv.hole
        ? pv.hole.map((c) => playingCard(c, { size: isMe ? 'lg' : 'sm', verified: verify[c], cls: dealIn(hand.handId, c) }))
        : [playingCard(null, { size: 'sm' }), playingCard(null, { size: 'sm' })])),
      h('button.seat-plate', { 'aria-label': `${sv.displayName}, stack ${sv.stack}${acting ? ', acting' : ''}`, onclick: () => seatMenu(sv) },
        ring,
        h(`span.avatar.av-${seat % 6}`, initials(sv.displayName)),
        h('span.seat-info', h('span.seat-name', sv.displayName), h('span.seat-stack.num', fmt(pv ? pv.stack : sv.stack))),
        hand && hand.buttonSeat === seat && h('span.dealer-btn', { 'aria-label': 'Dealer button' }, 'D')),
      tag && h(`span.seat-tag${isWinner ? '.gold' : ''}`, tag),
      gift && h('span.gift-pop', { 'aria-live': 'polite', title: `Gift from ${gift.fromName}` }, GIFT_ICON[gift.item] ?? '🎁'))];
    if (pv && pv.streetCommitted > 0) {
      parts.push(h('div.bet', { style: { left: `${pos.x + (50 - pos.x) * 0.42}%`, top: `${pos.y + (50 - pos.y) * 0.42}%` } }, h('i.chip'), h('span.num', fmt(pv.streetCommitted))));
    }
    return parts;
  }

  // Action timer ring, updated 5 times a second without repainting the table.
  let timerRing = null;
  function tickTimer() {
    if (!timerRing) return;
    const left = Math.max(0, timerRing.deadline - (Date.now() + st.serverOffset));
    const frac = Math.min(1, left / timerRing.total);
    timerRing.circle.setAttribute('stroke-dasharray', `${frac} 1`);
    timerRing.ring.setAttribute('class', `timer-ring${frac < 0.25 ? ' low' : ''}`);
    timerRing.ring.setAttribute('aria-label', `${Math.ceil(left / 1000)} seconds left`);
  }
  const timerId = setInterval(tickTimer, 200);

  // The dock is only rebuilt when what it shows changes, so a half-typed raise amount survives other updates.
  let dockKey = '';
  function paintDock(meP, msv, totalPot) {
    const hand = st.hand;
    const t = st.table;
    const myTurn = meP && hand && !hand.ended && hand.toActSeat === meP.seat && hand.options;
    const key = JSON.stringify(myTurn ? ['act', hand.handId, hand.seq, hand.options] : [msv?.stack, msv?.sittingOut, !!msv, meP?.status, hand?.handId, hand?.ended, hand?.toActSeat, st.seats.length, session.me?.credits.wallet]);
    if (key === dockKey) return;
    dockKey = key;
    if (myTurn) return fill(dock, actionBar(hand, meP, totalPot));
    if (!msv) return fill(dock, h('div.dock-status', h('span.muted', 'You are watching. Pick an empty seat to play.')));
    let content;
    if (msv.stack === 0 && !meP) {
      const amount = Math.min(t.maxBuyIn, session.me.credits.wallet);
      content = amount >= t.minBuyIn
        ? h('button.btn.btn-primary', { onclick: async () => { const r = await emit('table:rebuy', { tableId, amount }); if (!r.ok) toast({ title: 'Could not add chips', body: r.error, tone: 'error' }); else void session.refresh(); } }, `Add ${fmt(amount)} chips`)
        : h('span.muted', 'Out of chips. Not enough credits in your wallet to rebuy.');
    } else if (meP && hand && !hand.ended) {
      content = h('span.muted', meP.status === 'folded' ? 'You folded. Next hand soon.' : `Waiting for ${st.seats.find((s) => s.seat === hand.toActSeat)?.displayName ?? 'next street'}…`);
    } else {
      content = h('span.muted', msv.sittingOut ? 'You are sitting out.' : st.seats.length < 2 ? 'Waiting for another player…' : 'Next hand starting…');
    }
    fill(dock, h('div.dock-status', content));
  }

  let keyHandler = null;
  function actionBar(hand, meP, pot) {
    const o = hand.options;
    const aggressive = o.canBet || o.canRaise;
    let amount = o.minTo;
    let busy = false;
    const clamp = (v) => Math.min(o.maxTo, Math.max(o.minTo, Math.round(v)));
    const buttons = [];
    const send = async (type, a) => {
      if (busy) return;
      busy = true; for (const b of buttons) b.disabled = true;
      const r = await emit('table:action', { tableId, handId: hand.handId, actionId: newId(), expectedSeq: hand.seq, type, ...(a !== undefined ? { amount: a } : {}) });
      busy = false; for (const b of buttons) if (b.isConnected) b.disabled = false;
      if (!r.ok) toast({ title: 'Action not accepted', body: r.error, tone: 'error' });
    };
    const slider = h('input.slider', { type: 'range', min: o.minTo, max: o.maxTo, step: Math.max(1, Math.floor(st.table.bigBlind / 2)), value: amount, 'aria-label': 'Bet amount' });
    const box = h('input.input.num.amount', { type: 'number', inputmode: 'numeric', min: o.minTo, max: o.maxTo, value: amount, 'aria-label': 'Bet amount' });
    const raiseLabel = h('span');
    const setAmount = (v, fromBox = false) => {
      amount = v;
      slider.value = String(v);
      if (!fromBox) box.value = String(v);
      const allIn = amount >= o.maxTo;
      fill(raiseLabel, allIn ? 'All-in' : o.canBet ? 'Bet' : 'Raise to', ' ', h('span.num', fmt(allIn ? o.maxTo : amount)));
    };
    slider.addEventListener('input', () => setAmount(clamp(Number(slider.value))));
    box.addEventListener('input', () => setAmount(Number(box.value), true));
    box.addEventListener('blur', () => setAmount(clamp(amount)));
    const potBase = pot + o.callAmount;
    const presets = [['½ Pot', hand.currentBet + potBase / 2], ['¾ Pot', hand.currentBet + (potBase * 3) / 4], ['Pot', hand.currentBet + potBase], ['Max', o.maxTo]];
    const btn = (sel, label, fn) => { const b = h(sel, { onclick: fn }, label); buttons.push(b); return b; };
    const raise = () => { const allIn = amount >= o.maxTo; void send(allIn ? 'allin' : o.canBet ? 'bet' : 'raise', allIn ? undefined : clamp(amount)); };
    setAmount(amount);
    keyHandler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || !dock.contains(buttons[0])) return;
      const k = e.key.toLowerCase();
      if (k === 'f') void send('fold');
      if (k === 'c') void send(o.canCheck ? 'check' : 'call');
      if (k === 'r' && aggressive) raise();
    };
    return h('div.action-bar', { role: 'group', 'aria-label': 'Your action' },
      aggressive && o.maxTo > o.minTo && h('div.raise-row',
        h('div.presets', presets.map(([label, v]) => h('button.btn.btn-sm', { onclick: () => setAmount(clamp(v)) }, label))),
        slider, box),
      h('div.action-row',
        btn('button.btn.btn-lg.act-fold', 'Fold', () => send('fold')),
        o.canCheck ? btn('button.btn.btn-lg.act-check', 'Check', () => send('check'))
          : btn('button.btn.btn-lg.act-call', [o.callAmount >= meP.stack ? 'Call all-in' : 'Call', ' ', h('span.num', fmt(o.callAmount))], () => send('call')),
        aggressive && btn('button.btn.btn-brass.btn-lg.act-raise', raiseLabel, raise),
        aggressive && btn('button.btn.btn-lg.act-allin', ['All-in ', h('span.num', fmt(o.maxTo))], () => send('allin'))));
  }
  const onKey = (e) => keyHandler?.(e);
  addEventListener('keydown', onKey);

  // ---------- dealing animation
  function flyCard(seat) {
    if (!st.table) return;
    const to = seatPos(seat, st.table.maxSeats, st.mySeat ?? 0);
    const f = h('div.flight', playingCard(null, { size: 'sm' }));
    f.style.setProperty('--tx', `${to.x}%`);
    f.style.setProperty('--ty', `${to.y}%`);
    felt.append(f);
    setTimeout(() => f.remove(), 650);
  }

  // ---------- fairness
  function checkReveals(handId, reveals) {
    const f = fairnessByHand[handId] ?? (st.hand?.handId === handId ? st.hand.fairness : null);
    if (!f) { (pendingReveals[handId] ??= []).push(...reveals); return; }
    for (const r of reveals) {
      verify[r.card] = 'pending';
      void verifyReveal(f.commitId, f.root, f.mix, r).then((ok) => { verify[r.card] = ok ? 'ok' : 'fail'; schedule(); });
    }
    schedule();
  }
  const resetVerify = () => { for (const k of Object.keys(verify)) delete verify[k]; };

  function fairnessBody() {
    const f = fairnessOf(st.hand);
    const entries = Object.values(verify);
    const ok = entries.filter((s) => s === 'ok').length;
    const bad = entries.filter((s) => s === 'fail').length;
    const seated = !!mySeatView();
    const contributed = f?.contributions.some((c) => c.playerId === myId) ?? false;
    if (!f) return h('p.muted', "The next hand's deck commitment will appear here.");
    const kv = (k, ...v) => h('div.kv', h('span', k), ...v);
    return h('div', { style: { display: 'grid', gap: 'var(--s3)', fontSize: 'var(--fs-sm)' } },
      h('p', 'Before this hand, the server committed to its shuffled deck. Every card you have seen has been checked on ', h('em', 'your'), ' device against that commitment.'),
      kv('Deck commitment', h('code', `${f.root.slice(0, 16)}…${f.root.slice(-8)}`)),
      kv('Entropy mix', h('code', `${f.mix.slice(0, 16)}…`)),
      kv('Player contributions', h('span', `${f.contributions.length}${seated ? (contributed ? ' (including yours)' : ' (yours was not included)') : ''}`)),
      kv('Cards verified', h('span', { class: bad ? 'danger' : 'gold' }, `${ok} verified${bad ? `, ${bad} FAILED` : ''}`)),
      seated && !contributed && h('p.subtle', 'Your device contributes randomness for the next hand automatically while you are seated.'),
      h('p.subtle', "Opponents' folded cards are never revealed. See FAIRNESS_AND_AUDIT.md for the full protocol and its limits."));
  }
  function openFairness() { fairModal = modal({ title: 'Fairness', body: fairnessBody(), onClose: () => { fairModal = null; } }); }

  // ---------- seat actions
  function buyIn(seat) {
    const t = st.table;
    const wallet = session.me.credits.wallet;
    const cap = Math.min(t.maxBuyIn, wallet);
    const enough = wallet >= t.minBuyIn;
    let v = Math.min(cap, Math.max(t.minBuyIn, Math.round((t.minBuyIn + t.maxBuyIn) / 2)));
    const range = h('input.slider', { type: 'range', min: t.minBuyIn, max: cap, value: v, 'aria-label': 'Buy-in amount' });
    const box = input({ class: 'num', type: 'number', min: t.minBuyIn, max: cap, value: v });
    const confirm = h('button.btn.btn-primary', { disabled: !enough }, `Buy in for ${fmt(v)}`);
    const set = (x) => { v = x; range.value = String(x); box.value = String(x); confirm.textContent = `Buy in for ${fmt(x)}`; };
    range.addEventListener('input', () => set(Number(range.value)));
    box.addEventListener('change', () => set(Math.min(cap, Math.max(t.minBuyIn, Number(box.value) || t.minBuyIn))));
    const m = modal({
      title: `Take seat ${seat + 1}`,
      body: enough ? [
        h('p.muted', 'Wallet: ', h('strong.num', credits(wallet))),
        range,
        field('Buy-in', box, { hint: `Between ${fmt(t.minBuyIn)} and ${fmt(cap)}` }),
        h('p.subtle', { style: { fontSize: 'var(--fs-xs)' } }, 'Game credits only. Non-redeemable, with no cash value.'),
      ] : h('p.error-text', `You need at least ${credits(t.minBuyIn)} to sit here. Your wallet holds ${credits(wallet)}.`),
      footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), confirm],
    });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true; confirm.textContent = 'Sitting…';
      const a = await emit('table:sit', { tableId, seat, buyIn: v, ...(accessCode ? { accessCode } : {}) });
      if (a.ok) { applySnapshot(a.data); m.close(); void session.refresh(); }
      else { toast({ title: 'Could not sit down', body: a.error, tone: 'error' }); set(v); confirm.disabled = false; }
    });
  }

  function seatMenu(seat) {
    const isMe = seat.userId === myId;
    const gifts = h('div', h('div.spinner'));
    const m = modal({
      title: seat.displayName,
      body: [
        h('p.muted', `Level ${seat.level} · Stack `, h('span.num', fmt(seat.stack))),
        link(`/profile/${seat.userId}`, { class: 'btn', onclick: () => m.close() }, icon('user'), ' View profile'),
        !isMe && h('div', h('p.panel-title', icon('gift', 14), ' Send a gift ', h('span.subtle', { style: { textTransform: 'none', letterSpacing: '0' } }, '(cosmetic only)')), gifts),
        h('p.subtle', { style: { fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center', gap: '6px' } }, icon('clock', 12), ` ${seat.connected ? 'Connected' : 'Disconnected'}${seat.sittingOut ? ' · Sitting out' : ''}`),
      ],
    });
    if (isMe) return;
    api.get('/gifts/catalog').then((r) => fill(gifts, h('div.gift-grid', r.items.map((g) => h('button.btn.gift-btn', { disabled: g.remaining_today <= 0, onclick: async () => {
      try { await api.post('/gifts', { toUserId: seat.userId, itemKey: g.key, tableId }); toast({ title: 'Gift sent', tone: 'success' }); m.close(); }
      catch (e) { toast({ title: 'Could not send gift', body: e.message, tone: 'error' }); }
    } }, h('span', { 'aria-hidden': 'true' }, GIFT_ICON[g.key] ?? '🎁'), g.name, h('span.subtle.num', `${g.remaining_today} left`)))))).catch(() => fill(gifts));
  }

  async function sitOut(v) { await emit('table:sitout', { tableId, sitOut: v }); }
  async function leave() {
    const r = await emit('table:leave', { tableId });
    if (r.ok) { void session.refresh(); toast({ title: 'You left the table', body: 'Your chips return to your wallet after the hand.' }); }
  }

  function showAccessCode() {
    fill(host, loading('Private table'));
    if (codeModal) { codeModal.field.setError(error.code === 'BAD_CODE' ? error.message : null); return; }
    const code = input({ autofocus: true });
    const f = field('Access code', code, { error: error.code === 'BAD_CODE' ? error.message : null });
    const enter = h('button.btn.btn-primary', { disabled: true }, 'Enter');
    code.addEventListener('input', () => { enter.disabled = code.value.length < 4; });
    const submit = () => { accessCode = code.value; void watch(); };
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !enter.disabled) submit(); });
    enter.addEventListener('click', submit);
    const m = modal({ title: 'Private table', body: f, footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Back'), enter], onClose: () => { codeModal = null; if (error) navigate('/lobby'); } });
    codeModal = { modal: m, field: f };
  }

  // ---------- server sync
  function applySnapshot(x) {
    st.table = x.table; st.seats = x.seats; st.mySeat = x.mySeat; st.hand = handFromSnapshot(x.hand);
    st.serverOffset = x.serverTime - Date.now(); st.status = x.table.status;
    schedule();
  }

  async function contribute(commitId) {
    await emit('table:entropy', { tableId, commitId, entropy: randomEntropy() });
  }

  async function watch() {
    const a = await emit('table:watch', { tableId, ...(accessCode ? { accessCode } : {}) });
    if (destroyed) return;
    if (!a.ok) { error = { code: a.code ?? 'ERROR', message: a.error }; schedule(); return; }
    error = null;
    if (codeModal) { const m = codeModal.modal; codeModal = null; m.close(); }
    applySnapshot(a.data);
    if (a.data.hand?.fairness) {
      fairnessByHand[a.data.hand.handId] = a.data.hand.fairness;
      resetVerify();
      checkReveals(a.data.hand.handId, a.data.hand.reveals ?? []);
    }
    const nc = a.data.nextCommitment;
    if (nc && a.data.mySeat !== null && !nc.contributed) void contribute(nc.handId);
    // Quick join: open the buy-in for the first free seat.
    if (location.search.includes('sit=1')) {
      history.replaceState(null, '', location.pathname);
      if (st.mySeat === null) {
        const free = Array.from({ length: st.table.maxSeats }, (_, i) => i).find((i) => !st.seats.some((s) => s.seat === i));
        if (free !== undefined) buyIn(free);
      }
    }
  }

  const mine = (e) => e?.tableId === tableId;
  const stopSocket = listen({
    'table:event': (e) => {
      if (!mine(e)) return;
      const ev = e.event;
      const myHandSeat = st.hand?.players.find((p) => p.playerId === myId)?.seat ?? (ev.type === 'HAND_STARTED' ? ev.players.find((p) => p.playerId === myId)?.seat ?? null : null);
      st.hand = applyEvent(st.hand, ev, { handId: e.handId, seq: e.seq, deadline: e.deadline }, myHandSeat);
      if (ev.type === 'HAND_STARTED') { dealer.play({ kind: 'shuffle' }); resetVerify(); }
      if (ev.type === 'HOLE_CARDS_DEALT') dealer.play({ kind: 'deal', seats: ev.seats });
      if (ev.type === 'STREET_DEALT') { dealer.play({ kind: 'board' }); if (e.reveals) checkReveals(e.handId, e.reveals); }
      if (ev.type === 'POTS_UPDATED') dealer.play({ kind: 'sweep' });
      if (ev.type === 'SHOWDOWN') { dealer.play({ kind: 'reveal' }); if (e.reveals) checkReveals(e.handId, e.reveals); }
      if (ev.type === 'POT_AWARDED') dealer.play({ kind: 'award' });
      if (ev.type === 'HAND_ENDED' && st.hand && !countedHands.has(st.hand.handId) && st.hand.players.some((p) => p.playerId === myId)) { countedHands.add(st.hand.handId); handsPlayed++; }
      schedule();
    },
    'table:private': (e) => {
      if (!mine(e)) return;
      if (st.hand && st.hand.handId === e.handId) { const p = st.hand.players.find((x) => x.seat === e.event.seat); if (p) p.hole = e.event.cards; }
      checkReveals(e.handId, e.reveals);
    },
    'table:handStarted': (e) => {
      if (!mine(e)) return;
      fairnessByHand[e.handId] = e.fairness;
      const pend = pendingReveals[e.handId];
      if (pend) { delete pendingReveals[e.handId]; checkReveals(e.handId, pend); }
      schedule();
    },
    'table:seats': (e) => {
      if (!mine(e)) return;
      st.seats = e.seats;
      st.mySeat = e.seats.find((x) => x.userId === myId)?.seat ?? null;
      schedule();
    },
    'table:commitment': (e) => { if (mine(e) && st.mySeat !== null) void contribute(e.handId); },
    'table:status': (e) => { if (!mine(e)) return; st.status = e.status; if (st.table) st.table.status = e.status; schedule(); },
    'table:snapshot': (x) => { if (x.table?.id === tableId) applySnapshot(x); },
    'table:gift': (g) => {
      if (!mine(g)) return;
      gifts.push({ id: g.giftId, toUserId: g.toUserId, item: g.item, fromName: g.fromName });
      schedule();
      setTimeout(() => { const i = gifts.findIndex((y) => y.id === g.giftId); if (i >= 0) gifts.splice(i, 1); schedule(); }, 3200);
    },
    // Reconnect = full resync from a fresh per-viewer snapshot.
    connect: () => void watch(),
  });
  const stopSession = session.changed.on(schedule);
  const unlock = landscapeLock();
  chat.start();
  fill(host, loading('Joining table'));
  void watch();

  return () => {
    destroyed = true;
    stopSocket(); stopSession(); unlock(); chat.destroy(); dealer.destroy();
    clearInterval(timerId);
    removeEventListener('keydown', onKey);
    fairModal?.close();
    if (codeModal) { const m = codeModal.modal; codeModal = null; error = null; m.close(); }
    void emit('table:unwatch', { tableId });
  };
}
