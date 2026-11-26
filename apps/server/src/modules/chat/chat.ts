import type { Db } from '../../db/pool.js';
import { HttpError } from '../../http/errors.js';
import type { AuthUser } from '../auth/sessions.js';

interface ChatRules { allowLinks: boolean; maxLength: number; perMinute: number; bannedWords: string[] }
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|al|gg|me|ly|xyz)\b)/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function sanitizeChat(body: string, rules: ChatRules): { ok: true; text: string } | { ok: false; error: string } {
  const text = body.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'Message is empty.' };
  if (text.length > rules.maxLength) return { ok: false, error: `Messages are limited to ${rules.maxLength} characters.` };
  if (!rules.allowLinks && LINK.test(text)) return { ok: false, error: 'Links are not allowed in chat.' };
  let out = text;
  for (const w of rules.bannedWords) {
    if (!w) continue;
    out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '•'.repeat(w.length));
  }
  return { ok: true, text: out };
}

export class ChatService {
  private recent = new Map<string, number[]>();
  private rulesCache: { at: number; rules: ChatRules } | null = null;
  constructor(private readonly db: Db) {}

  private async rules(): Promise<ChatRules> {
    if (this.rulesCache && Date.now() - this.rulesCache.at < 30_000) return this.rulesCache.rules;
    const r = await this.db.query(`SELECT value FROM app_config WHERE key = 'chat'`);
    const rules = { allowLinks: false, maxLength: 300, perMinute: 12, bannedWords: [], ...(r.rows[0]?.value ?? {}) } as ChatRules;
    this.rulesCache = { at: Date.now(), rules };
    return rules;
  }

  private async channelId(channel: string): Promise<string> {
    const r = channel === 'lobby'
      ? await this.db.query(`SELECT id FROM chat_channels WHERE kind = 'lobby'`)
      : await this.db.query(`SELECT id FROM chat_channels WHERE kind = 'table' AND table_id = $1`, [channel.slice(6)]);
    if (!r.rows[0]) throw new HttpError(404, 'NO_CHANNEL', 'Chat channel not found.');
    return r.rows[0].id;
  }

  async send(user: AuthUser, channel: string, body: string) {
    if (user.chatMutedUntil && user.chatMutedUntil.getTime() > Date.now()) throw new HttpError(403, 'MUTED', 'You are muted in chat.');
    const muted = await this.db.query('SELECT chat_muted_until FROM users WHERE id = $1 AND chat_muted_until > now()', [user.id]);
    if (muted.rowCount) throw new HttpError(403, 'MUTED', 'You are muted in chat.');
    const rules = await this.rules();
    const now = Date.now();
    const times = (this.recent.get(user.id) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= rules.perMinute) throw new HttpError(429, 'RATE_LIMITED', 'You are sending messages too quickly.');
    if (times.length >= 3 && now - times[times.length - 3]! < 2000) throw new HttpError(429, 'RATE_LIMITED', 'You are sending messages too quickly.');
    const clean = sanitizeChat(body, rules);
    if (!clean.ok) throw new HttpError(400, 'BAD_MESSAGE', clean.error);
    times.push(now);
    this.recent.set(user.id, times);
    const cid = await this.channelId(channel);
    const r = await this.db.query('INSERT INTO chat_messages (channel_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, created_at', [cid, user.id, clean.text]);
    return { id: r.rows[0].id, channel, userId: user.id, displayName: user.displayName, body: clean.text, createdAt: r.rows[0].created_at };
  }

  async history(channel: string, viewerId: string) {
    const cid = await this.channelId(channel);
    const r = await this.db.query(
      `SELECT m.id, m.user_id, p.display_name, m.body, m.created_at FROM chat_messages m JOIN user_profiles p ON p.user_id = m.user_id
        WHERE m.channel_id = $1 AND m.hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = $2 AND b.blocked_id = m.user_id)
          AND NOT EXISTS (SELECT 1 FROM user_mutes mu WHERE mu.muter_id = $2 AND mu.muted_id = m.user_id)
        ORDER BY m.id DESC LIMIT 50`,
      [cid, viewerId],
    );
    return r.rows.reverse().map((m) => ({ id: m.id, channel, userId: m.user_id, displayName: m.display_name, body: m.body, createdAt: m.created_at }));
  }
}
