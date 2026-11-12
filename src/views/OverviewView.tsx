import { useMemo, useState } from 'react';
import { Columns } from '../charts/Charts';
import { ChartBlock, TimeChart, TooltipRow, type LegendItem, type LineSeries } from '../charts/TimeChart';
import { Card, Delta, Dot, StatTile } from '../components/ui';
import { playerColor, useApp } from '../data/store';
import { scoreByRoundNumber } from '../stats/countries';
import { streaks } from '../stats/leaderboard';
import { fitBestTrend, mean, median } from '../stats/regression';
import { fmtDate, fmtDuration, fmtInt, fmtPct, plural } from '../util/format';
import { RoundCells, rollingLine, rollingPoints, rollingWindow, scoreAxis, scoreDomain } from './shared';

const DAY_MS = 86400000;

export function OverviewView() {
  const app = useApp();
  const focus = app.focus!;
  const [expanded, setExpanded] = useState(false);
  const days = focus.days;

  const summary = useMemo(() => {
    const totals = days.map((d) => d.total);
    const end = days.length ? days[days.length - 1].t : 0;
    const recent = days.filter((d) => d.t > end - 30 * DAY_MS).map((d) => d.total);
    const before = days.filter((d) => d.t > end - 60 * DAY_MS && d.t <= end - 30 * DAY_MS).map((d) => d.total);
    const best = days.reduce((a, d) => (d.total > a.total ? d : a), days[0]);
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    return {
      mean: mean(totals),
      median: median(totals),
      best,
      recent: recent.length >= 3 ? mean(recent) : null,
      recentDelta: recent.length >= 3 && before.length >= 3 ? mean(recent) - mean(before) : null,
      streak: streaks(days, today),
      good: focus.rounds.filter((r) => r.score >= app.settings.threshold).length / Math.max(1, focus.rounds.length),
      countries: new Set(focus.rounds.map((r) => r.cc).filter(Boolean)).size,
    };
  }, [days, focus.rounds, app.settings.threshold]);

  const window = rollingWindow(days.length);
  const chart = useMemo(() => {
    const lines: LineSeries[] = [rollingLine(focus, window)];
    for (const s of app.compare) lines.push(rollingLine(s, window));
    const first = days[0]?.t ?? 0;
    const trend = fitBestTrend(days.map((d) => ({ days: (d.t - first) / DAY_MS, value: d.total })));
    if (trend) lines.push({ id: 'trend', label: 'Trend', color: 'var(--ink-2)', dashed: true, width: 1.5, points: days.map((d, i) => ({ t: d.t, v: trend.best.fitted[i] })) });
    return { lines, trend, yDomain: scoreDomain([...lines, { points: days.map((d) => ({ t: d.t, v: d.total })) }]) };
  }, [focus, app.compare, days, window]);

  const legend: LegendItem[] = [
    { label: `${focus.player.nick}: each game`, color: playerColor(focus.player), kind: 'dot' },
    { label: `${focus.player.nick}: ${window}-game average`, color: playerColor(focus.player) },
    ...app.compare.map((s) => ({ label: s.player.nick, color: playerColor(s.player) })),
    ...(chart.trend ? [{ label: 'Trend', color: 'var(--ink-2)', kind: 'dashed' as const }] : []),
  ];
  const rolling = rollingPoints(days, window);
  const rollingByT = new Map(rolling.map((p) => [p.t, p.v]));

  const histogram = useMemo(() => {
    const bins = Array.from({ length: 25 }, (_, i) => ({ from: i * 1000, count: 0 }));
    for (const d of days) bins[Math.min(24, Math.floor(d.total / 1000))].count++;
    return bins;
  }, [days]);
  const byRound = useMemo(() => scoreByRoundNumber(focus.rounds), [focus.rounds]);

  const recentDays = useMemo(() => [...days].reverse().slice(0, expanded ? 90 : 10), [days, expanded]);
  const compareTotals = useMemo(() => app.compare.slice(0, 4).map((s) => ({ s, byToken: new Map(s.days.map((d) => [d.token, d.total])) })), [app.compare]);

  return (
    <>
      <div className="tiles">
        <StatTile label="Games played" value={fmtInt(days.length)} note={`${fmtDate(days[0].t)} – ${fmtDate(days[days.length - 1].t)}`} />
        <StatTile label="Average score" value={fmtInt(summary.mean)} note={`median ${fmtInt(summary.median)}`} />
        <StatTile
          label="Last 30 days"
          value={summary.recent !== null ? fmtInt(summary.recent) : '–'}
          note={summary.recentDelta !== null ? <><Delta value={summary.recentDelta} /> vs the 30 days before</> : 'not enough games yet'}
        />
        <StatTile label="Best game" value={fmtInt(summary.best.total)} note={fmtDate(summary.best.t)} />
        <StatTile label="Good rounds" value={fmtPct(summary.good)} note={`${fmtInt(app.settings.threshold)}+ points`} />
        <StatTile label="Daily streak" value={plural(summary.streak.current, 'day')} note={`longest ${plural(summary.streak.longest, 'day')}`} />
        <StatTile label="Countries seen" value={fmtInt(summary.countries)} />
      </div>

      <Card
        title="Total score over time"
        subtitle={`Each dot is one Daily Challenge (out of 25,000). Lines are trailing ${window}-game averages${app.compare.length ? ', one per player' : ''}.`}
      >
        <ChartBlock
          legend={legend}
          table={{
            columns: ['Date', 'Score', `${window}-game average`],
            rows: [...days].reverse().map((d) => [fmtDate(d.t), d.total, rollingByT.has(d.t) ? Math.round(rollingByT.get(d.t)!) : '–']),
          }}
        >
          <TimeChart
            ariaLabel={`Daily Challenge total score over time for ${focus.player.nick}`}
            dots={[{ id: 'games', label: 'Score that day', color: playerColor(focus.player), points: days.map((d) => ({ t: d.t, v: d.total })) }]}
            lines={chart.lines}
            yDomain={chart.yDomain}
            yFormat={scoreAxis}
            endLabels={app.compare.length > 0 && app.compare.length <= 3}
            height={340}
          />
        </ChartBlock>
      </Card>

      <div className="grid two">
        <Card title="How your scores are spread" subtitle="Number of games by total score, in bands of 1,000 points.">
          <Columns
            ariaLabel="Histogram of total scores"
            counts
            data={histogram.map((b) => ({
              key: String(b.from),
              label: b.from % 5000 === 0 ? scoreAxis(b.from) : '',
              value: b.count,
              tooltip: <><div className="tooltip-title">{fmtInt(b.from)} – {fmtInt(b.from + 999)}</div><TooltipRow label="Games" value={fmtInt(b.count)} /></>,
            }))}
          />
        </Card>
        <Card title="Round by round" subtitle="Average score by position in the game: do you warm up, or fade?">
          <Columns
            ariaLabel="Average score by round number"
            yMax={5000}
            data={byRound.map((b) => ({
              key: String(b.round),
              label: `Round ${b.round}`,
              value: b.mean,
              tooltip: <><div className="tooltip-title">Round {b.round}</div><TooltipRow label="Average" value={fmtInt(b.mean)} /><TooltipRow label="Rounds" value={fmtInt(b.n)} /></>,
            }))}
          />
        </Card>
      </div>

      <Card
        title="Recent games"
        subtitle="The five rounds of each game: country and score. Darker cells are better rounds; hover a cell for the place and distance."
        actions={days.length > 10 && <button type="button" className="btn small" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Show fewer' : 'Show more'}</button>}
      >
        <div className={`table-wrap${expanded ? ' capped' : ''}`}>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="r">Score</th>
                <th scope="col">Rounds 1–5</th>
                <th scope="col" className="r">Time</th>
                {compareTotals.map(({ s }) => (
                  <th scope="col" className="r" key={s.player.id}><span className="place" style={{ justifyContent: 'flex-end' }}><Dot color={playerColor(s.player)} />{s.player.nick}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentDays.map((d) => (
                <tr key={d.token}>
                  <td>{fmtDate(d.t)}</td>
                  <td className="r num" style={{ fontWeight: 650 }}>{fmtInt(d.total)}</td>
                  <td><RoundCells rounds={d.rounds} geo={app.geo} /></td>
                  <td className="r num">{fmtDuration(d.totalTime)}</td>
                  {compareTotals.map(({ s, byToken }) => {
                    const other = byToken.get(d.token);
                    return (
                      <td className="r num" key={s.player.id}>
                        {other === undefined ? <span className="muted">–</span> : <>{fmtInt(other)} <span className="muted">({other > d.total ? '+' : other < d.total ? '−' : '±'}{fmtInt(Math.abs(other - d.total))})</span></>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
