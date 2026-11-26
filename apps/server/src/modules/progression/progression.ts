import type { HandState } from '@noir/engine';
import type { Queryable, Tx } from '../../db/pool.js';

export interface ProgressNotice {
  userId: string;
  kind: 'level_up' | 'achievement' | 'quest_complete';
  title: string;
  body: string;
  data: Record<string, unknown>;
}

interface XpRules { version: number; handPlayed: number; handWon: number; showdownWon: number; dailyHandXpCap: number }

export async function xpRules(q: Queryable): Promise<XpRules> {
  const r = await q.query<{ value: XpRules }>(`SELECT value FROM app_config WHERE key = 'xp_rules'`);
  return r.rows[0]?.value ?? { version: 1, handPlayed: 2, handWon: 3, showdownWon: 2, dailyHandXpCap: 300 };
}

/** Pure XP computation for one player's hand — exported for unit tests. */
export function xpForHand(rules: XpRules, o: { voluntary: boolean; won: boolean; showdownWon: boolean; contested: boolean; xpToday: number }): number {
  // Anti-farming: a hand only counts if at least two players put chips in voluntarily (no walks),
  // and XP from hands is capped per day.
  if (!o.contested) return 0;
  let xp = rules.handPlayed;
  if (o.won && o.voluntary) xp += rules.handWon;
  if (o.showdownWon) xp += rules.showdownWon;
  return Math.max(0, Math.min(xp, rules.dailyHandXpCap - o.xpToday));
}

export function levelForXp(levels: { level: number; xp_required: number }[], xp: number): number {
  let lvl = 1;
  for (const l of levels) if (xp >= l.xp_required) lvl = Math.max(lvl, l.level);
  return lvl;
}

/**
 * Server-side progression after a completed hand: stats, XP (idempotent per hand), level,
 * achievements and quests. Runs inside the hand-completion transaction.
 */
export async function onHandComplete(tx: Tx, handId: string, s: HandState): Promise<ProgressNotice[]> {
  const result = s.result!;
  const rules = await xpRules(tx);
  const notices: ProgressNotice[] = [];
  const winners = new Set(result.awards.flatMap((a) => a.winners.map((w) => w.seat)));
  const potWon = new Map<number, number>();
  for (const a of result.awards) for (const w of a.winners) potWon.set(w.seat, (potWon.get(w.seat) ?? 0) + w.amount);
  const voluntary = new Set<number>();
  // Voluntary = contributed more than forced blinds/antes.
  for (const p of s.players) {
    const forced = (p.seat === s.sbSeat ? s.config.smallBlind : 0) + (p.seat === s.bbSeat ? s.config.bigBlind : 0) + s.config.ante;
    if (p.totalCommitted > forced) voluntary.add(p.seat);
  }
  const contested = voluntary.size >= 2 || result.wentToShowdown;
  const totalPot = result.pots.reduce((a, p) => a + p.amount, 0);

  for (const p of s.players) {
    const won = winners.has(p.seat);
    const sdWon = won && result.wentToShowdown && p.status !== 'folded';
    const sd = result.wentToShowdown && p.status !== 'folded';
    const foldedPre = p.status === 'folded' && p.streetCommitted >= 0 && s.board.length === 0;
    await tx.query(
      `UPDATE player_stats SET hands_played = hands_played + 1, hands_won = hands_won + $2::int, showdowns = showdowns + $3::int,
         showdowns_won = showdowns_won + $4::int, folds = folds + $5::int, preflop_folds = preflop_folds + $6::int,
         total_pot_won = total_pot_won + $7, largest_pot = GREATEST(largest_pot, $8),
         current_streak = CASE WHEN $2::int = 1 THEN current_streak + 1 ELSE 0 END,
         best_streak = GREATEST(best_streak, CASE WHEN $2::int = 1 THEN current_streak + 1 ELSE 0 END), updated_at = now()
       WHERE user_id = $1`,
      [p.playerId, +won, +sd, +sdWon, +(p.status === 'folded'), +foldedPre, potWon.get(p.seat) ?? 0, won ? totalPot : 0],
    );

    const today = await tx.query<{ s: number }>(`SELECT COALESCE(SUM(amount),0)::int AS s FROM xp_ledger WHERE user_id = $1 AND source = 'hand' AND created_at >= date_trunc('day', now())`, [p.playerId]);
    const xp = xpForHand(rules, { voluntary: voluntary.has(p.seat), won, showdownWon: sdWon, contested, xpToday: today.rows[0]!.s });
    if (xp > 0) await awardXp(tx, p.playerId, xp, 'hand', handId, rules.version, notices);

    await progressQuests(tx, p.playerId, { hands_played: 1, hands_won: won ? 1 : 0, showdowns_won: sdWon ? 1 : 0 }, notices, rules.version);
    await checkAchievements(tx, p.playerId, notices, rules.version);
  }
  for (const n of notices) await tx.query('INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,$2,$3,$4,$5)', [n.userId, n.kind, n.title, n.body, n.data]);
  return notices;
}

export async function awardXp(tx: Tx, userId: string, amount: number, source: string, referenceId: string, ruleVersion: number, notices: ProgressNotice[]): Promise<void> {
  const ins = await tx.query('INSERT INTO xp_ledger (user_id, amount, source, reference_id, rule_version) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, source, reference_id) DO NOTHING', [userId, amount, source, referenceId, ruleVersion]);
  if (!ins.rowCount) return;
  const prog = (await tx.query<{ xp_total: number; level: number }>('UPDATE user_progress SET xp_total = xp_total + $2, updated_at = now() WHERE user_id = $1 RETURNING xp_total, level', [userId, amount])).rows[0]!;
  const levels = (await tx.query<{ level: number; xp_required: number; rank_key: string }>('SELECT level, xp_required, rank_key FROM levels ORDER BY level')).rows;
  const newLevel = levelForXp(levels, prog.xp_total);
  if (newLevel > prog.level) {
    await tx.query('UPDATE user_progress SET level = $2 WHERE user_id = $1', [userId, newLevel]);
    for (let l = prog.level + 1; l <= newLevel; l++) await tx.query('INSERT INTO level_history (user_id, level) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, l]);
    const rank = levels.find((l) => l.level === newLevel)!.rank_key;
    notices.push({ userId, kind: 'level_up', title: `Level ${newLevel}`, body: `You reached level ${newLevel}.`, data: { level: newLevel, rank } });
  }
}

async function progressQuests(tx: Tx, userId: string, deltas: Record<string, number>, notices: ProgressNotice[], ruleVersion: number) {
  const quests = (await tx.query<{ key: string; name: string; period: string; metric: string; target: number; xp_reward: number }>('SELECT key, name, period, metric, target, xp_reward FROM quests WHERE active')).rows;
  for (const q of quests) {
    const d = deltas[q.metric];
    if (!d) continue;
    const period = q.period === 'daily' ? `date_trunc('day', now())::date` : `date_trunc('week', now())::date`;
    const r = await tx.query<{ progress: number; completed_at: Date | null; period_start: Date }>(
      `INSERT INTO quest_progress (user_id, quest_key, period_start, progress) VALUES ($1, $2, ${period}, LEAST($3::int, $4::int))
       ON CONFLICT (user_id, quest_key, period_start) DO UPDATE SET progress = LEAST(quest_progress.progress + $3::int, $4::int)
       WHERE quest_progress.completed_at IS NULL
       RETURNING progress, completed_at, period_start`,
      [userId, q.key, d, q.target],
    );
    const row = r.rows[0];
    if (row && !row.completed_at && row.progress >= q.target) {
      await tx.query('UPDATE quest_progress SET completed_at = now() WHERE user_id = $1 AND quest_key = $2 AND period_start = $3', [userId, q.key, row.period_start]);
      notices.push({ userId, kind: 'quest_complete', title: 'Mission complete', body: `${q.name} (+${q.xp_reward} XP)`, data: { quest: q.key } });
      if (q.xp_reward > 0) await awardXp(tx, userId, q.xp_reward, 'quest', `${q.key}:${new Date(row.period_start).toISOString().slice(0, 10)}`, ruleVersion, notices);
    }
  }
}

async function checkAchievements(tx: Tx, userId: string, notices: ProgressNotice[], ruleVersion: number) {
  const stats = (await tx.query('SELECT * FROM player_stats WHERE user_id = $1', [userId])).rows[0] as Record<string, number> | undefined;
  if (!stats) return;
  const list = (await tx.query<{ key: string; name: string; metric: string; threshold: number; xp_reward: number; rarity: string }>(
    `SELECT a.key, a.name, a.metric, a.threshold, a.xp_reward, a.rarity FROM achievements a
       LEFT JOIN user_achievements ua ON ua.achievement_key = a.key AND ua.user_id = $1
      WHERE a.active AND ua.unlocked_at IS NULL`, [userId])).rows;
  for (const a of list) {
    const value = Number(stats[a.metric] ?? 0);
    const unlocked = value >= a.threshold;
    await tx.query(
      `INSERT INTO user_achievements (user_id, achievement_key, progress, unlocked_at) VALUES ($1,$2,$3, CASE WHEN $4 THEN now() END)
       ON CONFLICT (user_id, achievement_key) DO UPDATE SET progress = EXCLUDED.progress, unlocked_at = COALESCE(user_achievements.unlocked_at, EXCLUDED.unlocked_at)`,
      [userId, a.key, Math.min(value, a.threshold), unlocked],
    );
    if (unlocked) {
      notices.push({ userId, kind: 'achievement', title: 'Achievement unlocked', body: a.name, data: { achievement: a.key, rarity: a.rarity } });
      if (a.xp_reward > 0) await awardXp(tx, userId, a.xp_reward, 'achievement', a.key, ruleVersion, notices);
    }
  }
}
