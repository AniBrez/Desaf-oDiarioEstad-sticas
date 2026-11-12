import { useCallback, useMemo, useState } from 'react';
import { BarList } from '../charts/Charts';
import { TooltipRow } from '../charts/TimeChart';
import { Card, DataTable, Empty, niceClassScale, Place, ScaleLegend, Segmented, type ClassScale, type Column } from '../components/ui';
import { useApp } from '../data/store';
import { countryName } from '../geo/geo';
import { WorldMap, type MapTarget } from '../map/WorldMap';
import type { Estimate } from '../stats/probability';
import { fmtInt, fmtKm, fmtPct, plural } from '../util/format';
import { navigate } from '../util/hooks';
import { useProbabilityModel } from './useModel';

type Metric = 'chance' | 'score';
type Level = 'region' | 'country';
type Paint = 'coverage' | 'regions';
const COLOR_VARS = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];

function quantile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
}

function domainFor(values: number[], metric: Metric): ClassScale {
  const sorted = [...values].sort((a, b) => a - b);
  // The scale spans what this player's map actually contains (ignoring the outer 2% each side),
  // on round boundaries, so the colours spread over the range that matters.
  const lo = quantile(sorted, 0.02), hi = quantile(sorted, 0.98);
  return metric === 'chance'
    ? niceClassScale(lo, hi, [0.05, 0.1, 0.15, 0.2], [0, 1], 5)
    : niceClassScale(lo, hi, [250, 500, 750, 1000], [0, 5000], 5);
}

const frequency = (share: number): string => (share > 0 ? `about 1 round in ${fmtInt(Math.max(1, Math.round(1 / share)))}` : 'almost never');

export function OddsMapView() {
  const app = useApp();
  const geo = app.geo;
  const focus = app.focus!;
  const model = useProbabilityModel();
  const [metric, setMetric] = useState<Metric>('chance');
  const [level, setLevel] = useState<Level>('region');
  const [paint, setPaint] = useState<Paint>('coverage');
  const [showTable, setShowTable] = useState(false);
  const threshold = app.settings.threshold;

  const estimateFor = useCallback((regionIdx: number, at: Level): Estimate | null => {
    if (!model || !geo) return null;
    return at === 'region' ? model.regions[regionIdx] : model.countries.get(geo.regions[regionIdx].cc) ?? null;
  }, [model, geo]);

  const painted = useMemo(() => {
    if (!model || !geo) return null;
    const value = (e: Estimate) => (metric === 'chance' ? e.p : e.expected);
    const values: number[] = [];
    for (let i = 0; i < geo.regions.length; i++) {
      const e = estimateFor(i, level);
      if (e && (geo.regions[i].cells > 0 || e.n > 0)) values.push(value(e));
    }
    const scale = domainFor(values, metric);
    const classes = new Int8Array(geo.regions.length).fill(-1);
    for (let i = 0; i < geo.regions.length; i++) {
      const e = estimateFor(i, level);
      // Regions Street View never reaches stay plain, even inside a coloured country.
      if (e && (geo.regions[i].cells > 0 || (level === 'region' && e.n > 0))) classes[i] = scale.classOf(value(e));
    }
    return { scale, classes, colorVars: scale.colors.map((i) => COLOR_VARS[i]) };
  }, [model, geo, metric, level, estimateFor]);

  const tooltip = useCallback((target: MapTarget) => {
    if (!geo || !model) return null;
    const region = geo.regions[target.regionIdx];
    const country = geo.countries.get(target.cc)!;
    const e = estimateFor(target.regionIdx, target.kind);
    const countryEstimate = model.countries.get(target.cc) ?? null;
    const title = target.kind === 'region' ? region.name : country.name;
    const covered = target.kind === 'region' ? region.cells > 0 : country.cells > 0;
    if (!e || (!covered && e.n === 0)) {
      return (
        <>
          <div className="tooltip-title">{title}</div>
          {target.kind === 'region' && <div className="tooltip-sub"><Place cc={target.cc} name={country.name} /></div>}
          <div className="secondary">No Street View here, so it cannot come up.</div>
        </>
      );
    }
    return (
      <>
        <div className="tooltip-title">{title}</div>
        {target.kind === 'region' && <div className="tooltip-sub"><Place cc={target.cc} name={country.name} /></div>}
        <div className="tooltip-big">{metric === 'chance' ? fmtPct(e.p) : fmtInt(e.expected)}</div>
        <div className="tooltip-sub">
          {metric === 'chance' ? `chance of ${fmtInt(threshold)}+ points · likely ${fmtPct(e.lo)}–${fmtPct(e.hi)}` : `expected round score · ${fmtPct(e.p)} chance of ${fmtInt(threshold)}+`}
        </div>
        <TooltipRow label="Your rounds here" value={e.n > 0 ? `${fmtInt(e.n)} (${fmtInt(e.good)} good)` : 'none yet'} />
        {e.meanScore !== null && <TooltipRow label="Your average here" value={fmtInt(e.meanScore)} />}
        {target.kind === 'region' && countryEstimate && countryEstimate.n > e.n && (
          <TooltipRow label={`Rest of ${country.name}`} value={`${fmtInt(countryEstimate.n - e.n)} rounds, ${fmtPct((countryEstimate.good - e.good) / (countryEstimate.n - e.n))} good`} />
        )}
        <hr className="tooltip-rule" />
        <TooltipRow label="Street View reach" value={target.kind === 'region' ? `${region.covPct}% of the area` : `${fmtPct(country.cov)} of the area`} />
        <TooltipRow label="Comes up" value={frequency(e.share)} />
        {e.n === 0 && <div className="tooltip-sub" style={{ margin: '6px 0 0' }}>Estimated from {countryEstimate && countryEstimate.n > 0 ? `your rounds elsewhere in ${country.name} and ` : ''}how the coverage is spread.</div>}
      </>
    );
  }, [geo, model, estimateFor, metric, threshold]);

  const lists = useMemo(() => {
    if (!model) return null;
    const known = [...model.countries.entries()].filter(([, e]) => e.n >= 5).map(([cc, e]) => ({ cc, e }));
    const value = (e: Estimate) => (metric === 'chance' ? e.p : e.expected);
    known.sort((a, b) => value(b.e) - value(a.e));
    const row = ({ cc, e }: { cc: string; e: Estimate }) => ({ key: cc, label: <Place cc={cc} />, value: value(e), note: `${e.n} rounds` });
    return { best: known.slice(0, 8).map(row), worst: known.slice(-8).reverse().map(row), count: known.length };
  }, [model, metric]);

  interface Row { key: string; name: string; cc: string; e: Estimate; coverage: string }
  const rows = useMemo<Row[]>(() => {
    if (!model || !geo || !showTable) return [];
    if (level === 'country') {
      return [...model.countries.entries()].map(([cc, e]) => ({ key: cc, name: countryName(cc), cc, e, coverage: fmtPct(geo.countries.get(cc)?.cov ?? 0) }));
    }
    return geo.regions.flatMap((r, i) => {
      const e = model.regions[i];
      return e && e.n > 0 ? [{ key: r.id, name: r.name, cc: r.cc, e, coverage: `${r.covPct}%` }] : [];
    });
  }, [model, geo, level, showTable]);
  const columns: Column<Row>[] = [
    { key: 'name', header: level === 'region' ? 'Region' : 'Country', sort: (r) => r.name, render: (r) => (level === 'region' ? r.name : <Place cc={r.cc} />) },
    ...(level === 'region' ? [{ key: 'cc', header: 'Country', sort: (r: Row) => countryName(r.cc), render: (r: Row) => <Place cc={r.cc} /> }] : []),
    { key: 'n', header: 'Rounds', align: 'right', sort: (r) => r.e.n, render: (r) => fmtInt(r.e.n) },
    { key: 'good', header: 'Good', align: 'right', sort: (r) => r.e.good, render: (r) => fmtInt(r.e.good) },
    { key: 'p', header: 'Chance of a good round', align: 'right', sort: (r) => r.e.p, render: (r) => fmtPct(r.e.p) },
    { key: 'ci', header: 'Likely range', align: 'right', render: (r) => `${fmtPct(r.e.lo)}–${fmtPct(r.e.hi)}` },
    { key: 'exp', header: 'Expected score', align: 'right', sort: (r) => r.e.expected, render: (r) => fmtInt(r.e.expected) },
    { key: 'cov', header: 'Street View reach', align: 'right', render: (r) => r.coverage },
    { key: 'share', header: 'Share of rounds', align: 'right', sort: (r) => r.e.share, render: (r) => fmtPct(r.e.share, 2) },
  ];

  if (!geo || !model || !painted) return <Card><Empty title={app.geoError ? 'The map data could not be loaded' : 'Loading map data…'} /></Card>;
  const format = metric === 'chance' ? (v: number) => fmtPct(v) : (v: number) => fmtInt(v);

  return (
    <>
      <Card
        title="Where are you likely to do well?"
        subtitle={`Estimated for ${focus.player.nick} from ${plural(model.overall.n, 'round')}${model.overall.n ? ` (${fmtPct(model.overall.rate)} good overall)` : ''}, combined with where Street View actually goes. Hover or tap a place.`}
      >
        <div className="row" style={{ marginBottom: 12, gap: '10px 18px' }}>
          <Segmented<Metric> label="What to show" value={metric} onChange={setMetric} options={[{ value: 'chance', label: 'Chance of a good round' }, { value: 'score', label: 'Expected score' }]} />
          <Segmented<Level> label="Detail" value={level} onChange={setLevel} options={[{ value: 'region', label: 'Regions' }, { value: 'country', label: 'Countries' }]} />
          <label className="filter" style={{ gap: 10 }}>
            <span className="filter-label">A good round is</span>
            <input className="range" type="range" min={2500} max={4900} step={100} value={threshold} onChange={(e) => app.setThreshold(Number(e.target.value))} aria-label="Score that counts as a good round" />
            <span className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtInt(threshold)}+ <span className="muted" style={{ fontWeight: 400 }}>(within {fmtKm(model.thresholdKm)})</span></span>
          </label>
          <div className="filter">
            <span className="filter-label">Colour</span>
            <Segmented<Paint> label="Where to colour" value={paint} onChange={setPaint} options={[{ value: 'coverage', label: 'Where Street View exists' }, { value: 'regions', label: 'Whole regions' }]} />
          </div>
        </div>
        <WorldMap
          geo={geo}
          level={level}
          classes={painted.classes}
          colorVars={painted.colorVars}
          paint={paint}
          tooltip={tooltip}
          onPick={(t) => navigate('countries', { country: t.cc })}
          ariaLabel={metric === 'chance' ? `Map of the chance of scoring ${threshold} or more by ${level}` : `Map of expected round score by ${level}`}
        />
        <ScaleLegend
          scale={painted.scale}
          format={format}
          title={metric === 'chance' ? `Chance of ${fmtInt(threshold)}+ points` : 'Expected round score'}
          extras={[{ label: 'No Street View', color: 'var(--map-land)' }]}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn quiet small" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>{showTable ? 'Hide table' : 'Show as table'}</button>
        </div>
        {showTable && (
          <div style={{ marginTop: 8 }}>
            <DataTable rows={rows} columns={columns} rowKey={(r) => r.key} initialSort={{ key: 'n', dir: 'desc' }} capped caption="Estimates by place" />
            {level === 'region' && <p className="note" style={{ marginTop: 8 }}>The table lists regions you have had rounds in. Every other region with Street View is estimated too: hover it on the map.</p>}
          </div>
        )}
        <details className="explain">
          <summary>How these numbers are worked out</summary>
          <p>
            You meet most regions only a few times, so a raw success rate per region would be mostly noise. The estimate therefore builds up in three layers,
            each one adjusting the one before:
          </p>
          <ul>
            <li>
              <strong>Coverage.</strong> For every region, the public Street View coverage data tells how far its covered roads lie from the best single guess for its country.
              A region near that point can be scored well by knowing only the country; a far-flung one cannot. How much this matters for <em>you</em> is learnt from your own rounds
              (weight {model.weights.geometry.toFixed(2)}), along with how much better you do in countries that come up often (weight {model.weights.familiarity.toFixed(2)}).
              {model.weights.usedRounds === 0 && ' With fewer than 40 located rounds these weights stay at zero and every place starts from your overall rate.'}
            </li>
            <li><strong>The country.</strong> Your record in the rest of the country shifts all of its regions up or down. The starting estimate counts for about {model.strength.country} rounds of evidence.</li>
            <li><strong>The region itself.</strong> Your own rounds there take over as they accumulate; the starting estimate counts for about {model.strength.region} rounds.</li>
          </ul>
          <p>
            "Likely" ranges are 80% credible intervals: wide where you have few rounds, narrow where you have many. How often a place comes up is estimated from every challenge
            in your data, smoothed towards the coverage footprint. Coverage is measured on a 0.25° grid (about 25 km): a cell counts as covered when it contains any Street View location.
          </p>
        </details>
      </Card>

      {lists && lists.count >= 4 && (
        <div className="grid two">
          <Card title="Your best bets" subtitle="Countries with at least five rounds, highest estimate first.">
            <BarList rows={lists.best} max={metric === 'chance' ? 1 : 5000} format={format} onPick={(cc) => navigate('countries', { country: cc })} />
          </Card>
          <Card title="Your toughest" subtitle="Where a round is least likely to go well.">
            <BarList rows={lists.worst} max={metric === 'chance' ? 1 : 5000} format={format} onPick={(cc) => navigate('countries', { country: cc })} />
          </Card>
        </div>
      )}
    </>
  );
}
