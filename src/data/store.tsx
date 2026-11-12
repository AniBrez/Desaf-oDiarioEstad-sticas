import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { del, get, set } from 'idb-keyval';
import { loadGeo, type Geo } from '../geo/geo';
import { useStoredState } from '../util/hooks';
import { buildSeries, dateToTime, emptyDataset, mergeExport, removePlayer as removePlayerFrom, type MergeSummary, type SeriesBundle } from './dataset';
import { generateDemo } from './demo';
import { toLocator } from './locator';
import type { Dataset, ExportFile, Player, PlayerSeries } from './types';

const DATASET_KEY = 'desafio-diario:dataset:v1';
const DAY_MS = 86400000;

export type Period = 'all' | '365' | '90' | '30';
export const PERIODS: { key: Period; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: '365', label: 'Last year' },
  { key: '90', label: 'Last 90 days' },
  { key: '30', label: 'Last 30 days' },
];

export interface Settings {
  /** The player whose statistics are shown. */
  focusId: string | null;
  /** Players compared against, when chosen by hand (null: everyone, up to the palette size). */
  compareIds: string[] | null;
  period: Period;
  /** A round counts as "good" from this score. */
  threshold: number;
}

const DEFAULT_SETTINGS: Settings = { focusId: null, compareIds: null, period: 'all', threshold: 4000 };
const isSettings = (v: unknown): v is Settings => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (s.focusId === null || typeof s.focusId === 'string')
    && (s.compareIds === null || (Array.isArray(s.compareIds) && s.compareIds.every((x) => typeof x === 'string')))
    && ['all', '365', '90', '30'].includes(s.period as string)
    && typeof s.threshold === 'number' && s.threshold >= 500 && s.threshold <= 5000;
};

/** At most eight players get a colour of their own; that is the size of the palette. */
export const MAX_COMPARED = 7;

export interface AppData {
  /** False until the saved dataset has been read back. */
  ready: boolean;
  dataset: Dataset;
  geo: Geo | null;
  geoError: string | null;
  /** Every player, all time. */
  bundle: SeriesBundle;
  settings: Settings;
  /** Selected period as inclusive UTC times, or null for all time. */
  range: { from: number; to: number } | null;
  /** The focused player, limited to the period. */
  focus: PlayerSeries | null;
  /** The players compared against the focus, limited to the period. */
  compare: PlayerSeries[];
  /** Focus first, then the compared players. */
  shown: PlayerSeries[];
  /** Every distinct round in the period, whoever played it. */
  pooledRounds: SeriesBundle['pooledRounds'];
  hasDemo: boolean;
  importFile(file: ExportFile): MergeSummary;
  loadDemo(): void;
  removeDemo(): void;
  removePlayer(id: string): void;
  clearAll(): void;
  setFocus(id: string): void;
  toggleCompare(id: string): void;
  setPeriod(period: Period): void;
  setThreshold(threshold: number): void;
}

const Context = createContext<AppData | null>(null);

export function useApp(): AppData {
  const value = useContext(Context);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** CSS colour of a player's series. */
export function playerColor(player: Player): string {
  return player.slot < 8 ? `var(--series-${player.slot + 1})` : 'var(--series-other)';
}

function limit(series: PlayerSeries, range: { from: number; to: number } | null): PlayerSeries {
  if (!range) return series;
  const days = series.days.filter((d) => d.t >= range.from && d.t <= range.to);
  return { player: series.player, days, rounds: days.flatMap((d) => d.rounds) };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [dataset, setDataset] = useState<Dataset>(emptyDataset);
  const [ready, setReady] = useState(false);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [settings, setSettings] = useStoredState<Settings>('desafio-diario:settings:v1', DEFAULT_SETTINGS, isSettings);
  const datasetRef = useRef(dataset);
  datasetRef.current = dataset;

  useEffect(() => {
    let cancelled = false;
    get<Dataset>(DATASET_KEY)
      .then((saved) => {
        if (!cancelled && saved && typeof saved === 'object' && saved.players && saved.challenges) setDataset(saved);
      })
      .catch(() => { /* private mode or blocked storage: start empty */ })
      .finally(() => { if (!cancelled) setReady(true); });
    loadGeo().then((g) => { if (!cancelled) setGeo(g); }).catch((err: unknown) => {
      if (!cancelled) setGeoError(err instanceof Error ? err.message : 'The map data could not be loaded.');
    });
    return () => { cancelled = true; };
  }, []);

  // Persist after changes (not before the saved copy has been read).
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      const empty = Object.keys(dataset.players).length === 0;
      (empty ? del(DATASET_KEY) : set(DATASET_KEY, dataset)).catch(() => { /* storage unavailable */ });
    }, 250);
    return () => clearTimeout(timer);
  }, [dataset, ready]);

  const bundle = useMemo(() => buildSeries(dataset, geo ? toLocator(geo) : null), [dataset, geo]);

  const focusId = useMemo(() => {
    if (settings.focusId && bundle.byId.get(settings.focusId)?.days.length) return settings.focusId;
    return bundle.series[0]?.player.id ?? null;
  }, [settings.focusId, bundle]);

  const range = useMemo(() => {
    if (settings.period === 'all' || !bundle.lastDate) return null;
    const to = dateToTime(bundle.lastDate);
    return { from: to - (Number(settings.period) - 1) * DAY_MS, to };
  }, [settings.period, bundle.lastDate]);

  const derived = useMemo(() => {
    const focusAll = focusId ? bundle.byId.get(focusId) ?? null : null;
    const others = bundle.series.filter((s) => s.player.id !== focusId);
    const chosen = settings.compareIds
      ? others.filter((s) => settings.compareIds!.includes(s.player.id))
      : others.slice(0, MAX_COMPARED);
    const focus = focusAll ? limit(focusAll, range) : null;
    const compare = chosen.slice(0, MAX_COMPARED).map((s) => limit(s, range)).filter((s) => s.days.length > 0);
    const pooledRounds = range
      ? bundle.pooledRounds.filter((r) => { const t = dateToTime(r.date); return t >= range.from && t <= range.to; })
      : bundle.pooledRounds;
    return { focus, compare, shown: focus ? [focus, ...compare] : compare, pooledRounds };
  }, [bundle, focusId, settings.compareIds, range]);

  const importFile = useCallback((file: ExportFile): MergeSummary => {
    const { dataset: next, summary } = mergeExport(datasetRef.current, file);
    datasetRef.current = next;
    setDataset(next);
    return summary;
  }, []);

  const value = useMemo<AppData>(() => ({
    ready,
    dataset,
    geo,
    geoError,
    bundle,
    settings: { ...settings, focusId },
    range,
    ...derived,
    hasDemo: Object.values(dataset.players).some((p) => p.demo),
    importFile,
    loadDemo() {
      if (geo) importFile(generateDemo(geo));
    },
    removeDemo() {
      let next = datasetRef.current;
      for (const p of Object.values(next.players)) if (p.demo) next = removePlayerFrom(next, p.id);
      setDataset(next);
    },
    removePlayer(id) {
      setDataset(removePlayerFrom(datasetRef.current, id));
    },
    clearAll() {
      setDataset(emptyDataset());
      setSettings(DEFAULT_SETTINGS);
    },
    setFocus(id) {
      setSettings({ ...settings, focusId: id });
    },
    toggleCompare(id) {
      const current = settings.compareIds ?? derived.compare.map((s) => s.player.id);
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-MAX_COMPARED);
      setSettings({ ...settings, compareIds: next });
    },
    setPeriod(period) {
      setSettings({ ...settings, period });
    },
    setThreshold(threshold) {
      setSettings({ ...settings, threshold });
    },
  }), [ready, dataset, geo, geoError, bundle, settings, focusId, range, derived, importFile, setSettings]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
