import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { emit, getSocket } from '../../net/socket';
import { Link } from '../../lib/router';

interface Msg { id: number; channel: string; userId: string; displayName: string; body: string; createdAt: string }

/** Chat panel. Messages are rendered as React text nodes (escaped); never as HTML. */
export function ChatPanel({ channel, compact = false, ready = true }: { channel: string; compact?: boolean; ready?: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready) return;
    const s = getSocket();
    void emit<Msg[]>('chat:history', { channel }).then((a) => a.ok && a.data && setMsgs(a.data));
    const on = (m: Msg) => m.channel === channel && setMsgs((x) => [...x.slice(-99), m]);
    s.on('chat:message', on);
    return () => { s.off('chat:message', on); };
  }, [channel, ready]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [msgs]);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    const a = await emit('chat:send', { channel, body });
    if (a.ok) { setText(''); setError(null); } else setError(a.error);
  };
  return (
    <section className={`chat ${compact ? 'compact' : ''}`} aria-label="Chat">
      <div className="chat-list" ref={list} aria-live="polite">
        {msgs.length === 0 && <p className="subtle" style={{ fontSize: 'var(--fs-sm)', padding: 'var(--s3)' }}>No messages yet. Say hello.</p>}
        {msgs.map((m) => (
          <p key={m.id} className="chat-msg"><Link to={`/profile/${m.userId}`} className="chat-name">{m.displayName}</Link> <span>{m.body}</span></p>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input className="input" aria-label="Message" placeholder="Message…" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-icon" aria-label="Send"><Send size={16} /></button>
      </form>
      {error && <p className="error-text" style={{ padding: '0 var(--s3) var(--s2)' }}>{error}</p>}
    </section>
  );
}
