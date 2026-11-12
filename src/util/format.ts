const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const ONE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' });

export const fmtInt = (n: number): string => (Number.isFinite(n) ? INT.format(Math.round(n)) : '–');
export const fmtOne = (n: number): string => (Number.isFinite(n) ? ONE.format(n) : '–');

/** 1,284 / 12.9K / 4.2M */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}K`;
  return INT.format(Math.round(n));
}
const trim = (v: number): string => (Math.abs(v) >= 100 || Number.isInteger(+v.toFixed(1)) ? v.toFixed(0) : v.toFixed(1));

export const fmtPct = (p: number, digits = 0): string => (Number.isFinite(p) ? `${(100 * p).toFixed(digits)}%` : '–');
export const fmtSigned = (n: number, format: (v: number) => string = fmtInt): string =>
  !Number.isFinite(n) ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${format(Math.abs(n))}`;

export const fmtDate = (t: number): string => DATE.format(t);
export const fmtDateShort = (t: number): string => DATE_SHORT.format(t);
export const fmtMonth = (t: number): string => MONTH.format(t);
export const fmtMonthYear = (t: number): string => MONTH_YEAR.format(t);

export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '–';
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function fmtKm(km: number | null): string {
  if (km === null || !Number.isFinite(km)) return '–';
  return km >= 100 ? `${INT.format(Math.round(km))} km` : km >= 10 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`;
}

/** p-values the way people read them. */
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '–';
  if (p < 0.001) return '< 0.001';
  return p < 0.1 ? p.toFixed(3) : p.toFixed(2);
}

/** "p < 0.001" or "p = 0.03". */
export const fmtPText = (p: number): string => (Number.isFinite(p) && p < 0.001 ? 'p < 0.001' : `p = ${fmtP(p)}`);

export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Regional-indicator flag for an ISO alpha-2 code. */
export function flagEmoji(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

let flagSupport: boolean | null = null;
/** Windows has no flag glyphs: it shows the two letters instead. Detect that once. */
export function supportsFlagEmoji(): boolean {
  if (flagSupport !== null) return flagSupport;
  flagSupport = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.font = '18px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(flagEmoji('FR'), 0, 2);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      // A real flag has several distinct colours; fallback letters are a single ink colour.
      const colours = new Set<number>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 200) colours.add((data[i] >> 5) << 6 | (data[i + 1] >> 5) << 3 | (data[i + 2] >> 5));
      }
      flagSupport = colours.size >= 3;
    }
  } catch { /* keep false */ }
  return flagSupport;
}
