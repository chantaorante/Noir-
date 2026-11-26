// Player profile: stats, missions, achievements, gifts, and social actions.
import { api, day, field, fill, fmt, h, icon, input, load, modal, RANK_NAMES, select, session, toast } from '../core.js';

const AVATARS = ['default', 'ace', 'king', 'queen', 'jack', 'club', 'diamond', 'heart', 'spade', 'crown', 'chip', 'moon'];

export function profilePage(host, userId) {
  const box = h('div', { style: { display: 'contents' } });
  fill(host, box);
  const mine = userId === session.me?.user.id;
  const reload = load(box, () => Promise.all([api.get(`/profiles/${userId}`), mine ? api.get('/me/quests').catch(() => null) : null]), ([data, quests]) => render(data, quests));

  function render({ profile: pr, stats: s, achievements, giftsReceived }, quests) {
    const doAct = async (fn, msg) => { try { await fn(); toast({ title: msg, tone: 'success' }); reload(); } catch (e) { toast({ title: 'Not possible', body: e.message, tone: 'error' }); } };
    const statRows = [
      ['Hands played', fmt(s.handsPlayed)], ['Hands won', fmt(s.handsWon)], ['Win rate', `${s.winRate}%`], ['Showdowns', fmt(s.showdowns)],
      ['Showdowns won', fmt(s.showdownsWon)], ['Folds', fmt(s.folds)], ['Average pot won', fmt(s.avgPotWon)], ['Largest pot', fmt(s.largestPot)],
      ['Tournaments', fmt(s.tournamentsPlayed)], ['Tournament wins', fmt(s.tournamentWins)], ['Current streak', fmt(s.currentStreak)], ['Best streak', fmt(s.bestStreak)],
    ];
    const pct = (a, b) => `${Math.min(100, (a / b) * 100)}%`;
    return h('div.profile',
      h('section.card.card-pad.profile-head',
        h('span.avatar.xl', pr.displayName.slice(0, 1).toUpperCase()),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('h1.display', { style: { fontSize: 'var(--fs-2xl)' } }, pr.displayName),
          h('p.subtle', { style: { fontSize: 'var(--fs-sm)' } }, `@${pr.username} · Player ID ${pr.playerId} · Joined ${day(pr.joinedAt)}`),
          h('div', { style: { display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap', marginTop: 'var(--s2)' } },
            h('span.badge.badge-gold', `Level ${pr.level}`), h('span.badge', RANK_NAMES[pr.rank] ?? pr.rank), h('span.badge.num', `${fmt(pr.xp)} XP`),
            h('span.badge', pr.status), h('span.badge', pr.favoriteMode)),
          pr.bio && h('p', { style: { marginTop: 'var(--s3)', whiteSpace: 'pre-wrap' } }, pr.bio)),
        h('div.profile-actions', mine
          ? h('button.btn', { onclick: () => editProfile(pr, reload) }, 'Edit profile')
          : [
            !pr.isFriend && h('button.btn', { onclick: () => doAct(() => api.post('/friends/requests', { userId: pr.id }), 'Friend request sent') }, icon('user-plus'), ' Add friend'),
            h('button.btn.btn-ghost', { onclick: () => doAct(() => api.post(`/mutes/${pr.id}`), 'Player muted') }, icon('volume-x'), ' Mute'),
            h('button.btn.btn-ghost', { onclick: () => doAct(() => api.post(`/blocks/${pr.id}`), 'Player blocked') }, icon('ban'), ' Block'),
            h('button.btn.btn-ghost', { onclick: () => reportModal(pr.id) }, icon('flag'), ' Report'),
          ])),
      h('section.card.card-pad', h('h2.panel-title', 'Statistics'), h('dl.stat-grid', statRows.map(([k, v]) => h('div', h('dt', k), h('dd.num', v))))),
      mine && quests && h('section.card.card-pad', h('h2.panel-title', 'Missions'),
        h('div', { style: { display: 'grid', gap: 'var(--s3)' } }, quests.quests.map((q) => h('div.quest',
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
            h('span', q.name, ' ', h('span.badge', q.period)),
            h('span.subtle.num', `${q.completed_at ? 'Complete' : `${q.progress}/${q.target}`} · +${q.xp_reward} XP`)),
          h('div.progress', h('i', { style: { width: pct(q.progress, q.target) } })))))),
      h('section.card.card-pad', h('h2.panel-title', icon('award'), ' Achievements'),
        h('div.ach-grid', achievements.map((a) => h(`div.ach${a.unlocked_at ? '.unlocked' : ''}.rarity-${a.rarity}`, { title: a.description },
          h('span.ach-icon', a.unlocked_at ? icon('award', 22) : icon('lock', 18)),
          h('strong', a.name), h('span.subtle', a.description), h(`span.badge.rar-${a.rarity}`, a.rarity),
          !a.unlocked_at && h('div.progress', { style: { width: '100%' } }, h('i', { style: { width: pct(a.progress, a.threshold) } })))))),
      h('section.card.card-pad', h('h2.panel-title', icon('gift'), ' Gifts received'),
        giftsReceived.length === 0 ? h('p.subtle', { style: { fontSize: 'var(--fs-sm)' } }, 'No gifts yet.')
          : h('div', { style: { display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' } }, giftsReceived.map((g) => h(`span.badge.rar-${g.rarity}`, `${g.name} × ${g.n}`)))));
  }
}

function reportModal(targetId) {
  const category = select([['chat_abuse', 'Abusive chat'], ['cheating', 'Cheating'], ['collusion', 'Collusion'], ['spam', 'Spam'], ['other', 'Other']]);
  const details = h('textarea.textarea', { maxlength: 1000 });
  const m = modal({
    title: 'Report player',
    body: [field('Reason', category), field('Details (optional)', details)],
    footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn.btn-danger', { onclick: async () => {
      try { await api.post('/reports', { targetUserId: targetId, category: category.value, details: details.value }); toast({ title: 'Report sent', body: 'A moderator will review it.', tone: 'success' }); m.close(); }
      catch (e) { toast({ title: 'Could not send', body: e.message, tone: 'error' }); }
    } }, 'Send report')],
  });
}

function editProfile(pr, done) {
  const displayName = input({ maxlength: 32, value: pr.displayName });
  const avatar = select(AVATARS.map((a) => [a, a[0].toUpperCase() + a.slice(1)]), { value: pr.avatarKey });
  const bio = h('textarea.textarea', { maxlength: 280 });
  bio.value = pr.bio ?? '';
  const bioField = field('Bio', bio, { hint: `${bio.value.length}/280` });
  bio.addEventListener('input', () => bioField.setError(null) || (bioField.lastChild.textContent = `${bio.value.length}/280`));
  const m = modal({
    title: 'Edit profile',
    body: [field('Display name', displayName), field('Avatar', avatar), bioField],
    footer: [h('button.btn.btn-ghost', { onclick: () => m.close() }, 'Cancel'), h('button.btn.btn-primary', { onclick: async () => {
      try { await api.patch('/me/profile', { displayName: displayName.value, bio: bio.value, avatarKey: avatar.value }); await session.refresh(); m.close(); done(); }
      catch (e) { toast({ title: 'Could not save', body: e.message, tone: 'error' }); }
    } }, 'Save')],
  });
}
