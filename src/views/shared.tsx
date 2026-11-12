import { classScale, Flag, SEQUENTIAL, SEQUENTIAL_INK } from '../components/ui';
import type { ChartPoint, LineSeries } from '../charts/TimeChart';
import { playerColor } from '../data/store';
import type { DayRow, PlayerSeries, RoundRow } from '../data/types';
import { countryName, type Geo } from '../geo/geo';
import { rollingMean } from '../stats/regression';
import { fmtInt, fmtKm } from '../util/format';

const ROUND_SCALE = classScale(0, 5000, 7);

/** The five rounds of a game as a strip of cells: darker is better, country on top. */
export function RoundCells({ rounds, geo }: { rounds: RoundRow[]; geo: Geo | null }) {
  return (
    <span className="rounds">
      {rounds.map((r) => {
        const c = ROUND_SCALE.classOf(r.score);
        const region = geo && r.region >= 0 ? geo.regions[r.region].name : null;
        const where = [region, r.cc ? countryName(r.cc) : null].filter(Boolean).join(', ') || 'Unknown location';
        const detail = `Round ${r.round + 1}: ${where} · ${fmtInt(r.score)} points${r.distance !== null ? ` · ${fmtKm(r.distance / 1000)} away` : r.timedOut ? ' · timed out' : ''}`;
        return (
          <span key={r.round} className="round-cell" style={{ background: SEQUENTIAL[ROUND_SCALE.colors[c]], color: SEQUENTIAL_INK[ROUND_SCALE.colors[c]] }} title={detail} aria-label={detail}>
            <small><Flag cc={r.cc} /></small>
            <span className="num">{fmtInt(r.score)}</span>
          </span>
        );
      })}
    </span>
  );
}

/** How many games the trailing average spans, given how much data there is. */
export function rollingWindow(games: number): number {
  return games >= 240 ? 30 : games >= 90 ? 20 : games >= 30 ? 10 : 5;
}

export function rollingPoints(days: DayRow[], window: number): ChartPoint[] {
  const means = rollingMean(days.map((d) => d.total), window, Math.min(window, 3));
  const out: ChartPoint[] = [];
  days.forEach((d, i) => { if (means[i] !== null) out.push({ t: d.t, v: means[i]! }); });
  return out;
}

export function rollingLine(series: PlayerSeries, window: number, suffix = ''): LineSeries {
  return { id: `roll-${series.player.id}`, label: `${series.player.nick}${suffix}`, color: playerColor(series.player), points: rollingPoints(series.days, window) };
}

/** Total-score axis from the lowest value drawn (rounded down to 5,000) up to the maximum of 25,000. */
export function scoreDomain(series: { points: ChartPoint[] }[]): [number, number] {
  let low = 25000;
  for (const s of series) for (const p of s.points) if (p.v < low) low = p.v;
  const floor = Math.max(0, Math.floor(low / 5000) * 5000);
  return [Math.min(floor, 20000), 25000];
}

/** Axis labels for total scores (an axis that reaches 10,000 is compact throughout: 0 / 5K / 10K). */
export const scoreAxis = (v: number): string => (v === 0 ? '0' : `${Number.isInteger(v / 1000) ? v / 1000 : (v / 1000).toFixed(1)}K`);
