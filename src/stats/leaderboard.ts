import type { DayRow, PlayerSeries } from '../data/types';
import { mean, median } from './regression';

const DAY_MS = 86400000;

export interface Standing {
  id: string;
  games: number;
  mean: number;
  median: number;
  best: number;
  /** Rounds scored 5000. */
  perfectRounds: number;
  /** Average over the last 30 days of the period, and its change against the 30 days before. */
  recentMean: number | null;
  recentDelta: number | null;
  /** Days on which at least one other compared player also played. */
  contested: number;
  /** Of those, days with the top score (ties count for everyone tied). */
  wins: number;
  currentStreak: number;
  longestStreak: number;
  rank: number;
}

export interface HeadToHead {
  opponent: string;
  days: number;
  wins: number;
  losses: number;
  ties: number;
  /** Average of (my total - their total) on shared days. */
  meanMargin: number;
}

export interface LeaderboardOptions {
  /** Only count challenges every compared player took part in. */
  commonOnly: boolean;
  /** Inclusive time range (UTC ms). */
  from?: number;
  to?: number;
}

function inRange(day: DayRow, options: LeaderboardOptions): boolean {
  return (options.from === undefined || day.t >= options.from) && (options.to === undefined || day.t <= options.to);
}

/** The days that count for each player under the given options. */
export function comparableDays(series: PlayerSeries[], options: LeaderboardOptions): Map<string, DayRow[]> {
  const out = new Map<string, DayRow[]>();
  let common = null as Set<string> | null;
  if (options.commonOnly && series.length > 1) {
    for (const s of series) {
      const tokens = new Set(s.days.filter((d) => inRange(d, options)).map((d) => d.token));
      common = common === null ? tokens : new Set([...common].filter((t) => tokens.has(t)));
    }
  }
  for (const s of series) out.set(s.player.id, s.days.filter((d) => inRange(d, options) && (!common || common.has(d.token))));
  return out;
}

/** Longest and current runs of consecutive calendar days played. "Current" must reach `today` or the day before. */
export function streaks(days: DayRow[], today: number): { current: number; longest: number } {
  const dates = [...new Set(days.map((d) => d.t))].sort((a, b) => a - b);
  let longest = 0, run = 0;
  for (let i = 0; i < dates.length; i++) {
    run = i > 0 && dates[i] - dates[i - 1] === DAY_MS ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const last = dates[dates.length - 1];
  const current = dates.length > 0 && today - last <= DAY_MS ? run : 0;
  return { current, longest };
}

export function standings(series: PlayerSeries[], options: LeaderboardOptions, today: number): Standing[] {
  const days = comparableDays(series, options);

  // Who won each challenge among the compared players.
  const byToken = new Map<string, { id: string; total: number }[]>();
  for (const [id, list] of days) {
    for (const d of list) {
      let entries = byToken.get(d.token);
      if (!entries) byToken.set(d.token, entries = []);
      entries.push({ id, total: d.total });
    }
  }
  const wins = new Map<string, number>(), contested = new Map<string, number>();
  for (const entries of byToken.values()) {
    if (entries.length < 2) continue;
    const top = Math.max(...entries.map((e) => e.total));
    for (const e of entries) {
      contested.set(e.id, (contested.get(e.id) ?? 0) + 1);
      if (e.total === top) wins.set(e.id, (wins.get(e.id) ?? 0) + 1);
    }
  }

  const end = options.to ?? Math.max(0, ...[...days.values()].flatMap((list) => list.map((d) => d.t)));
  const result: Standing[] = [];
  for (const s of series) {
    const list = days.get(s.player.id) ?? [];
    if (list.length === 0) continue;
    const totals = list.map((d) => d.total);
    const recent = list.filter((d) => d.t > end - 30 * DAY_MS).map((d) => d.total);
    const before = list.filter((d) => d.t > end - 60 * DAY_MS && d.t <= end - 30 * DAY_MS).map((d) => d.total);
    const streak = streaks(list, today);
    result.push({
      id: s.player.id,
      games: list.length,
      mean: mean(totals),
      median: median(totals),
      best: Math.max(...totals),
      perfectRounds: list.reduce((n, d) => n + d.rounds.filter((r) => r.score >= 5000).length, 0),
      recentMean: recent.length >= 3 ? mean(recent) : null,
      recentDelta: recent.length >= 3 && before.length >= 3 ? mean(recent) - mean(before) : null,
      contested: contested.get(s.player.id) ?? 0,
      wins: wins.get(s.player.id) ?? 0,
      currentStreak: streak.current,
      longestStreak: streak.longest,
      rank: 0,
    });
  }
  result.sort((a, b) => b.mean - a.mean);
  result.forEach((s, i) => { s.rank = i + 1; });
  return result;
}

/** One player's record against each of the others on the challenges both played. */
export function headToHead(series: PlayerSeries[], meId: string, options: LeaderboardOptions): HeadToHead[] {
  const me = series.find((s) => s.player.id === meId);
  if (!me) return [];
  const mine = new Map(me.days.filter((d) => inRange(d, options)).map((d) => [d.token, d.total]));
  const out: HeadToHead[] = [];
  for (const s of series) {
    if (s.player.id === meId) continue;
    let wins = 0, losses = 0, ties = 0, margin = 0, days = 0;
    for (const d of s.days) {
      const my = mine.get(d.token);
      if (my === undefined || !inRange(d, options)) continue;
      days++;
      margin += my - d.total;
      if (my > d.total) wins++;
      else if (my < d.total) losses++;
      else ties++;
    }
    if (days > 0) out.push({ opponent: s.player.id, days, wins, losses, ties, meanMargin: margin / days });
  }
  return out.sort((a, b) => b.days - a.days);
}
