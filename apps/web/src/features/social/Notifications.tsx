import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../../net/api';
import { getSocket } from '../../net/socket';

interface N { id: number; kind: string; title: string; body: string | null; read_at: string | null; created_at: string }

export function NotificationsButton() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<N[]>([]);
  const [unread, setUnread] = useState(0);
  const load = () => void api.get<{ notifications: N[]; unread: number }>('/notifications').then((r) => { setList(r.notifications); setUnread(r.unread); }).catch(() => undefined);
  useEffect(() => {
    load();
    const s = getSocket();
    const on = () => load();
    s.on('notify', on);
    return () => { s.off('notify', on); };
  }, []);
  const toggle = async () => {
    setOpen(!open);
    if (!open && unread) { await api.post('/notifications/read').catch(() => undefined); setUnread(0); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={toggle}>
        <Bell size={18} />{unread > 0 && <span className="dot-count num">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="menu card notif" role="dialog" aria-label="Notifications" onMouseLeave={() => setOpen(false)}>
          {list.length === 0 ? <p className="subtle" style={{ padding: 'var(--s4)', fontSize: 'var(--fs-sm)' }}>You are all caught up.</p>
            : list.slice(0, 15).map((n) => (
              <div key={n.id} className={`notif-item ${n.read_at ? '' : 'unread'}`}>
                <strong>{n.title}</strong>{n.body && <p>{n.body}</p>}<span className="subtle">{new Date(n.created_at).toLocaleString()}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
