import { useMemo, useState, type ReactNode } from 'react';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { line as d3Line } from 'd3-shape';
import { fmtCompact, fmtDate, fmtInt } from '../util/format';
import { useWidth } from '../util/hooks';

export interface ChartPoint {
  t: number;
  v: number;
}

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
  /** Fitted trends are dashed so they read as a model, not as data. */
  dashed?: boolean;
  width?: number;
}

export interface DotSeries {
  id: string;
  label: string;
  color: string;
  points: ChartPoint[];
}

export interface Band {
  label: string;
  color: string;
  points: { t: number; lo: number; hi: number }[];
}

export interface TimeChartProps {
  lines: LineSeries[];
  /** Raw observations, drawn small and translucent behind the lines. */
  dots?: DotSeries[];
  band?: Band;
  yDomain?: [number, number];
  /** Axis tick format. */
  yFormat?: (v: number) => string;
  /** Tooltip value format. */
  valueFormat?: (v: number) => string;
  height?: number;
  ariaLabel: string;
  /** Called with the time under the crosshair when the chart is clicked. */
  onPick?: (t: number) => void;
  /** Label series at the right-hand end of their line (when they do not collide). */
  endLabels?: boolean;
}

const MARGIN = { top: 12, right: 18, bottom: 28, left: 46 };

/** Last point at or before t. */
function valueAt(points: ChartPoint[], t: number): ChartPoint | null {
  let lo = 0, hi = points.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 ? points[found] : null;
}

function nearestIndex(xs: number[], t: number): number {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < t) lo = mid; else hi = mid;
  }
  return Math.abs(xs[lo] - t) <= Math.abs(xs[hi] - t) ? lo : hi;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function tickLabel(d: Date): string {
  if (d.getUTCMonth() === 0 && d.getUTCDate() === 1) return String(d.getUTCFullYear());
  if (d.getUTCDate() === 1) return MONTHS[d.getUTCMonth()];
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function TimeChart({ lines, dots = [], band, yDomain, yFormat = fmtCompact, valueFormat = fmtInt, height = 320, ariaLabel, onPick, endLabels = false }: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const xs = new Set<number>();
    let min = Infinity, max = -Infinity;
    const see = (v: number) => { if (v < min) min = v; if (v > max) max = v; };
    for (const s of dots) for (const p of s.points) { xs.add(p.t); see(p.v); }
    for (const s of lines) for (const p of s.points) { xs.add(p.t); see(p.v); }
    if (band) for (const p of band.points) { see(p.lo); see(p.hi); }
    const sorted = [...xs].sort((a, b) => a - b);
    return { xs: sorted, min, max };
  }, [lines, dots, band]);

  const labelEnds = endLabels && width >= 560;
  const right = labelEnds ? 96 : MARGIN.right;
  const innerW = Math.max(10, width - MARGIN.left - right);
  const innerH = height - MARGIN.top - MARGIN.bottom;
  const hasData = model.xs.length > 0;

  const x = useMemo(() => {
    const first = model.xs[0] ?? 0, last = model.xs[model.xs.length - 1] ?? 1;
    const pad = first === last ? 43200000 : 0;
    return scaleUtc().domain([first - pad, last + pad]).range([0, innerW]);
  }, [model.xs, innerW]);
  const y = useMemo(() => {
    const domain = yDomain ?? [Math.min(0, model.min), model.max];
    const scale = scaleLinear().domain(domain).range([innerH, 0]);
    return yDomain ? scale : scale.nice(5);
  }, [yDomain, model.min, model.max, innerH]);

  const path = useMemo(() => d3Line<ChartPoint>().x((p) => x(p.t)).y((p) => y(p.v)), [x, y]);
  const bandPath = useMemo(() => {
    if (!band || band.points.length < 2) return null;
    const top = band.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hi).toFixed(1)}`).join('');
    const bottom = [...band.points].reverse().map((p) => `L${x(p.t).toFixed(1)},${y(p.lo).toFixed(1)}`).join('');
    return `${top}${bottom}Z`;
  }, [band, x, y]);

  if (!hasData) return <div ref={ref} className="chart" style={{ height }} />;

  const xTicks = x.ticks(Math.max(2, Math.min(10, Math.floor(innerW / 84))));
  const yTicks = y.ticks(5);
  const hoverT = hover !== null ? model.xs[hover] : null;

  const readout = hoverT === null ? null : {
    dots: dots.map((s) => ({ s, p: s.points.find((p) => p.t === hoverT) ?? null })).filter((r) => r.p),
    lines: lines.map((s) => ({ s, p: valueAt(s.points, hoverT) })).filter((r) => r.p && hoverT - r.p.t < 45 * 86400000),
    band: band ? band.points.find((p) => p.t === hoverT) ?? null : null,
  };

  // End labels: only when the line ends are far enough apart to label without leader lines.
  const ends = labelEnds
    ? lines.filter((s) => s.points.length > 0 && !s.dashed).map((s) => ({ s, y: y(s.points[s.points.length - 1].v), x: x(s.points[s.points.length - 1].t) }))
    : [];
  const sortedEnds = [...ends].sort((a, b) => a.y - b.y);
  const collide = sortedEnds.some((e, i) => i > 0 && e.y - sortedEnds[i - 1].y < 14);

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const t = x.invert(event.clientX - box.left).getTime();
    setHover(nearestIndex(model.xs, t));
  };
  const hx = hoverT !== null ? x(hoverT) : 0;
  const tooltipLeft = hx + MARGIN.left + 14;
  const flip = tooltipLeft + 210 > width;

  return (
    <div ref={ref} className="chart" style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
            {yTicks.map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line className="grid-line" x1={0} x2={innerW} />
                <text x={-8} dy="0.32em" textAnchor="end">{yFormat(tick)}</text>
              </g>
            ))}
            <line className="axis-line" x1={0} x2={innerW} y1={innerH} y2={innerH} />
            {xTicks.map((tick) => (
              <text key={tick.getTime()} x={x(tick)} y={innerH + 18} textAnchor="middle">{tickLabel(tick)}</text>
            ))}

            {bandPath && <path d={bandPath} fill={band!.color} opacity={0.14} />}
            {dots.map((s) => (
              <g key={s.id} fill={s.color} opacity={0.38}>
                {s.points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.4} />)}
              </g>
            ))}
            {lines.map((s) => (
              <path
                key={s.id}
                d={path(s.points) ?? undefined}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width ?? 2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? '5 4' : undefined}
              />
            ))}
            {!collide && ends.map(({ s, x: ex, y: ey }) => (
              <g key={s.id}>
                <circle cx={ex} cy={ey} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                <text className="label" x={ex + 9} y={ey} dy="0.32em">{s.label}</text>
              </g>
            ))}

            {hoverT !== null && readout && (
              <g pointerEvents="none">
                <line className="crosshair" x1={hx} x2={hx} y1={0} y2={innerH} />
                {readout.dots.map(({ s, p }) => (
                  <circle key={s.id} cx={hx} cy={y(p!.v)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ))}
                {readout.lines.filter(({ p }) => p!.t === hoverT).map(({ s, p }) => (
                  <circle key={s.id} cx={hx} cy={y(p!.v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            )}
            <rect
              x={0} y={0} width={innerW} height={innerH} fill="transparent"
              style={{ cursor: onPick ? 'pointer' : 'crosshair', touchAction: 'pan-y' }}
              onPointerMove={onMove}
              onPointerDown={onMove}
              onPointerLeave={() => setHover(null)}
              onClick={onPick && hoverT !== null ? () => onPick(hoverT) : undefined}
            />
          </g>
        </svg>
      )}
      {hoverT !== null && readout && (
        <div className="tooltip" style={{ top: 8, left: flip ? undefined : tooltipLeft, right: flip ? width - hx - MARGIN.left + 14 : undefined }}>
          <div className="tooltip-title">{fmtDate(hoverT)}</div>
          {readout.dots.map(({ s, p }) => <TooltipRow key={s.id} color={s.color} label={s.label} value={valueFormat(p!.v)} dot />)}
          {readout.lines.map(({ s, p }) => <TooltipRow key={s.id} color={s.color} label={s.label} value={valueFormat(p!.v)} dashed={s.dashed} />)}
          {readout.band && band && (
            <TooltipRow color={band.color} label={band.label} value={`${valueFormat(readout.band.lo)} – ${valueFormat(readout.band.hi)}`} />
          )}
        </div>
      )}
    </div>
  );
}

export function TooltipRow({ color, label, value, dot, dashed }: { color?: string; label: ReactNode; value: ReactNode; dot?: boolean; dashed?: boolean }) {
  return (
    <div className="tooltip-row">
      <span className="name">
        {color && (dot
          ? <span className="dot" style={{ background: color, width: 8, height: 8 }} />
          : <span className="key-line" style={{ borderTopColor: color, borderTopStyle: dashed ? 'dashed' : 'solid' }} />)}
        {label}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Legend and the table-view twin every chart gets
// ---------------------------------------------------------------------------------------------

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'line' | 'dot' | 'dashed' | 'band';
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.label}>
          {item.kind === 'dot'
            ? <span className="dot" style={{ background: item.color, width: 8, height: 8, opacity: 0.6 }} />
            : item.kind === 'band'
              ? <span style={{ width: 16, height: 10, borderRadius: 2, background: item.color, opacity: 0.25, display: 'inline-block' }} />
              : <span className="key-line" style={{ borderTopColor: item.color, borderTopStyle: item.kind === 'dashed' ? 'dashed' : 'solid' }} />}
          {item.label}
        </span>
      ))}
    </div>
  );
}

export interface TableView {
  columns: string[];
  rows: (string | number)[][];
}

/** A chart with its legend and a "Table" toggle showing the same numbers as text. */
export function ChartBlock({ legend, table, children, toolbar }: { legend?: LegendItem[]; table: TableView; children: ReactNode; toolbar?: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>{legend && <Legend items={legend} />}</div>
        <div className="row">
          {toolbar}
          <button type="button" className="btn quiet small" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </div>
      {showTable ? (
        <div className="table-wrap capped">
          <table className="data">
            <thead><tr>{table.columns.map((c, i) => <th key={c} scope="col" className={i ? 'r' : ''}>{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j} className={j ? 'r num' : ''}>{typeof cell === 'number' ? fmtInt(cell) : cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </div>
  );
}
