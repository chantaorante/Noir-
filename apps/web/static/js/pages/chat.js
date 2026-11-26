// Chat panel for the lobby and for tables. Messages are inserted as text, never as HTML.
import { emit, h, icon, link, listen } from '../core.js';

export function chatPanel(channel, { compact = false } = {}) {
  const list = h('div.chat-list', { 'aria-live': 'polite' });
  const emptyNote = h('p.subtle', { style: { fontSize: 'var(--fs-sm)', padding: 'var(--s3)' } }, 'No messages yet. Say hello.');
  const text = h('input.input', { 'aria-label': 'Message', placeholder: 'Message…', maxlength: 300 });
  const err = h('p.error-text', { style: { padding: '0 var(--s3) var(--s2)' }, hidden: true });
  list.append(emptyNote);

  const add = (m) => {
    emptyNote.remove();
    list.append(h('p.chat-msg', link(`/profile/${m.userId}`, { class: 'chat-name' }, m.displayName), ' ', h('span', m.body)));
    while (list.querySelectorAll('.chat-msg').length > 100) list.querySelector('.chat-msg').remove();
    list.scrollTop = list.scrollHeight;
  };

  const el = h(`section.chat${compact ? '.compact' : ''}`, { 'aria-label': 'Chat' },
    list,
    h('form.chat-form', { onsubmit: async (e) => {
      e.preventDefault();
      const body = text.value.trim();
      if (!body) return;
      const a = await emit('chat:send', { channel, body });
      if (a.ok) { text.value = ''; err.hidden = true; } else { err.textContent = a.error; err.hidden = false; }
    } }, text, h('button.btn.btn-icon', { 'aria-label': 'Send' }, icon('send', 16))),
    err);

  let stop = () => {};
  const start = () => {
    void emit('chat:history', { channel }).then((a) => { if (a.ok && a.data) for (const m of a.data) add(m); });
    stop = listen({ 'chat:message': (m) => { if (m.channel === channel) add(m); } });
  };
  return { el, start, destroy: () => stop() };
}
