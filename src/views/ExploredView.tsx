import { useCallback, useMemo, useState } from 'react';
import { ChartBlock, TimeChart, TooltipRow, type LineSeries } from '../charts/TimeChart';
import { Card, DataTable, Dot, Empty, Place, Segmented, StatTile, type Column } from '../components/ui';
import { playerColor, useApp } from '../data/store';
import { WorldMap, type MapTarget } from '../map/WorldMap';
import { countryName } from '../geo/geo';
import { explore } from '../stats/explore';
import { fmtDate, fmtInt, fmtPct, plural } from '../util/format';
import { navigate } from '../util/hooks';

type Level = 'region' | 'country';
type Paint = 'coverage' | 'regions';
/** Class 0 is "reachable but never seen"; then visit-count bands. */
const BANDS = [
  { label: 'Not yet', min: 0, colorVar: '--seq-1' },
  { label: '1', min: 1, colorVar: '--seq-3' },
  { label: '2–3', min: 2, colorVar: '--seq-4' },
  { label: '4–7', min: 4, colorVar: '--seq-5' },
  { label: '8–15', min: 8, colorVar: '--seq-6' },
  { label: '16+', min: 16, colorVar: '--seq-7' },
];
const COLOR_VARS = BANDS.map((b) => b.colorVar);
const bandOf = (count: number): number => {
  let band = 0;
  for (let i = 0; i < BANDS.length; i++) if (count >= BANDS[i].min) band = i;
  return band;
};

export function ExploredView() {
  const app = useApp();
  const geo = app.geo;
  const focus = app.focus!;
  const [level, setLevel] = useState<Level>('region');
  const [dots, setDots] = useState(true);
  const [paint, setPaint] = useState<Paint>('coverage');
  const [showTable, setShowTable] = useState(false);

  const pooledCountries = useMemo(() => new Set(app.pooledRounds.map((r) => r.cc).filter((cc): cc is string => !!cc)), [app.pooledRounds]);
  const result = useMemo(() => (geo ? explore(focus.rounds, geo, pooledCountries) : null), [geo, focus.rounds, pooledCountries]);
  const others = useMemo(
    () => (geo ? app.compare.map((s) => ({ s, e: explore(s.rounds, geo, pooledCountries) })) : []),
    [geo, app.compare, pooledCountries],
  );

  const classes = useMemo(() => {
    if (!geo || !result) return null;
    const out = new Int8Array(geo.regions.length).fill(-1);
    for (const r of geo.regions) {
      const count = level === 'region' ? result.regions.get(r.idx) ?? 0 : result.countries.get(r.cc) ?? 0;
      if (count > 0) out[r.idx] = bandOf(count);
      else if (r.cells > 0) out[r.idx] = 0;
    }
    return out;
  }, [geo, result, level]);

  const lastSeen = useMemo(() => {
    const byRegion = new Map<number, number>(), byCountry = new Map<string, number>();
    for (const r of focus.rounds) {
      if (r.region >= 0) byRegion.set(r.region, Math.max(byRegion.get(r.region) ?? 0, r.t));
      if (r.cc) byCountry.set(r.cc, Math.max(byCountry.get(r.cc) ?? 0, r.t));
    }
    return { byRegion, byCountry };
  }, [focus.rounds]);

  const tooltip = useCallback((target: MapTarget) => {
    if (!geo || !result) return null;
    const region = geo.regions[target.regionIdx];
    const country = geo.countries.get(target.cc)!;
    if (target.kind === 'region') {
      const count = result.regions.get(region.idx) ?? 0;
      return (
        <>
          <div className="tooltip-title">{region.name}</div>
          <div className="tooltip-sub"><Place cc={target.cc} name={country.name} /></div>
          {region.cells === 0 && count === 0
            ? <div className="secondary">No Street View here.</div>
            : (
              <>
                <TooltipRow label="Dropped here" value={count ? plural(count, 'time') : 'not yet'} />
                {count > 0 && <TooltipRow label="Last time" value={fmtDate(lastSeen.byRegion.get(region.idx)!)} />}
                <TooltipRow label="Street View reach" value={`${region.covPct}% of the area`} />
              </>
            )}
        </>
      );
    }
    const count = result.countries.get(target.cc) ?? 0;
    const reachable = country.regions.filter((i) => geo.regions[i].cells > 0 || result.regions.has(i));
    const seen = reachable.filter((i) => result.regions.has(i)).length;
    return (
      <>
        <div className="tooltip-title"><Place cc={target.cc} name={country.name} /></div>
        {country.cells === 0 && count === 0
          ? <div className="secondary">No Street View here.</div>
          : (
            <>
              <TooltipRow label="Dropped here" value={count ? plural(count, 'time') : 'not yet'} />
              {count > 0 && <TooltipRow label="Last time" value={fmtDate(lastSeen.byCountry.get(target.cc)!)} />}
              <TooltipRow label="Regions seen" value={`${seen} of ${reachable.length}`} />
              <TooltipRow label="Street View reach" value={`${fmtPct(country.cov)} of the area`} />
            </>
          )}
      </>
    );
  }, [geo, result, lastSeen]);

  interface Row { cc: string; count: number; seen: number; reachable: number; last: number }
  const rows = useMemo<Row[]>(() => {
    if (!geo || !result || !showTable) return [];
    return [...result.countries.entries()].map(([cc, count]) => {
      const regions = geo.countries.get(cc)?.regions ?? [];
      const reachable = regions.filter((i) => geo.regions[i].cells > 0 || result.regions.has(i));
      return { cc, count, seen: reachable.filter((i) => result.regions.has(i)).length, reachable: reachable.length, last: lastSeen.byCountry.get(cc) ?? 0 };
    });
  }, [geo, result, showTable, lastSeen]);
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Country', sort: (r) => countryName(r.cc), render: (r) => <Place cc={r.cc} /> },
    { key: 'count', header: 'Times dropped here', align: 'right', sort: (r) => r.count, render: (r) => fmtInt(r.count) },
    { key: 'regions', header: 'Regions seen', align: 'right', sort: (r) => (r.reachable ? r.seen / r.reachable : null), render: (r) => `${r.seen} of ${r.reachable}` },
    { key: 'last', header: 'Last time', align: 'right', sort: (r) => r.last, render: (r) => fmtDate(r.last) },
  ];

  if (!geo || !result || !classes) return <Card><Empty title={app.geoError ? 'The map data could not be loaded' : 'Loading map data…'} /></Card>;

  const { totals } = result;
  const share = { countries: result.countries.size / totals.countries, regions: result.regions.size / totals.regions, cells: result.cells.size / totals.cells };
  const lines: LineSeries[] = [
    { id: 'countries', label: 'Countries', color: 'var(--series-1)', points: result.timeline.map((p) => ({ t: p.t, v: (100 * p.countries) / totals.countries })) },
    { id: 'regions', label: 'Regions', color: 'var(--series-2)', points: result.timeline.map((p) => ({ t: p.t, v: (100 * p.regions) / totals.regions })) },
    { id: 'cells', label: '100 km squares', color: 'var(--series-3)', points: result.timeline.map((p) => ({ t: p.t, v: (100 * p.cells) / totals.cells })) },
  ];

  return (
    <>
      <div className="tiles">
        <StatTile label="Countries and territories" value={`${fmtInt(result.countries.size)} of ${fmtInt(totals.countries)}`} meter={share.countries} note={`${fmtPct(share.countries)} of those with Street View`} />
        <StatTile label="Regions" value={`${fmtInt(result.regions.size)} of ${fmtInt(totals.regions)}`} meter={share.regions} note={`${fmtPct(share.regions)} of states, provinces and the like`} />
        <StatTile label="100 km squares" value={`${fmtInt(result.cells.size)} of ${fmtInt(totals.cells)}`} meter={share.cells} note={`${fmtPct(share.cells, 1)} of the covered world`} />
        <StatTile label="Locations seen" value={fmtInt(focus.rounds.length)} note={`in ${plural(focus.days.length, 'game')}`} />
      </div>

      <Card
        title="The world you have been dropped in"
        subtitle={`Every Daily Challenge round of ${focus.player.nick}. Darker places have come up more often; the palest blue is still waiting.`}
      >
        <div className="row" style={{ marginBottom: 12, gap: '10px 18px' }}>
          <Segmented<Level> label="Detail" value={level} onChange={setLevel} options={[{ value: 'region', label: 'Regions' }, { value: 'country', label: 'Countries' }]} />
          <label className="switch"><input type="checkbox" checked={dots} onChange={(e) => setDots(e.target.checked)} />Show every location</label>
          <div className="filter">
            <span className="filter-label">Colour</span>
            <Segmented<Paint> label="Where to colour" value={paint} onChange={setPaint} options={[{ value: 'coverage', label: 'Where Street View exists' }, { value: 'regions', label: 'Whole regions' }]} />
          </div>
        </div>
        <WorldMap
          geo={geo}
          level={level}
          classes={classes}
          colorVars={COLOR_VARS}
          points={dots ? focus.rounds : undefined}
          paint={paint}
          tooltip={tooltip}
          onPick={(t) => { if (result.countries.has(t.cc)) navigate('countries', { country: t.cc }); }}
          ariaLabel={`Map of ${level === 'region' ? 'regions' : 'countries'} by how often they have come up`}
        />
        <div className="scale-legend">
          <span>Times dropped here</span>
          {BANDS.map((b) => <span className="swatch" key={b.label}><i style={{ background: `var(${b.colorVar})` }} />{b.label}</span>)}
          <span className="swatch"><i style={{ background: 'var(--map-land)' }} />No Street View</span>
          {dots && <span className="swatch"><Dot color="var(--map-point)" />A round</span>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn quiet small" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>{showTable ? 'Hide table' : 'Show as table'}</button>
        </div>
        {showTable && (
          <div style={{ marginTop: 8 }}>
            <DataTable rows={rows} columns={columns} rowKey={(r) => r.cc} initialSort={{ key: 'count', dir: 'desc' }} onRowClick={(r) => navigate('countries', { country: r.cc })} capped caption="Countries you have been dropped in" />
          </div>
        )}
      </Card>

      <div className="grid side">
        <Card title="Discovery over time" subtitle="Share of what Street View covers that you have seen so far, at three levels of detail.">
          <ChartBlock
            legend={lines.map((l) => ({ label: l.label, color: l.color }))}
            table={{
              columns: ['Date', 'Countries', 'Regions', '100 km squares'],
              rows: [...result.timeline].reverse().map((p) => [fmtDate(p.t), p.countries, p.regions, p.cells]),
            }}
          >
            <TimeChart
              ariaLabel="Share of countries, regions and 100 km squares discovered over time"
              lines={lines}
              yDomain={[0, Math.min(100, Math.ceil((Math.max(share.countries, 0.1) * 100 + 5) / 10) * 10)]}
              yFormat={(v) => `${v}%`}
              valueFormat={(v) => `${v.toFixed(1)}%`}
              endLabels
              height={280}
            />
          </ChartBlock>
        </Card>
        <Card title="Still to discover" subtitle={result.unseen.length ? `${plural(result.unseen.length, 'country', 'countries')} with Street View have never come up, largest coverage first.` : undefined}>
          {result.unseen.length === 0 ? <p className="note">You have been dropped in every country and territory Street View covers.</p> : (
            <div className="chips">
              {result.unseen.slice(0, 40).map((u) => <span key={u.cc} className="chip static"><Place cc={u.cc} /></span>)}
              {result.unseen.length > 40 && <span className="muted">and {result.unseen.length - 40} more</span>}
            </div>
          )}
        </Card>
      </div>

      {others.length > 0 && (
        <Card title="Who has seen more?" subtitle="The same counts for everyone you are comparing with.">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Player</th><th scope="col" className="r">Games</th><th scope="col" className="r">Countries</th><th scope="col" className="r">Regions</th><th scope="col" className="r">100 km squares</th></tr></thead>
              <tbody>
                {[{ s: focus, e: result }, ...others].map(({ s, e }) => (
                  <tr key={s.player.id}>
                    <td><span className="place"><Dot color={playerColor(s.player)} />{s.player.nick}</span></td>
                    <td className="r num">{fmtInt(s.days.length)}</td>
                    <td className="r num">{fmtInt(e.countries.size)} <span className="muted">({fmtPct(e.countries.size / e.totals.countries)})</span></td>
                    <td className="r num">{fmtInt(e.regions.size)} <span className="muted">({fmtPct(e.regions.size / e.totals.regions)})</span></td>
                    <td className="r num">{fmtInt(e.cells.size)} <span className="muted">({fmtPct(e.cells.size / e.totals.cells, 1)})</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
