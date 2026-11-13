import { useMemo, useState } from 'react';
import { ChartBlock, TimeChart, type LineSeries } from '../charts/TimeChart';
import { Card, Delta, Dot, Empty } from '../components/ui';
import { ExportButtons } from '../export/ExportKit';
import { playerColor, useApp } from '../data/store';
import { comparableDays, headToHead, standings } from '../stats/leaderboard';
import { rollingMeanByTime } from '../stats/regression';
import { fmtInt, fmtPct, fmtSigned, plural } from '../util/format';
import { href } from '../util/hooks';
import { scoreAxis } from './shared';

const DAY_MS = 86400000;

export function LeaderboardView() {
  const app = useApp();
  const focus = app.focus!;
  const players = app.shown;
  const [commonOnly, setCommonOnly] = useState(false);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;

  const options = useMemo(() => ({ commonOnly }), [commonOnly]);
  const table = useMemo(() => standings(players, options, today), [players, options, today]);
  const days = useMemo(() => comparableDays(players, options), [players, options]);
  const duels = useMemo(() => headToHead(players, focus.player.id, options), [players, focus.player.id, options]);
  const byId = new Map(players.map((s) => [s.player.id, s.player]));

  const lines = useMemo<LineSeries[]>(() => players.map((s) => {
    const list = days.get(s.player.id) ?? [];
    const means = rollingMeanByTime(list.map((d) => d.t), list.map((d) => d.total), 30 * DAY_MS, 3);
    return {
      id: s.player.id,
      label: s.player.nick,
      color: playerColor(s.player),
      points: list.flatMap((d, i) => (means[i] === null ? [] : [{ t: d.t, v: means[i]! }])),
    };
  }).filter((l) => l.points.length > 0), [players, days]);

  const sharedCount = commonOnly ? (days.get(focus.player.id)?.length ?? 0) : null;
  const allValues = lines.flatMap((l) => l.points.map((p) => p.v));
  const low = allValues.length ? Math.floor(Math.min(...allValues) / 2500) * 2500 : 0;
  const high = allValues.length ? Math.min(25000, Math.ceil(Math.max(...allValues) / 2500) * 2500) : 25000;
  const pointAt = new Map(lines.map((l) => [l.id, new Map(l.points.map((p) => [p.t, p.v]))]));
  const dates = [...new Set(lines.flatMap((l) => l.points.map((p) => p.t)))].sort((a, b) => b - a);

  return (
    <>
      <Card
        title="Leaderboard"
        subtitle={players.length < 2
          ? undefined
          : commonOnly
            ? `Only the ${plural(sharedCount ?? 0, 'challenge')} that all ${players.length} players took part in.`
            : 'Every game each player has in the period. Wins are counted on days at least two of you played.'}
        actions={(
          <>
            {players.length > 1 && <label className="switch"><input type="checkbox" checked={commonOnly} onChange={(e) => setCommonOnly(e.target.checked)} />Only days everyone played</label>}
            <ExportButtons item={{
              title: 'Leaderboard',
              csv: () => [{
                name: commonOnly ? 'standings (days everyone played)' : 'standings',
                columns: ['Rank', 'Player', 'Games', 'Average', 'Median', 'Best', 'Days won', 'Days contested', 'Last 30 days average', 'Change vs previous 30 days', 'Perfect rounds', 'Current streak', 'Longest streak'],
                rows: table.map((s) => [s.rank, byId.get(s.id)?.nick ?? s.id, s.games, Math.round(s.mean), Math.round(s.median), s.best, s.wins, s.contested, s.recentMean === null ? null : Math.round(s.recentMean), s.recentDelta === null ? null : Math.round(s.recentDelta), s.perfectRounds, s.currentStreak, s.longestStreak]),
              }],
            }} />
          </>
        )}
      >
        {players.length < 2 && (
          <p className="note" style={{ marginBottom: 12 }}>
            It is just you so far. Friends on GeoGuessr are included automatically when you collect your data, and anyone can send you their own export: see <a href={href('data')}>Data &amp; friends</a>.
          </p>
        )}
        {table.length === 0 ? <Empty title="No games in common in this period">Try a longer period, or turn off "Only days everyone played".</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <caption className="visually-hidden">Player standings</caption>
              <thead>
                <tr>
                  <th scope="col" className="r">#</th>
                  <th scope="col">Player</th>
                  <th scope="col" className="r">Games</th>
                  <th scope="col" className="r">Average</th>
                  <th scope="col" className="r">Median</th>
                  <th scope="col" className="r">Best</th>
                  <th scope="col" className="r" title="Days with the top score among the compared players, out of days at least two played">Days won</th>
                  <th scope="col" className="r">Last 30 days</th>
                  <th scope="col" className="r" title="Rounds scored 5,000">Perfect rounds</th>
                  <th scope="col" className="r" title="Consecutive days played: current and longest">Streak</th>
                </tr>
              </thead>
              <tbody>
                {table.map((s) => {
                  const p = byId.get(s.id)!;
                  return (
                    <tr key={s.id} aria-selected={s.id === focus.player.id}>
                      <td className="r num">{s.rank}</td>
                      <td><span className="place"><Dot color={playerColor(p)} /><span style={{ fontWeight: 600 }}>{p.nick}</span></span></td>
                      <td className="r num">{fmtInt(s.games)}</td>
                      <td className="r num" style={{ fontWeight: 650 }}>{fmtInt(s.mean)}</td>
                      <td className="r num">{fmtInt(s.median)}</td>
                      <td className="r num">{fmtInt(s.best)}</td>
                      <td className="r num">{s.contested ? <>{fmtInt(s.wins)} <span className="muted">of {fmtInt(s.contested)} ({fmtPct(s.wins / s.contested)})</span></> : <span className="muted">–</span>}</td>
                      <td className="r num">{s.recentMean !== null ? <>{fmtInt(s.recentMean)} {s.recentDelta !== null && <Delta value={s.recentDelta} />}</> : <span className="muted">–</span>}</td>
                      <td className="r num">{fmtInt(s.perfectRounds)}</td>
                      <td className="r num">{s.currentStreak} <span className="muted">/ {s.longestStreak}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {lines.length > 0 && (
        <Card title="Form over time" subtitle="Average total score over the previous 30 days, for each player (needs at least three games in the window).">
          <ChartBlock
            title="Form over time"
            subtitle="Average total score over the previous 30 days, for each player."
            legend={lines.map((l) => ({ label: l.label, color: l.color }))}
            table={{
              columns: ['Date', ...lines.map((l) => `${l.label}: 30-day average`)],
              rows: dates.map((t) => [new Date(t).toISOString().slice(0, 10), ...lines.map((l) => { const p = pointAt.get(l.id)?.get(t); return p === undefined ? '' : Math.round(p); })]),
            }}
          >
            <TimeChart
              ariaLabel="30-day average total score per player over time"
              lines={lines}
              yDomain={[low, high === low ? low + 2500 : high]}
              yFormat={scoreAxis}
              endLabels={lines.length <= 4}
              height={320}
            />
          </ChartBlock>
        </Card>
      )}

      {duels.length > 0 && (
        <Card
          title={`Head to head: ${focus.player.nick} against each friend`}
          subtitle="On the challenges both of you played."
          actions={<ExportButtons item={{
            title: 'Head to head',
            csv: () => [{
              name: 'head to head',
              columns: ['Player', 'Against', 'Shared days', 'Won', 'Tied', 'Lost', 'Days won (%)', 'Average margin'],
              rows: duels.map((d) => [focus.player.nick, byId.get(d.opponent)?.nick ?? d.opponent, d.days, d.wins, d.ties, d.losses, +((100 * d.wins) / d.days).toFixed(1), Math.round(d.meanMargin)]),
            }],
          }} />}
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Against</th>
                  <th scope="col" className="r">Shared days</th>
                  <th scope="col">Won · tied · lost</th>
                  <th scope="col" className="r">Days won</th>
                  <th scope="col" className="r" title="Average of your score minus theirs">Average margin</th>
                </tr>
              </thead>
              <tbody>
                {duels.map((d) => {
                  const opponent = byId.get(d.opponent)!;
                  const parts = [
                    { n: d.wins, color: playerColor(focus.player), label: `${focus.player.nick} won ${d.wins}` },
                    { n: d.ties, color: 'var(--axis)', label: `${d.ties} tied` },
                    { n: d.losses, color: playerColor(opponent), label: `${opponent.nick} won ${d.losses}` },
                  ].filter((p) => p.n > 0);
                  return (
                    <tr key={d.opponent}>
                      <td><span className="place"><Dot color={playerColor(opponent)} />{opponent.nick}</span></td>
                      <td className="r num">{fmtInt(d.days)}</td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 2, width: 150, height: 8, verticalAlign: 'middle', marginRight: 10 }} role="img" aria-label={parts.map((p) => p.label).join(', ')}>
                          {parts.map((p, i) => (
                            <span key={i} title={p.label} style={{ flex: p.n, background: p.color, borderRadius: `${i === 0 ? 4 : 0}px ${i === parts.length - 1 ? 4 : 0}px ${i === parts.length - 1 ? 4 : 0}px ${i === 0 ? 4 : 0}px` }} />
                          ))}
                        </span>
                        <span className="num">{d.wins} · {d.ties} · {d.losses}</span>
                      </td>
                      <td className="r num">{fmtPct(d.wins / d.days)}</td>
                      <td className="r num" style={{ fontWeight: 650 }}>{fmtSigned(d.meanMargin)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
