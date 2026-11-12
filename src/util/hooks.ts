import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/** Width of an element, tracked with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// ---------------------------------------------------------------------------------------------
// Hash routing: works on any static host without server configuration.
// ---------------------------------------------------------------------------------------------

export interface Route {
  path: string;
  params: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path: path || 'overview', params: new URLSearchParams(query) };
}

let currentRoute: Route | null = null;
const subscribeHash = (callback: () => void) => {
  const listener = () => { currentRoute = null; callback(); };
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
};
const getRoute = () => (currentRoute ??= parseHash());

export function useRoute(): Route {
  return useSyncExternalStore(subscribeHash, getRoute);
}

export function navigate(path: string, params?: Record<string, string>): void {
  const query = params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  window.location.hash = `#/${path}${query}`;
}

export const href = (path: string, params?: Record<string, string>): string =>
  `#/${path}${params && Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : ''}`;

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

export type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'desafio-diario:theme';
const themeListeners = new Set<() => void>();
let themeVersion = 0;

function applyTheme(choice: ThemeChoice): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  themeVersion++;
  themeListeners.forEach((l) => l());
}

export function initTheme(): void {
  let stored: ThemeChoice = 'system';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') stored = v;
  } catch { /* storage unavailable */ }
  applyTheme(stored);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { themeVersion++; themeListeners.forEach((l) => l()); });
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => (document.documentElement.dataset.theme as ThemeChoice | undefined) ?? 'system');
  const set = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch { /* storage unavailable */ }
    applyTheme(next);
  }, []);
  return [choice, set];
}

/** Changes whenever the effective colours change; canvas drawings depend on it to repaint. */
export function useThemeVersion(): number {
  return useSyncExternalStore(
    (callback) => { themeListeners.add(callback); return () => themeListeners.delete(callback); },
    () => themeVersion,
  );
}

/** Reads CSS custom properties off an element (for drawing on canvas). */
export function readCssVars<K extends string>(el: Element, names: readonly K[]): Record<K, string> {
  const style = getComputedStyle(el);
  const out = {} as Record<K, string>;
  for (const name of names) out[name] = style.getPropertyValue(name).trim();
  return out;
}

export function useStoredState<T>(key: string, initial: T, validate: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (validate(parsed)) return parsed;
      }
    } catch { /* fall through */ }
    return initial;
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
  }, [key]);
  return [value, set];
}

export function useEffectOnce(effect: () => void | (() => void)): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}
