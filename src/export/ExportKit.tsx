/**
 * Every chart, map, table and group of statistics registers what it can export. Each one gets
 * its own small PDF / CSV buttons, and the page-level Export menu lists them all, with a ZIP of
 * everything on the page.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { csvBlob, fileName, makeZip, saveBlob, slug, toCsv, type CsvTable } from './files';
import type { PdfSpec } from './pdf';

export interface ExportItem {
  title: string;
  /** Tables behind the item (one CSV each). */
  csv?: () => CsvTable[];
  /** Built when needed, from what is on screen. */
  pdf?: () => PdfSpec | null;
}

export interface ExportInfo {
  /** Section of the app ("overview"). */
  page: string;
  /** Who and what the numbers are about, printed on PDFs. */
  context: string;
  /** For file names. */
  player?: string;
}

interface Registry {
  add(id: string, ref: React.RefObject<ExportItem>): () => void;
  list(): ExportItem[];
  info: ExportInfo;
}

const RegistryContext = createContext<Registry | null>(null);

export function ExportProvider({ info, children }: { info: ExportInfo; children: ReactNode }) {
  const items = useRef(new Map<string, React.RefObject<ExportItem>>());
  const infoRef = useRef(info);
  infoRef.current = info;
  const registry = useMemo<Registry>(() => ({
    add(id, ref) {
      items.current.set(id, ref);
      return () => { items.current.delete(id); };
    },
    list: () => [...items.current.values()].map((r) => r.current!).filter(Boolean),
    get info() { return infoRef.current; },
  }), []);
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

/** Registers an exportable item for the page's Export menu (the latest version is always used). */
export function useExportItem(item: ExportItem | null): void {
  const registry = useContext(RegistryContext);
  const id = useId();
  const ref = useRef<ExportItem>(item ?? { title: '' });
  if (item) ref.current = item;
  const active = item !== null;
  useEffect(() => (registry && active ? registry.add(id, ref) : undefined), [registry, id, active]);
}

function useInfo(): ExportInfo {
  return useContext(RegistryContext)?.info ?? { page: 'export', context: '' };
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

async function pdfBlob(item: ExportItem, info: ExportInfo): Promise<Blob | null> {
  const spec = item.pdf?.();
  if (!spec) return null;
  const { buildPdf } = await import('./pdf');
  return buildPdf({ ...spec, context: spec.context ?? info.context });
}

export async function downloadPdf(item: ExportItem, info: ExportInfo): Promise<void> {
  const blob = await pdfBlob(item, info);
  if (blob) saveBlob(fileName([info.page, item.title, info.player], 'pdf'), blob);
}

export function downloadCsv(item: ExportItem, info: ExportInfo): void {
  const tables = item.csv?.() ?? [];
  if (tables.length === 1) {
    saveBlob(fileName([info.page, item.title, info.player], 'csv'), csvBlob(tables[0]));
  } else if (tables.length > 1) {
    // Several tables: one ZIP rather than a burst of downloads the browser may block.
    const encoder = new TextEncoder();
    const zip = makeZip(tables.map((t) => ({ name: `${slug(t.name)}.csv`, data: encoder.encode('﻿' + toCsv(t)) })));
    saveBlob(fileName([info.page, item.title, info.player], 'zip'), new Blob([zip as BlobPart], { type: 'application/zip' }));
  }
}

async function downloadAll(items: ExportItem[], info: ExportInfo, progress: (text: string) => void): Promise<void> {
  const encoder = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];
  let n = 0;
  for (const item of items) {
    n++;
    progress(`Preparing ${n} of ${items.length}…`);
    for (const table of item.csv?.() ?? []) {
      const name = table.name && slug(table.name) !== slug(item.title) ? `${slug(item.title)}_${slug(table.name)}` : slug(item.title);
      entries.push({ name: `${name}.csv`, data: encoder.encode('﻿' + toCsv(table)) });
    }
    try {
      const blob = await pdfBlob(item, info);
      if (blob) entries.push({ name: `${slug(item.title)}.pdf`, data: new Uint8Array(await blob.arrayBuffer()) });
    } catch (err) {
      console.warn(`PDF export of "${item.title}" failed`, err);
    }
  }
  const zip = makeZip(entries);
  saveBlob(fileName([info.page, 'everything', info.player], 'zip'), new Blob([zip as BlobPart], { type: 'application/zip' }));
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

/** PDF / CSV buttons for one item (which is also listed in the page's Export menu). */
export function ExportButtons({ item, register = true }: { item: ExportItem; register?: boolean }) {
  useExportItem(register ? item : null);
  const info = useInfo();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdf = async () => {
    setBusy(true);
    setError(null);
    try { await downloadPdf(item, info); } catch (err) { setError(err instanceof Error ? err.message : 'PDF export failed'); } finally { setBusy(false); }
  };
  return (
    <span className="export-buttons">
      {item.pdf && (
        <button type="button" className="btn quiet small" onClick={pdf} disabled={busy} title={`Download "${item.title}" as a PDF`} aria-label={`Download ${item.title} as PDF`}>
          {busy ? 'Preparing…' : '⤓ PDF'}
        </button>
      )}
      {item.csv && (
        <button type="button" className="btn quiet small" onClick={() => downloadCsv(item, info)} title={`Download the data behind "${item.title}" as CSV`} aria-label={`Download ${item.title} as CSV`}>
          ⤓ CSV
        </button>
      )}
      {error && <span className="export-error" role="alert">{error}</span>}
    </span>
  );
}

/** The page-level menu: every exportable thing on the page, and all of it at once. */
export function ExportMenu() {
  const registry = useContext(RegistryContext);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ExportItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const info = useInfo();

  const toggle = useCallback(() => {
    setItems(registry?.list() ?? []);
    setOpen((v) => !v);
  }, [registry]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!registry) return null;
  const run = async (label: string, action: () => Promise<void> | void) => {
    setBusy(label);
    try { await action(); } finally { setBusy(null); }
  };

  return (
    <div className="export-menu" ref={root}>
      <button type="button" className="btn small" aria-expanded={open} aria-haspopup="true" onClick={toggle}>⤓ Export</button>
      {open && (
        <div className="export-panel" role="menu">
          <div className="export-panel-head">
            <strong>Export this page</strong>
            <span className="muted">Charts and maps as PDF, the numbers behind them as CSV.</span>
          </div>
          <ul>
            {items.map((item, i) => (
              <li key={`${item.title}-${i}`}>
                <span className="export-title">{item.title}</span>
                <span className="row" style={{ gap: 4 }}>
                  {item.pdf && <button type="button" className="btn quiet small" disabled={busy !== null} onClick={() => run(`pdf-${i}`, () => downloadPdf(item, info))}>{busy === `pdf-${i}` ? '…' : 'PDF'}</button>}
                  {item.csv && <button type="button" className="btn quiet small" disabled={busy !== null} onClick={() => run(`csv-${i}`, () => downloadCsv(item, info))}>CSV</button>}
                </span>
              </li>
            ))}
            {items.length === 0 && <li className="muted">Nothing to export here yet.</li>}
          </ul>
          {items.length > 0 && (
            <button type="button" className="btn primary small" style={{ width: '100%' }} disabled={busy !== null} onClick={() => run('all', () => downloadAll(items, info, (t) => setBusy(t)))}>
              {busy && !busy.startsWith('pdf-') && !busy.startsWith('csv-') && busy !== 'all' ? busy : 'Everything on this page (ZIP)'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Groups of stat tiles: exported as label / value / note rows, read from what is on screen
// ---------------------------------------------------------------------------------------------

export function Tiles({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useExportItem({
    title,
    csv: () => {
      const rows = Array.from(ref.current?.querySelectorAll('.tile') ?? []).map((tile) => [
        tile.querySelector('.tile-label')?.textContent?.trim() ?? '',
        tile.querySelector('.tile-value')?.textContent?.trim() ?? '',
        tile.querySelector('.tile-note')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      ]);
      return [{ name: title, columns: ['Statistic', 'Value', 'Note'], rows }];
    },
  });
  return <div className="tiles" ref={ref}>{children}</div>;
}
