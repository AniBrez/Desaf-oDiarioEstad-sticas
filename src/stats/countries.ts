import type { RoundRow } from '../data/types';
import { benjaminiHochberg, linearTrend, median } from './regression';

const YEAR_MS = 365.25 * 86400000;

export interface CountryStat {
  cc: string;
  /** Rounds played in the country. */
  n: number;
  meanScore: number;
  medianScore: number;
  /** Share of rounds scoring at least the "good round" threshold. */
  goodRate: number;
  /** Share of rounds where the guess landed in the right country (null without geodata). */
  hitRate: number | null;
  meanDistanceKm: number | null;
  best: number;
  worst: number;
  firstT: number;
  lastT: number;
  /** Change in round score per year, with a 95% interval; null when there is too little to go on. */
  trend: { perYear: number; lo: number; hi: number; pValue: number; pAdjusted: number } | null;
  /** The country most often guessed instead. */
  mixedUpWith: { cc: string; count: number } | null;
}

export interface CountryStatOptions {
  threshold: number;
  /** Whether guess countries were resolved (geodata loaded). */
  hasGuessCountries: boolean;
  /** Minimum rounds and time span before a trend is reported. */
  minTrendRounds?: number;
  minTrendDays?: number;
}

export function countryStats(rounds: RoundRow[], options: CountryStatOptions): CountryStat[] {
  const groups = new Map<string, RoundRow[]>();
  for (const r of rounds) {
    if (!r.cc) continue;
    let list = groups.get(r.cc);
    if (!list) groups.set(r.cc, list = []);
    list.push(r);
  }
  const minRounds = options.minTrendRounds ?? 8;
  const minSpan = (options.minTrendDays ?? 60) * 86400000;
  const stats: CountryStat[] = [];
  for (const [cc, list] of groups) {
    list.sort((a, b) => a.t - b.t);
    const scores = list.map((r) => r.score);
    const distances = list.map((r) => r.distance).filter((d): d is number => d !== null);
    const guessed = list.filter((r) => r.guessLat !== null);
    const wrong = new Map<string, number>();
    let hits = 0;
    for (const r of guessed) {
      if (r.guessCc === cc) hits++;
      else if (r.guessCc) wrong.set(r.guessCc, (wrong.get(r.guessCc) ?? 0) + 1);
    }
    const mixed = [...wrong.entries()].sort((a, b) => b[1] - a[1])[0];
    let trend: CountryStat['trend'] = null;
    const firstT = list[0].t, lastT = list[list.length - 1].t;
    if (list.length >= minRounds && lastT - firstT >= minSpan) {
      const fit = linearTrend(list.map((r) => (r.t - firstT) / YEAR_MS), scores);
      if (fit) trend = { perYear: fit.slope, lo: fit.slopeLo, hi: fit.slopeHi, pValue: fit.pValue, pAdjusted: fit.pValue };
    }
    stats.push({
      cc,
      n: list.length,
      meanScore: scores.reduce((s, v) => s + v, 0) / list.length,
      medianScore: median(scores),
      goodRate: scores.filter((s) => s >= options.threshold).length / list.length,
      hitRate: options.hasGuessCountries && guessed.length > 0 ? hits / list.length : null,
      meanDistanceKm: distances.length ? distances.reduce((s, v) => s + v, 0) / distances.length / 1000 : null,
      best: Math.max(...scores),
      worst: Math.min(...scores),
      firstT,
      lastT,
      trend,
      mixedUpWith: options.hasGuessCountries && mixed && mixed[1] >= 2 ? { cc: mixed[0], count: mixed[1] } : null,
    });
  }
  // Many countries are tested at once, so control the false discovery rate.
  const withTrend = stats.filter((s) => s.trend);
  const adjusted = benjaminiHochberg(withTrend.map((s) => s.trend!.pValue));
  withTrend.forEach((s, i) => { s.trend!.pAdjusted = adjusted[i]; });
  return stats.sort((a, b) => b.n - a.n || a.cc.localeCompare(b.cc));
}

/** Average score by round position (1 to 5): do you warm up, or fade? */
export function scoreByRoundNumber(rounds: RoundRow[]): { round: number; n: number; mean: number }[] {
  const sums = new Map<number, { n: number; sum: number }>();
  for (const r of rounds) {
    const s = sums.get(r.round) ?? { n: 0, sum: 0 };
    s.n++; s.sum += r.score;
    sums.set(r.round, s);
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([round, s]) => ({ round: round + 1, n: s.n, mean: s.sum / s.n }));
}
