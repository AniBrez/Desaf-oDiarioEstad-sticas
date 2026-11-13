import { useEffect, useMemo, useRef } from 'react';
import { ChartBlock, TimeChart, type LegendItem, type LineSeries } from '../charts/TimeChart';
import { Card, DataTable, Empty, Place, StatTile, type Column } from '../components/ui';
import { Tiles } from '../export/ExportKit';
import { playerColor, useApp } from '../data/store';
import type { RoundRow } from '../data/types';
import { countryName } from '../geo/geo';
import { countryStats, type CountryStat } from '../stats/countries';
import { fitTrend, rollingMean } from '../stats/regression';
import { fmtDate, fmtInt, fmtKm, fmtPct, fmtPText, fmtSigned, plural } from '../util/format';
import { navigate } from '../util/hooks';
import { useProbabilityModel } from './useModel';

const DAY_MS = 86400000;

function rollingRounds(rounds: RoundRow[], window: number) {
  const means = rollingMean(rounds.map((r) => r.score), window, Math.min(3, window));
  return rounds.flatMap((r, i) => (means[i] === null ? [] : [{ t: r.t, v: means[i]! }]));
}

function TrendCell({ stat }: { stat: CountryStat }) {
  if (!stat.trend) return <span className="muted">–</span>;
  const clear = stat.trend.pAdjusted < 0.05;
  return (
    <span title={`95% interval ${fmtSigned(stat.trend.lo)} to ${fmtSigned(stat.trend.hi)} per year; adjusted ${fmtPText(stat.trend.pAdjusted)}`} style={{ fontWeight: clear ? 650 : 400 }} className={clear ? (stat.trend.perYear > 0 ? 'delta up' : 'delta down') : 'secondary'}>
      {clear ? (stat.trend.perYear > 0 ? '▲ ' : '▼ ') : ''}{fmtSigned(stat.trend.perYear)}
    </span>
  );
}

export function CountriesView({ country }: { country: string | null }) {
  const app = useApp();
  const focus = app.focus!;
  const geo = app.geo;
  const model = useProbabilityModel();
  const detailRef = useRef<HTMLDivElement | null>(null);

  const stats = useMemo(
    () => countryStats(focus.rounds, { threshold: app.settings.threshold, hasGuessCountries: !!geo }),
    [focus.rounds, app.settings.threshold, geo],
  );
  const selected = stats.find((s) => s.cc === country) ?? null;
  const maxMean = 5000;

  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected?.cc]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns: Column<CountryStat>[] = [
    { key: 'name', header: 'Country', sort: (s) => countryName(s.cc), render: (s) => <Place cc={s.cc} /> },
    { key: 'code', header: 'Code', csv: (s) => s.cc, render: () => null },
    { key: 'n', header: 'Rounds', align: 'right', sort: (s) => s.n, render: (s) => fmtInt(s.n) },
    {
      key: 'mean', header: 'Average score', align: 'right', sort: (s) => s.meanScore, csv: (s) => Math.round(s.meanScore),
      render: (s) => <><span className="cell-bar" style={{ width: `${(64 * s.meanScore) / maxMean}px` }} />{fmtInt(s.meanScore)}</>,
    },
    { key: 'median', header: 'Median score', csv: (s) => s.medianScore, render: () => null },
    { key: 'good', header: `Good rounds (${fmtInt(app.settings.threshold)}+)`, csvHeader: `Good rounds ${app.settings.threshold}+ (%)`, align: 'right', sort: (s) => s.goodRate, csv: (s) => +(100 * s.goodRate).toFixed(1), render: (s) => fmtPct(s.goodRate) },
    { key: 'hit', header: 'Right country', csvHeader: 'Right country (%)', align: 'right', title: 'Share of rounds where your guess landed in the right country', sort: (s) => s.hitRate, csv: (s) => (s.hitRate === null ? null : +(100 * s.hitRate).toFixed(1)), render: (s) => (s.hitRate === null ? '–' : fmtPct(s.hitRate)) },
    { key: 'dist', header: 'Average distance (km)', csv: (s) => (s.meanDistanceKm === null ? null : Math.round(s.meanDistanceKm)), render: () => null },
    { key: 'mix', header: 'Often guessed instead', csv: (s) => (s.mixedUpWith ? `${countryName(s.mixedUpWith.cc)} (${s.mixedUpWith.count})` : ''), sort: (s) => (s.mixedUpWith ? s.mixedUpWith.count : null), render: (s) => (s.mixedUpWith ? <span className="place"><Place cc={s.mixedUpWith.cc} /><span className="muted">×{s.mixedUpWith.count}</span></span> : <span className="muted">–</span>) },
    {
      key: 'edge', header: 'vs centre guess', align: 'right',
      title: 'Your average minus what always clicking the best single spot in the country would score (from Street View coverage)',
      csvHeader: 'Average minus hedge score',
      csv: (s) => { const base = geo?.countries.get(s.cc)?.base; return base == null ? null : Math.round(s.meanScore - base); },
      sort: (s) => { const base = geo?.countries.get(s.cc)?.base; return base == null ? null : s.meanScore - base; },
      render: (s) => { const base = geo?.countries.get(s.cc)?.base; return base == null ? <span className="muted">–</span> : fmtSigned(s.meanScore - base); },
    },
    { key: 'trend', header: 'Trend per year', align: 'right', sort: (s) => (s.trend ? s.trend.perYear : null), csv: (s) => (s.trend ? Math.round(s.trend.perYear) : null), render: (s) => <TrendCell stat={s} /> },
    { key: 'trendLo', header: 'Trend 95% low', csv: (s) => (s.trend ? Math.round(s.trend.lo) : null), render: () => null },
    { key: 'trendHi', header: 'Trend 95% high', csv: (s) => (s.trend ? Math.round(s.trend.hi) : null), render: () => null },
    { key: 'trendP', header: 'Trend p (adjusted)', csv: (s) => (s.trend ? +s.trend.pAdjusted.toPrecision(3) : null), render: () => null },
    { key: 'first', header: 'First round', csv: (s) => new Date(s.firstT).toISOString().slice(0, 10), render: () => null },
    { key: 'last', header: 'Last round', csv: (s) => new Date(s.lastT).toISOString().slice(0, 10), render: () => null },
  ];
  const csvOnly = new Set(['code', 'median', 'dist', 'trendLo', 'trendHi', 'trendP', 'first', 'last']);

  return (
    <>
      <div ref={detailRef} style={{ scrollMarginTop: 76 }}>
        {selected ? <CountryDetail stat={selected} model={model} /> : (
          <Card><p className="note">Pick a country in the table to see your scores there over time, its trend, and a region-by-region breakdown.</p></Card>
        )}
      </div>
      <Card title="All countries" subtitle={`${plural(stats.length, 'country', 'countries')} have come up in the selected period. Click a row for the detail; click a heading to sort.`}>
        {stats.length === 0 ? <Empty title="No rounds in this period" /> : (
          <DataTable
            rows={stats}
            columns={columns.filter((c) => !csvOnly.has(c.key))}
            rowKey={(s) => s.cc}
            initialSort={{ key: 'n', dir: 'desc' }}
            selectedKey={selected?.cc ?? null}
            onRowClick={(s) => navigate('countries', { country: s.cc })}
            exportTitle="All countries"
            exportColumns={columns}
            capped
            caption="Statistics by country"
          />
        )}
      </Card>
    </>
  );
}

function CountryDetail({ stat, model }: { stat: CountryStat; model: ReturnType<typeof useProbabilityModel> }) {
  const app = useApp();
  const focus = app.focus!;
  const geo = app.geo;
  const cc = stat.cc;
  const color = playerColor(focus.player);
  const rounds = useMemo(() => focus.rounds.filter((r) => r.cc === cc), [focus.rounds, cc]);
  const window = rounds.length >= 60 ? 10 : rounds.length >= 20 ? 5 : 3;

  const chart = useMemo(() => {
    const lines: LineSeries[] = [{ id: 'roll', label: `${focus.player.nick}: ${window}-round average`, color, points: rollingRounds(rounds, window) }];
    for (const s of app.compare) {
      const theirs = s.rounds.filter((r) => r.cc === cc);
      if (theirs.length >= 5) lines.push({ id: s.player.id, label: s.player.nick, color: playerColor(s.player), points: rollingRounds(theirs, window) });
    }
    const first = rounds[0]?.t ?? 0;
    const fit = fitTrend('linear', rounds.map((r) => ({ days: (r.t - first) / DAY_MS, value: r.score })));
    if (fit) lines.push({ id: 'trend', label: 'Trend', color: 'var(--ink-2)', dashed: true, width: 1.5, points: rounds.map((r, i) => ({ t: r.t, v: Math.max(0, Math.min(5000, fit.fitted[i])) })) });
    return { lines, fit };
  }, [rounds, app.compare, cc, color, focus.player.nick, window]);

  const legend: LegendItem[] = [
    { label: 'Each round', color, kind: 'dot' },
    ...chart.lines.map((l) => ({ label: l.label, color: l.color, kind: l.dashed ? 'dashed' as const : 'line' as const })),
    ...(chart.fit ? [{ label: '95% band of the trend', color: 'var(--ink-2)', kind: 'band' as const }] : []),
  ];

  const regions = useMemo(() => {
    if (!geo) return [];
    const by = new Map<number, RoundRow[]>();
    for (const r of rounds) if (r.region >= 0) by.set(r.region, [...(by.get(r.region) ?? []), r]);
    return [...by.entries()].map(([idx, list]) => ({
      idx,
      name: geo.regions[idx].name,
      n: list.length,
      mean: list.reduce((s, r) => s + r.score, 0) / list.length,
      best: Math.max(...list.map((r) => r.score)),
      estimate: model?.regions[idx] ?? null,
      coverage: geo.regions[idx].covPct,
    }));
  }, [geo, rounds, model]);
  type RegionRow = (typeof regions)[number];
  const regionColumns: Column<RegionRow>[] = [
    { key: 'name', header: 'Region', sort: (r) => r.name, render: (r) => r.name },
    { key: 'n', header: 'Rounds', align: 'right', sort: (r) => r.n, render: (r) => fmtInt(r.n) },
    { key: 'mean', header: 'Average score', align: 'right', sort: (r) => r.mean, render: (r) => <><span className="cell-bar" style={{ width: `${(64 * r.mean) / 5000}px` }} />{fmtInt(r.mean)}</> },
    { key: 'best', header: 'Best', align: 'right', sort: (r) => r.best, render: (r) => fmtInt(r.best) },
    {
      key: 'odds', header: 'Chance of a good round', align: 'right', title: 'Model estimate with its 80% interval',
      sort: (r) => r.estimate?.p ?? null,
      csvHeader: 'Chance of a good round (%)', csv: (r) => (r.estimate ? +(100 * r.estimate.p).toFixed(1) : null),
      render: (r) => (r.estimate ? <>{fmtPct(r.estimate.p)} <span className="muted">({fmtPct(r.estimate.lo)}–{fmtPct(r.estimate.hi)})</span></> : '–'),
    },
    { key: 'cov', header: 'Street View reach', csvHeader: 'Street View reach (%)', align: 'right', sort: (r) => r.coverage, render: (r) => `${r.coverage}%` },
  ];

  const info = geo?.countries.get(cc);
  const estimate = model?.countries.get(cc);
  const distance = stat.meanDistanceKm;

  return (
    <Card
      title={<Place cc={cc} />}
      subtitle={info && info.base !== null
        ? `Street View reaches about ${fmtPct(info.cov)} of the country. Knowing only the country and always clicking its best single spot would average ${fmtInt(info.base)} points; you average ${fmtInt(stat.meanScore)}.`
        : undefined}
      actions={<button type="button" className="btn small" onClick={() => navigate('countries')}>Close</button>}
    >
      <Tiles title={`${countryName(cc)} summary`}>
        <StatTile label="Rounds" value={fmtInt(stat.n)} note={`${fmtDate(stat.firstT)} – ${fmtDate(stat.lastT)}`} />
        <StatTile label="Average score" value={fmtInt(stat.meanScore)} note={`median ${fmtInt(stat.medianScore)}${distance !== null ? ` · ${fmtKm(distance)} off on average` : ''}`} />
        <StatTile label="Good rounds" value={fmtPct(stat.goodRate)} note={estimate ? `model: ${fmtPct(estimate.p)} (${fmtPct(estimate.lo)}–${fmtPct(estimate.hi)})` : `${fmtInt(app.settings.threshold)}+ points`} />
        <StatTile label="Right country" value={stat.hitRate === null ? '–' : fmtPct(stat.hitRate)} note={stat.mixedUpWith ? `often ${countryName(stat.mixedUpWith.cc)} instead` : undefined} />
        <StatTile
          label="Trend per year"
          value={stat.trend ? fmtSigned(stat.trend.perYear) : '–'}
          note={stat.trend ? `${fmtSigned(stat.trend.lo)} to ${fmtSigned(stat.trend.hi)} · ${fmtPText(stat.trend.pAdjusted)}` : 'needs more rounds'}
        />
      </Tiles>
      <ChartBlock
        title={`${countryName(cc)}: round scores over time`}
        subtitle={`Every round in ${countryName(cc)} (out of 5,000), with a ${window}-round average${chart.fit ? ' and a linear trend' : ''}.`}
        legend={legend}
        table={{
          columns: ['Date', 'Round', 'Region', 'Location lat', 'Location lng', 'Score', 'Distance (km)', 'Guessed country'],
          rows: [...rounds].reverse().map((r) => [r.date, r.round + 1, geo && r.region >= 0 ? geo.regions[r.region].name : '', r.lat, r.lng, r.score, r.distance !== null ? +(r.distance / 1000).toFixed(1) : '', r.guessCc ?? '']),
        }}
      >
        <TimeChart
          ariaLabel={`Round scores in ${countryName(cc)} over time`}
          dots={[{ id: 'rounds', label: 'Round score', color, points: rounds.map((r) => ({ t: r.t, v: r.score })) }]}
          lines={chart.lines}
          band={chart.fit ? { label: 'Trend band', color: 'var(--ink-2)', points: rounds.map((r, i) => ({ t: r.t, lo: Math.max(0, chart.fit!.lo[i]), hi: Math.min(5000, chart.fit!.hi[i]) })) } : undefined}
          yDomain={[0, 5000]}
          yFormat={fmtInt}
          height={300}
        />
      </ChartBlock>
      {regions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="card-title" style={{ fontSize: 15, marginBottom: 8 }}>By region</h3>
          <DataTable rows={regions} columns={regionColumns} rowKey={(r) => String(r.idx)} initialSort={{ key: 'n', dir: 'desc' }} capped caption={`Regions of ${countryName(cc)}`} exportTitle={`${countryName(cc)} by region`} />
        </div>
      )}
    </Card>
  );
}
