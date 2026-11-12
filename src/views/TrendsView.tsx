import { useMemo, useState } from 'react';
import { ForestPlot, type ForestRow } from '../charts/Charts';
import { ChartBlock, TimeChart, TooltipRow, type LegendItem, type LineSeries } from '../charts/TimeChart';
import { Card, Empty, Segmented, StatTile } from '../components/ui';
import { playerColor, useApp } from '../data/store';
import type { DayRow } from '../data/types';
import { countryName } from '../geo/geo';
import { countryStats } from '../stats/countries';
import { fitBestTrend, linearTrend, mean, type TrendComparison, type TrendFit, type TrendKind } from '../stats/regression';
import { fmtDate, fmtInt, fmtP, fmtPText, fmtSigned, plural } from '../util/format';
import { navigate } from '../util/hooks';
import { scoreAxis, scoreDomain } from './shared';

const DAY_MS = 86400000;
const MONTH_DAYS = 30.44;
const MODEL_NAME: Record<TrendKind, string> = { linear: 'Straight line', log: 'Diminishing returns', plateau: 'Levelling off' };
const MODEL_FORMULA: Record<TrendKind, string> = {
  linear: 'score = a + b × days',
  log: 'score = a + b × ln(1 + games played)',
  plateau: 'score = plateau − gap × e^(−games / τ)',
};

function fitFor(days: DayRow[]): TrendComparison | null {
  if (days.length === 0) return null;
  const first = days[0].t;
  return fitBestTrend(days.map((d) => ({ days: (d.t - first) / DAY_MS, value: d.total })));
}

function describe(fit: TrendFit, days: DayRow[]): string {
  if (fit.kind === 'linear') {
    const perMonth = fit.params.perDay * MONTH_DAYS;
    return `On a straight line, scores ${perMonth >= 0 ? 'rise' : 'fall'} by about ${fmtInt(Math.abs(perMonth))} points a month.`;
  }
  if (fit.kind === 'log') {
    const perDoubling = fit.params.perLogGame * Math.LN2;
    return `Scores ${perDoubling >= 0 ? 'grow' : 'drop'} with practice, but ever more slowly: about ${fmtSigned(perDoubling)} points each time the number of games played doubles.`;
  }
  const { plateau, gap, tau } = fit.params;
  const half = tau * Math.LN2;
  if (gap >= 0) {
    return `Scores are levelling off around ${fmtInt(plateau)}. The start was about ${fmtInt(gap)} points below that; half of the remaining gap closes every ${fmtInt(half)} games (${days.length >= half ? 'that happened' : 'that would take'} ${plural(Math.round(half), 'game')}).`;
  }
  return `Scores are settling towards ${fmtInt(plateau)} from a start about ${fmtInt(-gap)} points higher (half of the drop every ${fmtInt(half)} games).`;
}

export function TrendsView() {
  const app = useApp();
  const focus = app.focus!;
  const days = focus.days;
  const [choice, setChoice] = useState<'auto' | TrendKind>('auto');

  const comparison = useMemo(() => fitFor(days), [days]);
  const others = useMemo(() => app.compare.map((s) => ({ s, fit: fitFor(s.days) })).filter((o) => o.fit), [app.compare]);
  const linear = useMemo(() => {
    if (days.length < 8) return null;
    return linearTrend(days.map((d) => (d.t - days[0].t) / DAY_MS), days.map((d) => d.total));
  }, [days]);
  const countries = useMemo(
    () => countryStats(focus.rounds, { threshold: app.settings.threshold, hasGuessCountries: !!app.geo }),
    [focus.rounds, app.settings.threshold, app.geo],
  );

  if (!comparison) {
    return <Card><Empty title="Not enough games for a learning curve yet">At least eight games in the selected period are needed. Try a longer period.</Empty></Card>;
  }
  const fit = choice === 'auto' ? comparison.best : comparison.all.find((f) => f.kind === choice) ?? comparison.best;
  const color = playerColor(focus.player);
  const lines: LineSeries[] = [
    { id: 'fit', label: `${focus.player.nick}: ${MODEL_NAME[fit.kind].toLowerCase()}`, color, points: days.map((d, i) => ({ t: d.t, v: fit.fitted[i] })) },
    ...others.map(({ s, fit: other }) => ({ id: s.player.id, label: s.player.nick, color: playerColor(s.player), points: s.days.map((d, i) => ({ t: d.t, v: other!.best.fitted[i] })) })),
  ];
  const legend: LegendItem[] = [
    { label: `${focus.player.nick}: each game`, color, kind: 'dot' },
    { label: `${focus.player.nick}: fitted curve`, color },
    { label: '95% confidence band', color, kind: 'band' },
    ...others.map(({ s }) => ({ label: `${s.player.nick}: fitted curve`, color: playerColor(s.player) })),
  ];
  const firstN = Math.min(30, Math.floor(days.length / 2));
  const early = mean(days.slice(0, firstN).map((d) => d.total));
  const late = mean(days.slice(-firstN).map((d) => d.total));

  const trending = countries.filter((c) => c.trend && c.n >= 12);
  const forest: ForestRow[] = [...trending]
    .sort((a, b) => b.n - a.n)
    .slice(0, 36)
    .sort((a, b) => b.trend!.perYear - a.trend!.perYear)
    .map((c) => ({
      key: c.cc,
      label: countryName(c.cc),
      value: c.trend!.perYear,
      lo: c.trend!.lo,
      hi: c.trend!.hi,
      significant: c.trend!.pAdjusted < 0.05,
      detail: <><TooltipRow label="Rounds" value={fmtInt(c.n)} /><TooltipRow label="Average score" value={fmtInt(c.meanScore)} /><TooltipRow label="p (adjusted)" value={fmtP(c.trend!.pAdjusted)} /></>,
    }));
  const improving = trending.filter((c) => c.trend!.pAdjusted < 0.05 && c.trend!.perYear > 0);
  const declining = trending.filter((c) => c.trend!.pAdjusted < 0.05 && c.trend!.perYear < 0);
  const names = (list: typeof trending) => list.sort((a, b) => Math.abs(b.trend!.perYear) - Math.abs(a.trend!.perYear)).slice(0, 5).map((c) => countryName(c.cc)).join(', ');

  return (
    <>
      <div className="tiles">
        <StatTile label="Current level (model)" value={fmtInt(fit.fitted[fit.fitted.length - 1])} note={`after ${plural(days.length, 'game')}`} />
        <StatTile label={`First ${firstN} games`} value={fmtInt(early)} note="average score" />
        <StatTile label={`Latest ${firstN} games`} value={fmtInt(late)} note={`${fmtSigned(late - early)} vs the start`} />
        {linear && (
          <StatTile
            label="Change per month"
            value={fmtSigned(linear.slope * MONTH_DAYS)}
            note={`95% interval ${fmtSigned(linear.slopeLo * MONTH_DAYS)} to ${fmtSigned(linear.slopeHi * MONTH_DAYS)}`}
          />
        )}
        <StatTile
          label="Is the trend real?"
          value={fit.pValue < 0.05 ? 'Yes' : 'Unclear'}
          note={`${fmtPText(fit.pValue)} against "no change"`}
        />
      </div>

      <Card
        title="Your learning curve"
        subtitle={describe(fit, days)}
        actions={(
          <Segmented<'auto' | TrendKind>
            label="Curve shape"
            value={choice}
            onChange={setChoice}
            options={[{ value: 'auto', label: 'Best fit' }, ...comparison.all.map((f) => ({ value: f.kind, label: MODEL_NAME[f.kind] }))]}
          />
        )}
      >
        <ChartBlock
          legend={legend}
          table={{
            columns: ['Date', 'Score', 'Fitted', 'Band low', 'Band high'],
            rows: [...days].map((d, i) => [fmtDate(d.t), d.total, Math.round(fit.fitted[i]), Math.round(fit.lo[i]), Math.round(fit.hi[i])]).reverse(),
          }}
        >
          <TimeChart
            ariaLabel={`Learning curve for ${focus.player.nick}: ${MODEL_NAME[fit.kind]}`}
            dots={[{ id: 'games', label: 'Score that day', color, points: days.map((d) => ({ t: d.t, v: d.total })) }]}
            lines={lines}
            band={{ label: '95% band', color, points: days.map((d, i) => ({ t: d.t, lo: fit.lo[i], hi: fit.hi[i] })) }}
            yDomain={scoreDomain([...lines, { points: days.map((d) => ({ t: d.t, v: d.total })) }])}
            yFormat={scoreAxis}
            height={360}
          />
        </ChartBlock>

        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="data">
            <caption className="visually-hidden">Comparison of curve shapes</caption>
            <thead>
              <tr><th scope="col">Curve</th><th scope="col">Formula</th><th scope="col" className="r">Explains (R²)</th><th scope="col" className="r">AIC</th><th scope="col" className="r">p vs no change</th><th scope="col" /></tr>
            </thead>
            <tbody>
              {comparison.all.map((f) => (
                <tr key={f.kind}>
                  <td style={{ fontWeight: f === fit ? 650 : 400 }}>{MODEL_NAME[f.kind]}</td>
                  <td className="secondary">{MODEL_FORMULA[f.kind]}</td>
                  <td className="r num">{(100 * f.r2).toFixed(1)}%</td>
                  <td className="r num">{f.aic.toFixed(1)}</td>
                  <td className="r num">{fmtP(f.pValue)}</td>
                  <td>{f === comparison.best && <span className="tag">best fit</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="explain">
          <summary>How to read this</summary>
          <p>
            Three shapes are fitted by least squares: a straight line over time, a curve with diminishing returns per game played, and a curve
            that approaches a plateau. "Best fit" picks the lowest AIC, staying with a two-parameter shape unless the plateau curve is clearly
            better (more than 2 AIC units). The shaded band is the 95% confidence band of the average level, not of single games: one
            day's score swings by thousands of points whatever your skill, which is why R² stays small even when the trend is unmistakable.
          </p>
        </details>
      </Card>

      <Card
        title="Learning by country"
        subtitle={trending.length === 0
          ? 'Trends appear once a country has come up at least a dozen times over two months or more.'
          : `Change in round score per year, with 95% intervals. ${improving.length ? `Clearly improving: ${names(improving)}. ` : ''}${declining.length ? `Slipping: ${names(declining)}. ` : ''}${!improving.length && !declining.length ? 'No country stands out from chance yet. ' : ''}Grey rows could be chance (false discovery rate 5%).`}
      >
        {forest.length === 0 ? <Empty title="No country has enough rounds yet" /> : (
          <ChartBlock
            table={{
              columns: ['Country', 'Rounds', 'Change per year', 'Low', 'High', 'p (adjusted)'],
              rows: forest.map((r) => {
                const c = trending.find((x) => x.cc === r.key)!;
                return [r.label, c.n, fmtSigned(r.value), fmtSigned(r.lo), fmtSigned(r.hi), fmtP(c.trend!.pAdjusted)];
              }),
            }}
          >
            <ForestPlot
              rows={forest}
              format={(v) => fmtSigned(v)}
              axisLabel="Points per year (round score, 0 to 5,000)"
              ariaLabel="Change in round score per year by country"
              onPick={(cc) => navigate('countries', { country: cc })}
            />
            {trending.length > forest.length && <p className="note" style={{ marginTop: 8 }}>Showing the {forest.length} countries with the most rounds; the Countries tab lists all {trending.length}.</p>}
          </ChartBlock>
        )}
      </Card>
    </>
  );
}
