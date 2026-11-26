// Bell button in the top bar with the notification list.
import { api, fill, h, icon, listen } from '../core.js';

export function notificationsButton() {
  let open = false;
  let list = [];
  let unread = 0;
  const count = h('span.dot-count.num', { hidden: true });
  const btn = h('button.btn.btn-ghost.btn-icon', { 'aria-expanded': 'false', onclick: () => void toggle() }, icon('bell', 18), count);
  const panel = h('div.menu.card.notif', { role: 'dialog', 'aria-label': 'Notifications', hidden: true, onmouseleave: () => setOpen(false) });
  const el = h('div', { style: { position: 'relative' } }, btn, panel);

  function paint() {
    count.hidden = unread <= 0;
    count.textContent = unread > 9 ? '9+' : String(unread);
    btn.setAttribute('aria-label', `Notifications${unread ? `, ${unread} unread` : ''}`);
    fill(panel, list.length === 0
      ? h('p.subtle', { style: { padding: 'var(--s4)', fontSize: 'var(--fs-sm)' } }, 'You are all caught up.')
      : list.slice(0, 15).map((n) => h(`div.notif-item${n.read_at ? '' : '.unread'}`, h('strong', n.title), n.body && h('p', n.body), h('span.subtle', new Date(n.created_at).toLocaleString()))));
  }
  const load = () => api.get('/notifications').then((r) => { list = r.notifications; unread = r.unread; paint(); }).catch(() => undefined);
  function setOpen(v) { open = v; panel.hidden = !v; btn.setAttribute('aria-expanded', String(v)); }
  async function toggle() {
    setOpen(!open);
    if (open && unread) { await api.post('/notifications/read').catch(() => undefined); unread = 0; paint(); }
  }
  paint();
  void load();
  const stop = listen({ notify: () => void load() });
  return { el, destroy: stop };
}
