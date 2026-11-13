import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TooltipRow } from '../charts/TimeChart';
import { Card, DataTable, Dot, Empty, Place, ScaleLegend, Segmented, StatTile, niceClassScale, pdfScale, type Column } from '../components/ui';
import { useApp } from '../data/store';
import { ExportButtons, ExportMenu, Tiles } from '../export/ExportKit';
import type { PdfLegendItem } from '../export/pdf';
import { countryName } from '../geo/geo';
import { decimalLatLng, formatLatLng, loadHedges, mapsLink, type CountryHedge, type Hedges } from '../geo/hedges';
import { mercatorX, mercatorY } from '../geo/mercator';
import { WorldMap, type MapMarker, type MapTarget, type WorldMapHandle } from '../map/WorldMap';
import { compass, roundScore } from '../stats/hedge';
import { fmtInt, fmtKm, fmtPct, fmtSigned } from '../util/format';
import { navigate, useRoute } from '../util/hooks';

type Mode = 'solo' | 'team';
type Shade = 'coverage' | 'score' | 'gain';

const PIN_A = '--series-1';
const PIN_B = '--series-2';
const SEQ_VARS = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6', '--seq-7'];
/** Score bands around a solo pin, for the selected country. */
const BANDS = [
  { min: 4500, label: '4,500+', colorVar: '--seq-7' },
  { min: 4000, label: '4,000–4,500', colorVar: '--seq-5' },
  { min: 3000, label: '3,000–4,000', colorVar: '--seq-4' },
  { min: 2000, label: '2,000–3,000', colorVar: '--seq-3' },
  { min: 0, label: 'under 2,000', colorVar: '--seq-2' },
];

function cellCentre(hedges: Hedges, cell: number): { lat: number; lng: number } {
  const row = Math.floor(cell / hedges.gridCols), col = cell % hedges.gridCols;
  return { lat: -90 + (row + 0.5) * hedges.cellDeg, lng: -180 + (col + 0.5) * hedges.cellDeg };
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Where the map should look for a country: the middle 96% of its coverage. */
function focusBox(hedges: Hedges, h: CountryHedge): [number, number, number, number] {
  const xs = h.cells.map((c) => mercatorX(cellCentre(hedges, c).lng)).sort((a, b) => a - b);
  const ys = h.cells.map((c) => mercatorY(cellCentre(hedges, c).lat)).sort((a, b) => a - b);
  const q = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const pad = 0.004;
  return [q(xs, 0.02) - pad, q(ys, 0.02) - pad, q(xs, 0.98) + pad, q(ys, 0.98) + pad];
}

function PinLine({ label, colorVar, pin, note }: { label: string; colorVar: string; pin: { lat: number; lng: number }; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(decimalLatLng(pin));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the coordinates are on screen anyway */ }
  };
  return (
    <div className="pin-line">
      <span className="pin-badge" style={{ background: `var(${colorVar})` }} aria-hidden="true">{label}</span>
      <div style={{ minWidth: 0 }}>
        <div className="num" style={{ fontWeight: 650 }}>{formatLatLng(pin)}</div>
        {note && <div className="muted" style={{ fontSize: 13 }}>{note}</div>}
      </div>
      <span className="row" style={{ gap: 4, marginLeft: 'auto' }}>
        <button type="button" className="btn quiet small" onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <a className="btn quiet small" href={mapsLink(pin)} target="_blank" rel="noreferrer">Google Maps ↗</a>
      </span>
    </div>
  );
}

export function DuelsView() {
  const { geo, geoError } = useApp();
  const route = useRoute();
  const [hedges, setHedges] = useState<Hedges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('team');
  const [shade, setShade] = useState<Shade>('coverage');
  const mapHandle = useRef<WorldMapHandle | null>(null);
  const selectedCc = route.params.get('country');

  useEffect(() => {
    let cancelled = false;
    loadHedges().then((h) => { if (!cancelled) setHedges(h); }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'The hedge data could not be loaded.'); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (mode === 'solo' && shade === 'gain') setShade('score'); }, [mode, shade]);

  const select = useCallback((cc: string | null) => navigate('duels', cc ? { country: cc } : {}), []);
  const selected = selectedCc && hedges ? hedges.countries.get(selectedCc) ?? null : null;

  // ---- Map layers ---------------------------------------------------------------------------
  const valueOf = useCallback((h: CountryHedge): number => (
    shade === 'gain' ? h.team.expected - h.solo.expected : mode === 'team' ? h.team.expected : h.solo.expected
  ), [shade, mode]);

  const painted = useMemo(() => {
    if (!geo || !hedges) return null;
    const classes = new Int8Array(geo.regions.length).fill(-1);
    if (shade === 'coverage') {
      for (const r of geo.regions) if (r.cells > 0) classes[r.idx] = 0;
      return { classes, colorVars: ['--duel-coverage'], scale: null };
    }
    const values = [...hedges.countries.values()].map(valueOf).sort((a, b) => a - b);
    const lo = values[Math.floor(values.length * 0.03)], hi = values[Math.floor(values.length * 0.97)];
    const scale = shade === 'gain'
      ? niceClassScale(lo, hi, [50, 100, 150, 200], [0, 2500], 4)
      : niceClassScale(lo, hi, [250, 500, 750, 1000], [0, 5000], 4);
    for (const r of geo.regions) {
      const h = hedges.countries.get(r.cc);
      if (h && r.cells > 0) classes[r.idx] = scale.classOf(valueOf(h));
    }
    return { classes, colorVars: scale.colors.map((c) => SEQ_VARS[c]), scale };
  }, [geo, hedges, shade, valueOf]);

  const markers = useMemo<MapMarker[]>(() => {
    if (!hedges) return [];
    const out: MapMarker[] = [];
    for (const h of hedges.countries.values()) {
      if (mode === 'solo') out.push({ key: `${h.cc}:solo`, cc: h.cc, ...h.solo.pin, colorVar: PIN_A });
      else {
        out.push({ key: `${h.cc}:A`, cc: h.cc, ...h.team.pins[0], colorVar: PIN_A, label: 'A' });
        out.push({ key: `${h.cc}:B`, cc: h.cc, ...h.team.pins[1], colorVar: PIN_B, label: 'B' });
      }
    }
    return out;
  }, [hedges, mode]);

  const overlay = useMemo(() => {
    if (!hedges || !selected) return null;
    if (mode === 'team') {
      const [a, b] = selected.team.pins;
      return {
        cells: selected.cells,
        classes: selected.cells.map((c) => { const p = cellCentre(hedges, c); return haversine(p, a) <= haversine(p, b) ? 0 : 1; }),
        colorVars: ['--pin-a-area', '--pin-b-area'],
      };
    }
    return {
      cells: selected.cells,
      classes: selected.cells.map((c) => {
        const s = roundScore(haversine(cellCentre(hedges, c), selected.solo.pin), hedges.scoreScaleKm);
        return BANDS.findIndex((band) => s >= band.min);
      }),
      colorVars: BANDS.map((b) => b.colorVar),
    };
  }, [hedges, selected, mode]);

  const focus = useMemo(() => (hedges && selected ? { key: `${selected.cc}`, bbox: focusBox(hedges, selected) } : { key: 'world', bbox: [0, mercatorY(81.5), 1, mercatorY(-57.5)] as [number, number, number, number] }), [hedges, selected]);

  // ---- Tooltip ------------------------------------------------------------------------------
  const tooltip = useCallback((target: MapTarget) => {
    if (!hedges) return null;
    const h = hedges.countries.get(target.cc);
    const name = countryName(target.cc, geo?.countries.get(target.cc)?.name);
    if (!h) {
      return <><div className="tooltip-title"><Place cc={target.cc} name={name} /></div><div className="secondary">No Street View here, so it never comes up.</div></>;
    }
    const which = target.marker?.endsWith(':A') ? 'A' : target.marker?.endsWith(':B') ? 'B' : null;
    if (mode === 'solo') {
      return (
        <>
          <div className="tooltip-title"><Place cc={target.cc} name={name} /></div>
          <div className="tooltip-sub">Solo hedge {formatLatLng(h.solo.pin)}</div>
          <div className="tooltip-big">{fmtInt(h.solo.expected)}</div>
          <div className="tooltip-sub">expected round score when guessing there</div>
          <TooltipRow label="Typical miss" value={fmtKm(h.solo.miss[0])} />
          <TooltipRow label="9 rounds in 10 within" value={fmtKm(h.solo.miss[1])} />
          <div className="tooltip-sub" style={{ margin: '6px 0 0' }}>Click for the details and to see how the score drops across the country.</div>
        </>
      );
    }
    const [a, b] = h.team.pins;
    return (
      <>
        <div className="tooltip-title"><Place cc={target.cc} name={name} /></div>
        {which && <div className="tooltip-sub">Pin {which}: {formatLatLng(which === 'A' ? a : b)}</div>}
        <div className="tooltip-big">{fmtInt(h.team.expected)}</div>
        <div className="tooltip-sub">expected team score with both pins · {fmtSigned(h.team.expected - h.solo.expected)} vs one pin</div>
        <TooltipRow color={`var(${PIN_A})`} label={`A covers (${compass(b, a)})`} value={fmtPct(h.team.shareA)} />
        <TooltipRow color={`var(${PIN_B})`} label={`B covers (${compass(a, b)})`} value={fmtPct(1 - h.team.shareA)} />
        <TooltipRow label="Typical miss" value={`${fmtKm(h.team.miss[0])} (solo ${fmtKm(h.solo.miss[0])})`} />
      </>
    );
  }, [hedges, mode, geo]);

  // ---- Table ----------------------------------------------------------------------------------
  const rows = useMemo(() => (hedges ? [...hedges.countries.values()] : []), [hedges]);
  const columns: Column<CountryHedge>[] = [
    { key: 'name', header: 'Country', sort: (h) => countryName(h.cc), csv: (h) => countryName(h.cc), render: (h) => <Place cc={h.cc} /> },
    { key: 'code', header: 'Code', csv: (h) => h.cc, render: (h) => <span className="muted">{h.cc}</span> },
    { key: 'solo', header: 'Solo pin', csv: false, render: (h) => <span className="num">{formatLatLng(h.solo.pin)}</span> },
    { key: 'soloLat', header: 'Solo lat', csv: (h) => h.solo.pin.lat, render: () => null },
    { key: 'soloLng', header: 'Solo lng', csv: (h) => h.solo.pin.lng, render: () => null },
    { key: 'soloE', header: 'Solo expected', align: 'right', sort: (h) => h.solo.expected, render: (h) => fmtInt(h.solo.expected) },
    { key: 'soloMiss', header: 'Solo typical miss', csvHeader: 'Solo median miss (km)', align: 'right', sort: (h) => h.solo.miss[0], render: (h) => fmtKm(h.solo.miss[0]) },
    { key: 'soloMiss90', header: 'Solo 90% miss (km)', csv: (h) => h.solo.miss[1], render: () => null },
    { key: 'a', header: 'Team pin A', csv: false, render: (h) => <span className="place"><Dot color={`var(${PIN_A})`} /><span className="num">{formatLatLng(h.team.pins[0])}</span></span> },
    { key: 'b', header: 'Team pin B', csv: false, render: (h) => <span className="place"><Dot color={`var(${PIN_B})`} /><span className="num">{formatLatLng(h.team.pins[1])}</span></span> },
    { key: 'aLat', header: 'Pin A lat', csv: (h) => h.team.pins[0].lat, render: () => null },
    { key: 'aLng', header: 'Pin A lng', csv: (h) => h.team.pins[0].lng, render: () => null },
    { key: 'bLat', header: 'Pin B lat', csv: (h) => h.team.pins[1].lat, render: () => null },
    { key: 'bLng', header: 'Pin B lng', csv: (h) => h.team.pins[1].lng, render: () => null },
    { key: 'share', header: 'A covers', csvHeader: 'Pin A share of locations (%)', align: 'right', sort: (h) => h.team.shareA, csv: (h) => +(100 * h.team.shareA).toFixed(1), render: (h) => fmtPct(h.team.shareA) },
    { key: 'teamE', header: 'Team expected', align: 'right', sort: (h) => h.team.expected, render: (h) => fmtInt(h.team.expected) },
    { key: 'gain', header: 'Gain from 2nd pin', align: 'right', sort: (h) => h.team.expected - h.solo.expected, render: (h) => fmtSigned(h.team.expected - h.solo.expected) },
    { key: 'teamMiss', header: 'Team median miss (km)', csv: (h) => h.team.miss[0], render: () => null },
    { key: 'locations', header: 'Street View locations', csv: (h) => h.locations, render: () => null },
  ];
  // Columns with no cells on screen exist only for the CSV.
  const shownColumns = columns.filter((c) => !['soloLat', 'soloLng', 'soloMiss90', 'aLat', 'aLng', 'bLat', 'bLng', 'teamMiss', 'locations'].includes(c.key));
  const csvColumns = columns;

  // ---- Summary -----------------------------------------------------------------------------------
  const summary = useMemo(() => {
    if (!hedges) return null;
    const list = [...hedges.countries.values()];
    const total = list.reduce((s, h) => s + h.locations, 0);
    const mean = (f: (h: CountryHedge) => number) => list.reduce((s, h) => s + f(h), 0) / list.length;
    const biggestGain = [...list].filter((h) => h.locations >= 1000).sort((a, b) => (b.team.expected - b.solo.expected) - (a.team.expected - a.solo.expected))[0];
    const hardest = [...list].filter((h) => h.locations >= 1000).sort((a, b) => a.solo.expected - b.solo.expected)[0];
    return { count: list.length, total, soloMean: mean((h) => h.solo.expected), teamMean: mean((h) => h.team.expected), biggestGain, hardest };
  }, [hedges]);

  if (error || geoError) return <Card><Empty title="The duel data could not be loaded">{error ?? geoError}</Empty></Card>;
  if (!geo || !hedges || !painted || !summary) return <Card><Empty title="Loading map data…" /></Card>;

  const legendItems: PdfLegendItem[] = mode === 'team'
    ? [{ label: 'Pin A (first teammate)', color: `var(${PIN_A})`, kind: 'dot' }, { label: 'Pin B (second teammate)', color: `var(${PIN_B})`, kind: 'dot' }]
    : [{ label: 'Solo hedge pin', color: `var(${PIN_A})`, kind: 'dot' }];
  if (selected && mode === 'team') legendItems.push({ label: 'Locations closer to A', color: 'var(--pin-a-area)', kind: 'box' }, { label: 'Locations closer to B', color: 'var(--pin-b-area)', kind: 'box' });
  if (selected && mode === 'solo') for (const b of BANDS) legendItems.push({ label: `Score from the pin: ${b.label}`, color: `var(${b.colorVar})`, kind: 'box' });
  if (shade === 'coverage') legendItems.push({ label: 'Street View coverage', color: 'var(--duel-coverage)', kind: 'box' });
  const shadeTitle = shade === 'gain' ? 'Points gained by a second pin' : mode === 'team' ? 'Expected team score' : 'Expected score at the pin';
  const name = selected ? countryName(selected.cc, geo.countries.get(selected.cc)?.name) : null;
  const options = [...hedges.countries.values()].map((h) => ({ cc: h.cc, name: countryName(h.cc, geo.countries.get(h.cc)?.name) })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12, alignItems: 'flex-end' }}>
        <div>
          <h2 className="page-title">Duels: where to hedge</h2>
          <p className="page-lede" style={{ marginBottom: 0 }}>
            You know the country but not the region: where do you click? Each pin is the spot with the highest expected score over
            all of the country's Street View locations. In team duels the team keeps its better guess, so two teammates should split the country.
          </p>
        </div>
        <ExportMenu />
      </div>

      <Tiles title="Summary">
        <StatTile label="Countries and territories" value={fmtInt(summary.count)} note={`${fmtInt(summary.total)} Street View locations`} />
        <StatTile label="Average solo hedge" value={fmtInt(summary.soloMean)} note="expected points per round, per country" />
        <StatTile label="Average team hedge" value={fmtInt(summary.teamMean)} note={`${fmtSigned(summary.teamMean - summary.soloMean)} from the second pin`} />
        <StatTile label="Most to gain from splitting" value={countryName(summary.biggestGain.cc)} note={`${fmtSigned(summary.biggestGain.team.expected - summary.biggestGain.solo.expected)} points per round`} />
        <StatTile label="Hardest to hedge" value={countryName(summary.hardest.cc)} note={`${fmtInt(summary.hardest.solo.expected)} expected with one pin`} />
      </Tiles>

      <Card
        title={name ? `${name}: ${mode === 'team' ? 'team hedge' : 'solo hedge'}` : mode === 'team' ? 'Team duel hedges (two pins)' : 'Solo duel hedges (one pin)'}
        subtitle={selected
          ? (mode === 'team'
            ? 'Coloured by which teammate is closer for each part of the coverage.'
            : 'Coloured by the score you would get from the pin if the location were there.')
          : 'Hover a pin or a country for the numbers; click one to zoom in.'}
        actions={(
          <ExportButtons
            item={{
              title: name ? `${name} ${mode} hedge map` : `${mode === 'team' ? 'Team' : 'Solo'} duel hedge map`,
              pdf: () => {
                const canvas = mapHandle.current?.toCanvas({ scale: 2 });
                if (!canvas) return null;
                return {
                  title: name ? `${name}: where to hedge (${mode === 'team' ? 'team duels, two pins' : 'solo duels, one pin'})` : mode === 'team' ? 'Team duels: where two teammates should hedge' : 'Duels: where to hedge in each country',
                  subtitle: selected
                    ? (mode === 'team'
                      ? `Pin A ${formatLatLng(selected.team.pins[0])} covers ${fmtPct(selected.team.shareA)} of locations, pin B ${formatLatLng(selected.team.pins[1])} the rest. Expected team score ${fmtInt(selected.team.expected)} (one pin: ${fmtInt(selected.solo.expected)}).`
                      : `Pin ${formatLatLng(selected.solo.pin)}. Expected score ${fmtInt(selected.solo.expected)}; typical miss ${fmtKm(selected.solo.miss[0])}.`)
                    : 'Each pin maximises the expected round score over the country\'s Street View locations (World map scoring).',
                  context: 'Duels · scoring: 5000 × e^(−distance / 1,492 km)',
                  legend: legendItems,
                  scale: painted.scale ? pdfScale(painted.scale, shade === 'gain' ? (v) => fmtSigned(v) : fmtInt, shadeTitle) : undefined,
                  graphic: { kind: 'canvas', canvas },
                };
              },
              csv: () => [{
                name: 'hedges',
                columns: ['Country', 'Code', 'Solo lat', 'Solo lng', 'Solo expected', 'Pin A lat', 'Pin A lng', 'Pin B lat', 'Pin B lng', 'Pin A share (%)', 'Team expected'],
                rows: [...hedges.countries.values()].filter((h) => !selected || h.cc === selected.cc).map((h) => [countryName(h.cc), h.cc, h.solo.pin.lat, h.solo.pin.lng, h.solo.expected, h.team.pins[0].lat, h.team.pins[0].lng, h.team.pins[1].lat, h.team.pins[1].lng, +(100 * h.team.shareA).toFixed(1), h.team.expected]),
              }],
            }}
          />
        )}
      >
        <div className="row" style={{ marginBottom: 12, gap: '10px 18px' }}>
          <Segmented<Mode> label="Duel type" value={mode} onChange={setMode} options={[{ value: 'solo', label: 'Solo (1 pin)' }, { value: 'team', label: 'Team of two (2 pins)' }]} />
          <div className="filter">
            <span className="filter-label">Shade</span>
            <Segmented<Shade>
              label="Shade countries by"
              value={shade}
              onChange={setShade}
              options={[
                { value: 'coverage', label: 'Coverage only' },
                { value: 'score', label: 'Expected score' },
                ...(mode === 'team' ? [{ value: 'gain' as const, label: 'Gain from 2nd pin' }] : []),
              ]}
            />
          </div>
          <div className="filter">
            <label htmlFor="duel-country">Country</label>
            <select id="duel-country" className="select" value={selected?.cc ?? ''} onChange={(e) => select(e.target.value || null)}>
              <option value="">Whole world</option>
              {options.map((o) => <option key={o.cc} value={o.cc}>{o.name}</option>)}
            </select>
          </div>
        </div>
        <WorldMap
          handle={mapHandle}
          geo={geo}
          level="country"
          classes={painted.classes}
          colorVars={painted.colorVars}
          markers={markers}
          overlay={overlay}
          highlight={selected?.cc ?? null}
          focus={focus}
          smallCountryMarkers={false}
          tooltip={tooltip}
          onPick={(t) => { if (hedges.countries.has(t.cc)) select(t.cc); }}
          ariaLabel={mode === 'team' ? 'Map of the best pair of hedge pins in every country' : 'Map of the best hedge pin in every country'}
        />
        <div className="scale-legend">
          {mode === 'team'
            ? <><span className="swatch"><span className="pin-badge small" style={{ background: `var(${PIN_A})` }}>A</span>Pin A</span><span className="swatch"><span className="pin-badge small" style={{ background: `var(${PIN_B})` }}>B</span>Pin B</span></>
            : <span className="swatch"><span className="pin-badge small" style={{ background: `var(${PIN_A})` }} />Hedge pin</span>}
          {selected && mode === 'team' && <><span className="swatch"><i style={{ background: 'var(--pin-a-area)' }} />closer to A</span><span className="swatch"><i style={{ background: 'var(--pin-b-area)' }} />closer to B</span></>}
          {selected && mode === 'solo' && <><span>Score from the pin:</span>{BANDS.map((b) => <span className="swatch" key={b.label}><i style={{ background: `var(${b.colorVar})` }} />{b.label}</span>)}</>}
          {shade === 'coverage' && <span className="swatch"><i style={{ background: 'var(--duel-coverage)' }} />Street View coverage</span>}
        </div>
        {painted.scale && <ScaleLegend scale={painted.scale} format={shade === 'gain' ? (v) => fmtSigned(v) : fmtInt} title={shadeTitle} />}
        {selected && (
          <div className="duel-detail">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 className="card-title" style={{ fontSize: 15 }}><Place cc={selected.cc} name={name ?? selected.cc} /></h3>
              <button type="button" className="btn small" onClick={() => select(null)}>Back to the world</button>
            </div>
            <div className="grid two" style={{ marginTop: 10 }}>
              <div className="stack" style={{ gap: 8 }}>
                <h4 className="detail-head">Solo duels: one pin</h4>
                <PinLine label="" colorVar={PIN_A} pin={selected.solo.pin} />
                <dl className="kv">
                  <dt>Expected score</dt><dd>{fmtInt(selected.solo.expected)}</dd>
                  <dt>Typical miss</dt><dd>{fmtKm(selected.solo.miss[0])}</dd>
                  <dt>9 rounds in 10 within</dt><dd>{fmtKm(selected.solo.miss[1])}</dd>
                  <dt>Farthest location</dt><dd>{fmtKm(selected.solo.miss[2])}</dd>
                </dl>
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <h4 className="detail-head">Team duels: two pins</h4>
                <PinLine label="A" colorVar={PIN_A} pin={selected.team.pins[0]} note={`Covers ${fmtPct(selected.team.shareA)} of locations, to the ${compass(selected.team.pins[1], selected.team.pins[0])}`} />
                <PinLine label="B" colorVar={PIN_B} pin={selected.team.pins[1]} note={`Covers ${fmtPct(1 - selected.team.shareA)} of locations, to the ${compass(selected.team.pins[0], selected.team.pins[1])}`} />
                <dl className="kv">
                  <dt>Expected team score</dt><dd>{fmtInt(selected.team.expected)} <span className="muted">({fmtSigned(selected.team.expected - selected.solo.expected)} vs one pin)</span></dd>
                  <dt>Typical miss</dt><dd>{fmtKm(selected.team.miss[0])}</dd>
                  <dt>9 rounds in 10 within</dt><dd>{fmtKm(selected.team.miss[1])}</dd>
                </dl>
              </div>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              Pins can land in the sea or across a border: that is fine, GeoGuessr scores any click by its distance. Based on {fmtInt(selected.locations)} Street View locations.
            </p>
          </div>
        )}
        <details className="explain">
          <summary>How the pins are worked out</summary>
          <p>
            A duel round on a world map scores 5000 × e<sup>−d / 1,492 km</sup> for a guess <em>d</em> away, and damage follows the difference in score.
            For every country, the pin is the spot that maximises the average of that score over the country's Street View locations
            ({fmtInt(summary.total)} locations from the public coverage dataset, weighted by how much coverage each area has). That is a "centre" of the
            coverage that leans towards where coverage is dense and is barely pulled by far-off outliers: a 3,000 km miss and a 6,000 km miss both score
            close to nothing, so it is not worth sacrificing the bulk of the country to hedge towards Alaska or the Canary Islands.
          </p>
          <p>
            In team duels a team's round score is its best guess, so the two pins maximise the average of the <em>better</em> of the two scores. The result splits
            the country into two halves, each teammate covering one. The optimiser starts from many candidate spots, refines each pair, and keeps the best; pins
            are free to sit in the sea when that scores better.
          </p>
          <p>
            Assumptions: within a country, locations follow Street View coverage; you know the country for certain; the scoring is the World map's. On smaller
            maps scores fall off faster, which pulls pins towards the densest coverage.
          </p>
        </details>
      </Card>

      <Card title="Every country" subtitle="Click a row to show it on the map. Sort by any column.">
        <DataTable
          rows={rows}
          columns={shownColumns}
          rowKey={(h) => h.cc}
          initialSort={{ key: 'name', dir: 'asc' }}
          onRowClick={(h) => { select(h.cc); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
          selectedKey={selected?.cc ?? null}
          capped
          caption="Hedge pins for every country"
        />
        <div className="table-toolbar" style={{ marginTop: 8 }}>
          <ExportButtons item={{
            title: 'Hedge pins by country',
            csv: () => [{
              name: 'hedge pins by country',
              columns: csvColumns.filter((c) => c.csv !== false).map((c) => c.csvHeader ?? (typeof c.header === 'string' ? c.header : c.key)),
              rows: rows.map((h) => csvColumns.filter((c) => c.csv !== false).map((c) => (c.csv ? c.csv(h) : c.sort ? c.sort(h) : null))),
            }],
          }} />
        </div>
      </Card>
    </>
  );
}
