// Leaderboards: one tab per board, server-recorded play only.
import { api, empty, fill, fmt, h, link, load, session } from '../core.js';

export function leaderboardsPage(host) {
  let key = 'level';
  const tabs = h('div.tabs', { role: 'tablist' });
  const body = h('div.card');
  fill(host, h('div.narrow',
    h('h1.display.page-title', 'Leaderboards'),
    tabs, body,
    h('p.subtle', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s3)' } }, 'Rankings use server-recorded play only. Ties share a rank. Suspended accounts are excluded.')));

  let boards = [];
  const paintTabs = () => fill(tabs, boards.map((b) => h('button.tab', { role: 'tab', 'aria-selected': String(key === b.key), onclick: () => { key = b.key; paintTabs(); showBoard(); } }, b.label)));
  const showBoard = () => load(body, () => api.get(`/leaderboards/${key}`), (d) => !d.entries.length
    ? empty('trophy', 'No rankings yet', 'Play some hands to appear here.')
    : h('table.table-list',
      h('thead', h('tr', h('th', { style: { width: '64px' } }, 'Rank'), h('th', 'Player'), h('th', { style: { textAlign: 'right' } }, d.label))),
      h('tbody', d.entries.map((e) => h('tr', { class: e.userId === session.me?.user.id ? 'me-row' : '' },
        h('td.num', h(`span.rank-badge.r${Math.min(e.rank, 4)}`, e.rank)),
        h('td', link(`/profile/${e.userId}`, e.displayName)),
        h('td.num', { style: { textAlign: 'right' } }, fmt(e.value)))))));
  api.get('/leaderboards').then((r) => { boards = r.boards; paintTabs(); }).catch(() => undefined);
  showBoard();
}
