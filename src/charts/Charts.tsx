import { useState, type ReactNode } from 'react';
import { scaleLinear } from 'd3-scale';
import { fmtInt } from '../util/format';
import { useWidth } from '../util/hooks';

// ---------------------------------------------------------------------------------------------
// Forest plot: an estimate with its interval per row, around a zero line
// ---------------------------------------------------------------------------------------------

export interface ForestRow {
  key: string;
  label: string;
  value: number;
  lo: number;
  hi: number;
  /** Rows whose interval excludes zero after correction are drawn in colour; the rest in grey. */
  significant: boolean;
  detail?: ReactNode;
}

export function ForestPlot({ rows, format = fmtInt, ariaLabel, onPick, axisLabel }: {
  rows: ForestRow[];
  format?: (v: number) => string;
  ariaLabel: string;
  onPick?: (key: string) => void;
  axisLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const labelW = Math.min(170, Math.max(96, width * 0.26));
  const rowH = 24;
  const top = 6, bottom = 38;
  const innerW = Math.max(10, width - labelW - 20);
  const height = rows.length * rowH + top + bottom;

  // Clip very wide intervals so a few noisy rows do not flatten everything else.
  const reach = [...rows.map((r) => Math.max(Math.abs(r.value) * 1.6, Math.min(Math.abs(r.lo), Math.abs(r.hi)) * 1.2))].sort((a, b) => a - b);
  const limit = Math.max(1, reach[Math.floor(reach.length * 0.9)] ?? 1, ...rows.map((r) => Math.abs(r.value) * 1.15));
  const x = scaleLinear().domain([-limit, limit]).range([0, innerW]).nice(6);
  const [d0, d1] = x.domain();
  const clamp = (v: number) => Math.max(d0, Math.min(d1, v));
  const ticks = x.ticks(Math.max(3, Math.min(8, Math.floor(innerW / 80))));
  const row = hover !== null ? rows[hover] : null;

  return (
    <div ref={ref} className="chart" style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <g transform={`translate(${labelW},${top})`}>
            {ticks.map((t) => (
              <g key={t} transform={`translate(${x(t)},0)`}>
                <line className={t === 0 ? 'axis-line' : 'grid-line'} y1={0} y2={rows.length * rowH} />
                <text y={rows.length * rowH + 15} textAnchor="middle">{format(t)}</text>
              </g>
            ))}
            <text className="label" x={innerW / 2} y={rows.length * rowH + 32} textAnchor="middle">{axisLabel}</text>
            {rows.map((r, i) => {
              const cy = i * rowH + rowH / 2;
              const color = !r.significant ? 'var(--muted)' : r.value >= 0 ? 'var(--series-1)' : 'var(--series-8)';
              return (
                <g key={r.key}>
                  {hover === i && <rect x={-labelW} y={i * rowH} width={labelW + innerW + 20} height={rowH} fill="var(--surface-2)" />}
                  <text className="label" x={-10} y={cy} dy="0.32em" textAnchor="end" style={{ fontWeight: r.significant ? 600 : 400 }}>
                    {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
                  </text>
                  <line x1={x(clamp(r.lo))} x2={x(clamp(r.hi))} y1={cy} y2={cy} stroke={color} strokeWidth={1.5} strokeLinecap="round" opacity={r.significant ? 1 : 0.7} />
                  <circle cx={x(clamp(r.value))} cy={cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
                  <rect
                    x={-labelW} y={i * rowH} width={labelW + innerW + 20} height={rowH} fill="transparent"
                    style={{ cursor: onPick ? 'pointer' : 'default' }}
                    tabIndex={onPick ? 0 : undefined}
                    role={onPick ? 'button' : undefined}
                    aria-label={`${r.label}: ${format(r.value)}, interval ${format(r.lo)} to ${format(r.hi)}`}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover((h) => (h === i ? null : h))}
                    onClick={onPick ? () => onPick(r.key) : undefined}
                    onKeyDown={onPick ? (e) => { if (e.key === 'Enter') onPick(r.key); } : undefined}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {row && hover !== null && (
        <div className="tooltip" style={{ top: Math.max(0, hover * rowH - 8), right: 12 }}>
          <div className="tooltip-title">{row.label}</div>
          <div className="tooltip-row"><span className="name">Change</span><span className="value">{format(row.value)}</span></div>
          <div className="tooltip-row"><span className="name">95% interval</span><span className="value">{format(row.lo)} to {format(row.hi)}</span></div>
          {row.detail}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Ranked bars: one hue, largest first, values printed at the tip
// ---------------------------------------------------------------------------------------------

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** Shown after the value, e.g. sample size. */
  note?: string;
}

export function BarList({ rows, max, format = fmtInt, onPick }: { rows: BarRow[]; max?: number; format?: (v: number) => string; onPick?: (key: string) => void }) {
  const top = max ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 42%) 1fr auto', gap: 10, alignItems: 'center', cursor: onPick ? 'pointer' : undefined, fontSize: 14 }}
          onClick={onPick ? () => onPick(r.key) : undefined}
          onKeyDown={onPick ? (e) => { if (e.key === 'Enter') onPick(r.key); } : undefined}
          role={onPick ? 'button' : undefined}
          tabIndex={onPick ? 0 : undefined}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <span style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(1, r.value / top)) * 100}%`, background: 'var(--seq-4)', borderRadius: '0 4px 4px 0' }} />
          </span>
          <span className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {format(r.value)}{r.note && <span className="muted" style={{ fontWeight: 400 }}> · {r.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Columns: thin bars from one baseline (histograms, per-round averages)
// ---------------------------------------------------------------------------------------------

export interface ColumnDatum {
  key: string;
  /** Axis label; pass '' to leave a tick unlabelled. */
  label: string;
  value: number;
  tooltip: ReactNode;
}

export function Columns({ data, height = 200, format = fmtInt, ariaLabel, yMax, counts }: { data: ColumnDatum[]; height?: number; format?: (v: number) => string; ariaLabel: string; yMax?: number; /** Values are counts: only whole-number ticks. */ counts?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 10, right: 8, bottom: 26, left: 44 };
  const innerW = Math.max(10, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;
  const y = scaleLinear().domain([0, yMax ?? Math.max(1, ...data.map((d) => d.value))]).range([innerH, 0]).nice(4);
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, slot - 2));
  const r = Math.min(4, barW / 2);
  return (
    <div ref={ref} className="chart" style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          <g transform={`translate(${margin.left},${margin.top})`}>
            {y.ticks(4).filter((t) => !counts || Number.isInteger(t)).map((t) => (
              <g key={t} transform={`translate(0,${y(t)})`}>
                <line className="grid-line" x1={0} x2={innerW} />
                <text x={-8} dy="0.32em" textAnchor="end">{format(t)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = i * slot + slot / 2;
              const h = innerH - y(d.value);
              const x0 = cx - barW / 2;
              // Rounded at the data end, square on the baseline.
              const shape = h <= 0 ? '' : `M${x0},${innerH}V${y(d.value) + Math.min(r, h)}q0,${-Math.min(r, h)} ${r},${-Math.min(r, h)}h${barW - 2 * r}q${r},0 ${r},${Math.min(r, h)}V${innerH}Z`;
              return (
                <g key={d.key}>
                  {shape && <path d={shape} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />}
                  {d.label && <text x={cx} y={innerH + 17} textAnchor="middle">{d.label}</text>}
                  <rect
                    x={i * slot} y={0} width={slot} height={innerH} fill="transparent"
                    onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover((v) => (v === i ? null : v))}
                  />
                </g>
              );
            })}
            <line className="axis-line" x1={0} x2={innerW} y1={innerH} y2={innerH} />
          </g>
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="tooltip" style={{ top: 4, left: Math.min(Math.max(0, margin.left + hover * slot - 60), Math.max(0, width - 200)) }}>
          {data[hover].tooltip}
        </div>
      )}
    </div>
  );
}
