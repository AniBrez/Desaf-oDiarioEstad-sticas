import { useMemo, useState, type ReactNode } from 'react';
import { ExportButtons } from '../export/ExportKit';
import type { Cell, CsvTable } from '../export/files';
import type { PdfScale } from '../export/pdf';
import { countryName } from '../geo/geo';
import { fmtSigned, flagEmoji, supportsFlagEmoji } from '../util/format';

export function Card({ title, subtitle, actions, children, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, note, meter }: { label: string; value: ReactNode; note?: ReactNode; meter?: number }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {meter !== undefined && (
        <div className="meter" role="img" aria-label={`${Math.round(meter * 100)} percent`}>
          <span style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }} />
        </div>
      )}
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

/** A signed change; green/red only when the direction has a meaning. */
export function Delta({ value, format, suffix }: { value: number | null; format?: (v: number) => string; suffix?: string }) {
  if (value === null || !Number.isFinite(value)) return null;
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : '';
  return (
    <span className={`delta ${direction}`}>
      {value > 0 ? '▲' : value < 0 ? '▼' : ''} {fmtSigned(value, format)}{suffix ?? ''}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Flag({ cc }: { cc: string | null }) {
  if (!cc) return <span className="flag code" aria-hidden="true">?</span>;
  return supportsFlagEmoji()
    ? <span className="flag" aria-hidden="true">{flagEmoji(cc)}</span>
    : <span className="flag code" aria-hidden="true">{cc}</span>;
}

export function Place({ cc, name }: { cc: string | null; name?: string }) {
  return (
    <span className="place">
      <Flag cc={cc} />
      <span>{name ?? (cc ? countryName(cc) : 'Unknown')}</span>
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} aria-hidden="true" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sortable table
// ---------------------------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Value used for sorting; omit for a column that cannot be sorted. */
  sort?: (row: T) => number | string | null;
  render: (row: T) => ReactNode;
  align?: 'right';
  title?: string;
  /** Value written to CSV (defaults to the sort value); false leaves the column out. */
  csv?: ((row: T) => Cell) | false;
  /** CSV column name (defaults to the header when it is text). */
  csvHeader?: string;
}

/** The rows of a table as a CSV table, using each column's export value. */
export function tableCsv<T>(name: string, rows: T[], columns: Column<T>[]): CsvTable {
  const cols = columns.filter((c) => c.csv !== false && (c.csv || c.sort));
  return {
    name,
    columns: cols.map((c) => c.csvHeader ?? (typeof c.header === 'string' ? c.header : c.key)),
    rows: rows.map((row) => cols.map((c) => (c.csv ? c.csv(row) : c.sort!(row)))),
  };
}

export function DataTable<T>({ rows, columns, rowKey, initialSort, onRowClick, selectedKey, capped, caption, exportTitle, exportColumns }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  capped?: boolean;
  caption?: string;
  /** Adds a CSV export of every row (in the current order) under this title. */
  exportTitle?: string;
  /** Columns for the CSV, when it should hold more than is on screen. */
  exportColumns?: Column<T>[];
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const sorted = useMemo(() => {
    const column = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !column?.sort) return rows;
    const accessor = column.sort;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = accessor(a), vb = accessor(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // missing values last, whichever way we sort
      if (vb === null) return -1;
      return (typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - (vb as number)) * factor;
    });
  }, [rows, columns, sort]);

  return (
    <>
    {exportTitle && (
      <div className="table-toolbar">
        <ExportButtons item={{ title: exportTitle, csv: () => [tableCsv(exportTitle, sorted, exportColumns ?? columns)] }} />
      </div>
    )}
    <div className={`table-wrap${capped ? ' capped' : ''}`}>
      <table className="data">
        {caption && <caption className="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  title={c.title}
                  className={`${c.align === 'right' ? 'r' : ''}${c.sort ? ' sortable' : ''}`}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={c.sort ? () => setSort(active ? { key: c.key, dir: sort!.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'desc' }) : undefined}
                >
                  {c.header}
                  {c.sort && <span className="sort" aria-hidden="true">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={onRowClick ? 'clickable' : undefined}
                aria-selected={selectedKey !== undefined ? selectedKey === key : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } } : undefined}
              >
                {columns.map((c) => <td key={c.key} className={`${c.align === 'right' ? 'r num' : ''}`}>{c.render(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Sequential scale: classes, colours, legend
// ---------------------------------------------------------------------------------------------

export const SEQUENTIAL = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)', 'var(--seq-7)'];
/** Text colour that reads on each step of the ramp. */
export const SEQUENTIAL_INK = ['var(--seq-ink-light)', 'var(--seq-ink-light)', 'var(--seq-ink-light)', 'var(--seq-ink-dark)', 'var(--seq-ink-dark)', 'var(--seq-ink-dark)', 'var(--seq-ink-dark)'];

export interface ClassScale {
  /** Class boundaries: breaks[i] is the lower edge of class i; one more entry than classes. */
  breaks: number[];
  /** Which step of the seven-step ramp each class uses (spread so the ends are always used). */
  colors: number[];
  classOf(value: number): number;
}

export function classScale(lo: number, hi: number, classes = 7): ClassScale {
  const breaks = Array.from({ length: classes + 1 }, (_, i) => lo + ((hi - lo) * i) / classes);
  return {
    breaks,
    colors: Array.from({ length: classes }, (_, i) => (classes === 1 ? 3 : Math.round((i * 6) / (classes - 1)))),
    classOf: (value) => Math.max(0, Math.min(classes - 1, Math.floor(((value - lo) / (hi - lo)) * classes))),
  };
}

/**
 * Classes with round boundaries: the smallest of the given step sizes that covers lo..hi in at
 * most seven classes (and at least `minClasses`, widening the range if need be).
 */
export function niceClassScale(lo: number, hi: number, steps: number[], limits: [number, number], minClasses = 4): ClassScale {
  for (const step of steps) {
    let start = Math.floor(lo / step + 1e-9) * step;
    let count = Math.max(1, Math.ceil((hi - start) / step - 1e-9));
    if (count > 7 && step !== steps[steps.length - 1]) continue;
    count = Math.min(7, count);
    // Too few classes: grow outwards, staying inside the limits.
    while (count < minClasses) {
      if (start - step >= limits[0] - 1e-9) { start -= step; count++; }
      if (count < minClasses && start + (count + 1) * step <= limits[1] + 1e-9) count++;
      if (start - step < limits[0] - 1e-9 && start + (count + 1) * step > limits[1] + 1e-9) break;
    }
    return classScale(start, start + count * step, count);
  }
  return classScale(lo, hi);
}

/** The same legend for a PDF. */
export function pdfScale(scale: ClassScale, format: (v: number) => string, title: string): PdfScale {
  return { title, colors: scale.colors.map((c) => SEQUENTIAL[c]), breaks: scale.breaks.map(format) };
}

export function ScaleLegend({ scale, format, title, extras }: { scale: ClassScale; format: (v: number) => string; title: string; extras?: { label: string; color: string }[] }) {
  const n = scale.breaks.length - 1;
  return (
    <div className="scale-legend">
      <span>{title}</span>
      <span className="scale-steps" role="img" aria-label={`${title}: from ${format(scale.breaks[0])} (lightest) to ${format(scale.breaks[n])} (strongest)`}>
        <span className="scale-bar">
          {scale.colors.map((color, i) => <i key={i} style={{ background: SEQUENTIAL[color] }} />)}
        </span>
        <span className="scale-ticks">
          {scale.breaks.map((b, i) => <span key={i}>{format(b)}</span>)}
        </span>
      </span>
      {extras?.map((e) => (
        <span className="swatch" key={e.label}><i style={{ background: e.color }} />{e.label}</span>
      ))}
    </div>
  );
}
