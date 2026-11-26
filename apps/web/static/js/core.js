// Small helpers shared by every page: DOM building, icons, HTTP, Socket.IO, routing, session, toasts, modals.
// Plain JavaScript modules, no build step. All text is inserted as text nodes, never as HTML.
import { ICONS } from './icons.js';

// ------------------------------------------------------------------ DOM
const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('button.btn.btn-primary', { onclick }, 'Save', icon('plus')) */
export function h(sel, props, ...children) {
  if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    if (props !== undefined && props !== null) children.unshift(props);
    props = {};
  }
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  setProps(el, props);
  append(el, children);
  return el;
}

function setProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else if (k === 'ref') v(el);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children of el. */
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

/** Lucide icon as inline SVG. The markup comes from the bundled icons.js file, never from user input. */
export function icon(name, size = 16, cls = '') {
  const el = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) el.setAttribute(k, String(v));
  if (cls) el.setAttribute('class', cls);
  el.innerHTML = ICONS[name] ?? '';
  return el;
}

export function logo(size = 28, withWord = false) {
  const mark = svg('svg', { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': 'true' },
    svg('defs', {}, svg('linearGradient', { id: 'lg-emerald', x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: 0, 'stop-color': '#5fe3a8' }), svg('stop', { offset: 1, 'stop-color': '#1f9e69' }))),
    svg('rect', { x: 1, y: 1, width: 46, height: 46, rx: 12, fill: 'url(#lg-emerald)' }),
    svg('path', { d: 'M24 11c-4 5.2-10.5 8.6-10.5 14.4 0 3.6 2.9 6.1 6 6.1 1.8 0 3.2-.8 4-1.9-.4 3-1.5 5.3-3.6 7h8.2c-2.1-1.7-3.2-4-3.6-7 .8 1.1 2.2 1.9 4 1.9 3.1 0 6-2.5 6-6.1C34.5 19.6 28 16.2 24 11z', fill: '#06130e' }));
  return h('span.logo', { style: { display: 'inline-flex', alignItems: 'center', gap: '12px' } }, mark,
    withWord && h('span', { style: { display: 'grid', lineHeight: '1.1' } },
      h('span', { style: { fontWeight: '750', letterSpacing: '0.22em', fontSize: `${size * 0.5}px`, color: 'var(--text)' } }, 'NOIR POKER'),
      h('span.label', { style: { fontSize: `${Math.max(9, size * 0.3)}px`, letterSpacing: '0.22em' } }, 'Private club')));
}

// ------------------------------------------------------------------ formatting
export const fmt = (n) => (n ?? 0).toLocaleString('en-US');
export const credits = (n) => `${fmt(n)} ALL`;
export const when = (d) => new Date(d).toLocaleString();
export const day = (d) => new Date(d).toLocaleDateString();
export const newId = () => crypto.randomUUID();
export function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ''))).toUpperCase();
}
export const RANK_NAMES = { rookie: 'Rookie', amateur: 'Amateur', regular: 'Regular', skilled: 'Skilled', expert: 'Expert', master: 'Master', elite: 'Elite', legend: 'Legend', noir_elite: 'Noir Elite' };

// ------------------------------------------------------------------ HTTP (same origin, cookie auth, CSRF header)
let csrf = '';
export const setCsrf = (t) => { csrf = t; };

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function request(method, path, body) {
  const headers = { 'x-noir-client': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const d = (typeof data === 'object' && data) || {};
    throw new ApiError(res.status, d.code ?? 'ERROR', d.error ?? 'Request failed.');
  }
  if (data && typeof data === 'object' && typeof data.csrf === 'string') setCsrf(data.csrf);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

// ------------------------------------------------------------------ Socket.IO (client script: /vendor/socket.io.min.js)
let socket = null;
export function getSocket() {
  if (!socket) socket = window.io({ path: '/ws', transports: ['websocket', 'polling'], withCredentials: true, reconnectionDelay: 500, reconnectionDelayMax: 5000 });
  return socket;
}
export function closeSocket() { socket?.disconnect(); socket = null; }

/** Emit with acknowledgement; resolves { ok, data } or { ok: false, error, code }. */
export function emit(event, payload, timeoutMs = 8000) {
  const s = getSocket();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'The server did not respond in time.', code: 'TIMEOUT' }), timeoutMs);
    const cb = (a) => { clearTimeout(t); resolve(a); };
    if (payload === undefined) s.emit(event, cb); else s.emit(event, payload, cb);
  });
}

/** Subscribe to socket events; returns a function that removes them all. */
export function listen(handlers) {
  const s = getSocket();
  for (const [ev, fn] of Object.entries(handlers)) s.on(ev, fn);
  return () => { for (const [ev, fn] of Object.entries(handlers)) s.off(ev, fn); };
}

// ------------------------------------------------------------------ tiny event bus
export function emitter() {
  const subs = new Set();
  return { on: (fn) => { subs.add(fn); return () => subs.delete(fn); }, emit: (...a) => { for (const fn of [...subs]) fn(...a); } };
}

// ------------------------------------------------------------------ router
export const route = emitter();
export function navigate(to, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  window.scrollTo({ top: 0 });
  route.emit();
}
addEventListener('popstate', () => route.emit());

export function match(pattern, path) {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/** In-app link: real <a href> (works with middle-click), navigates without a page load. */
export function link(to, props, ...children) {
  if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) { if (props != null) children.unshift(props); props = {}; }
  const { onclick, ...rest } = props;
  return h('a', { href: to, ...rest, onclick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onclick?.(e); navigate(to); } }, ...children);
}

// ------------------------------------------------------------------ session
export const session = {
  me: null,
  changed: emitter(),
  can(p) { return !!session.me?.user.permissions.includes(p); },
  async refresh() {
    try {
      const m = await api.get('/auth/me');
      setCsrf(m.csrf);
      session.me = m;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { session.me = null; closeSocket(); }
      else if (!session.me) throw e;
    }
    session.changed.emit();
  },
  async logout() {
    await api.post('/auth/logout').catch(() => undefined);
    closeSocket();
    session.me = null;
    session.changed.emit();
  },
};

// ------------------------------------------------------------------ toasts
let toastHost = null;
export function toast({ title, body, tone }) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const el = h(`div.toast${tone ? `.${tone}` : ''}`,
    h('div', { style: { flex: '1' } }, h('strong', title), body && h('p', body)),
    h('button.btn.btn-ghost.btn-sm.btn-icon', { 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('x', 14)));
  toastHost.append(el);
  while (toastHost.children.length > 4) toastHost.firstChild.remove();
  setTimeout(() => el.remove(), tone === 'error' ? 6000 : 4000);
}
export const toastError = (title, e) => toast({ title, body: e?.message ?? String(e), tone: 'error' });

// ------------------------------------------------------------------ modal (focus-trapped, Esc closes)
/** Opens a modal. `body` and `footer` are nodes or arrays. Returns { close, el, setBody, setFooter }. */
export function modal({ title, body, footer, onClose }) {
  const prev = document.activeElement;
  const bodyEl = h('div.body');
  const footEl = h('footer');
  const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' },
    h('header', h('h2', { id: 'modal-title', style: { fontSize: 'var(--fs-lg)' } }, title), h('button.btn.btn-ghost.btn-icon', { 'aria-label': 'Close', onclick: () => close() }, icon('x', 18))),
    bodyEl, footEl);
  const backdrop = h('div.modal-backdrop', { onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  const focusables = () => [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled);
  const key = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', key);
    backdrop.remove();
    prev?.focus?.();
    onClose?.();
  }
  const setBody = (...c) => fill(bodyEl, ...c);
  const setFooter = (...c) => { fill(footEl, ...c); footEl.hidden = !footEl.childNodes.length; };
  setBody(body);
  setFooter(footer);
  document.body.append(backdrop);
  document.addEventListener('keydown', key);
  const auto = box.querySelector('[autofocus]');
  (auto ?? focusables()[1] ?? focusables()[0])?.focus();
  return { close, el: box, setBody, setFooter };
}

export function field(label, control, { hint, error } = {}) {
  const msg = h('span');
  const setError = (err) => {
    msg.className = err ? 'error-text' : hint ? 'hint' : '';
    if (err) msg.setAttribute('role', 'alert'); else msg.removeAttribute('role');
    msg.textContent = err || hint || '';
    msg.hidden = !(err || hint);
  };
  setError(error);
  const el = h('label.field', h('span', label), control, msg);
  el.setError = setError;
  return el;
}

export function input(props = {}) { return h('input.input', props); }
export function select(options, props = {}) {
  return h('select.select', props, options.map(([value, label]) => h('option', { value, selected: String(props.value) === String(value) }, label)));
}

export const empty = (iconName, title, body, action) => h('div.empty', iconName && icon(iconName, 32), h('strong', title), body && h('p.muted', { style: { fontSize: 'var(--fs-sm)' } }, body), action);
export const loading = (label = 'Loading') => h('div.empty', { 'aria-busy': 'true' }, h('div.spinner'), h('span.sr-only', label));
export const errorState = (message, retry) => h('div.empty', { role: 'alert' }, h('strong', 'Something went wrong'), h('p.muted', message), retry && h('button.btn', { onclick: retry }, 'Try again'));

/**
 * Loads data into a container: shows a spinner, then render(data), or an error with a retry button.
 * Returns reload().
 */
export function load(container, fetcher, render) {
  let gen = 0;
  const run = async () => {
    const g = ++gen;
    fill(container, loading());
    try {
      const data = await fetcher();
      if (g === gen) fill(container, render(data, run));
    } catch (e) {
      if (g === gen) fill(container, errorState(e.message, run));
    }
  };
  void run();
  return run;
}

/** Button that disables itself while its async handler runs. */
export function actionButton(sel, label, fn, props = {}) {
  const b = h(sel, { ...props, onclick: async (e) => {
    if (b.disabled) return;
    b.disabled = true;
    try { await fn(e); } finally { if (b.isConnected) b.disabled = false; }
  } }, label);
  return b;
}
