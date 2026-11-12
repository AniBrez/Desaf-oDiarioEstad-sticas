import { fUpperTail, studentTQuantile, studentTTwoSided } from './special';

// ---------------------------------------------------------------------------------------------
// Ordinary least squares
// ---------------------------------------------------------------------------------------------

export interface OlsFit {
  n: number;
  /** Number of coefficients. */
  p: number;
  beta: number[];
  /** Standard errors of the coefficients. */
  se: number[];
  /** Coefficient covariance matrix. */
  cov: number[][];
  rss: number;
  tss: number;
  sigma2: number;
  r2: number;
  /** Standard error of the fitted mean at a design row. */
  meanSe(row: number[]): number;
  predict(row: number[]): number;
}

/** Inverts a small symmetric positive-definite matrix; returns null if it is singular. */
export function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Least squares fit of y on the columns of X (include a column of ones for an intercept).
 * `ridge` adds a penalty per coefficient (0 for none), which keeps tiny samples well behaved.
 */
export function ols(X: number[][], y: number[], ridge?: number[]): OlsFit | null {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0 || n < p) return null;
  const xtx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty = new Array<number>(p).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    for (let a = 0; a < p; a++) {
      xty[a] += row[a] * y[i];
      for (let b = a; b < p; b++) xtx[a][b] += row[a] * row[b];
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];
    if (ridge) xtx[a][a] += ridge[a] ?? 0;
  }
  const inv = invertMatrix(xtx);
  if (!inv) return null;
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const predict = (row: number[]) => row.reduce((s, v, j) => s + v * beta[j], 0);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let rss = 0, tss = 0;
  for (let i = 0; i < n; i++) {
    const e = y[i] - predict(X[i]);
    rss += e * e;
    tss += (y[i] - mean) ** 2;
  }
  const sigma2 = n > p ? rss / (n - p) : 0;
  const cov = inv.map((row) => row.map((v) => v * sigma2));
  return {
    n, p, beta, cov, rss, tss, sigma2,
    se: cov.map((row, i) => Math.sqrt(Math.max(0, row[i]))),
    r2: tss > 0 ? 1 - rss / tss : 0,
    predict,
    meanSe(row: number[]) {
      let v = 0;
      for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) v += row[a] * cov[a][b] * row[b];
      return Math.sqrt(Math.max(0, v));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Simple linear trend with inference
// ---------------------------------------------------------------------------------------------

export interface LinearTrend {
  n: number;
  intercept: number;
  slope: number;
  slopeSe: number;
  /** 95% confidence interval of the slope. */
  slopeLo: number;
  slopeHi: number;
  /** Two-sided p-value of "slope = 0". */
  pValue: number;
  r2: number;
}

export function linearTrend(x: number[], y: number[]): LinearTrend | null {
  const n = x.length;
  if (n < 3) return null;
  const fit = ols(x.map((v) => [1, v]), y);
  if (!fit || fit.se[1] === 0 || !Number.isFinite(fit.se[1])) return null;
  const df = n - 2;
  const t = fit.beta[1] / fit.se[1];
  const q = studentTQuantile(0.975, df);
  return {
    n,
    intercept: fit.beta[0],
    slope: fit.beta[1],
    slopeSe: fit.se[1],
    slopeLo: fit.beta[1] - q * fit.se[1],
    slopeHi: fit.beta[1] + q * fit.se[1],
    pValue: studentTTwoSided(t, df),
    r2: fit.r2,
  };
}

// ---------------------------------------------------------------------------------------------
// Learning-curve models
// ---------------------------------------------------------------------------------------------

export type TrendKind = 'linear' | 'log' | 'plateau';

export interface TrendObservation {
  /** Days since the first observation. */
  days: number;
  value: number;
}

export interface TrendFit {
  kind: TrendKind;
  n: number;
  /** Number of mean parameters. */
  k: number;
  fitted: number[];
  /** 95% confidence band of the fitted mean. */
  lo: number[];
  hi: number[];
  r2: number;
  rss: number;
  aic: number;
  /** F test of the model against a flat average. */
  pValue: number;
  /**
   * linear: start, perDay.
   * log: start, perLogGame (gain per e-fold of games played).
   * plateau: plateau, gap (plateau minus the starting level), tau (games to close 63% of the gap).
   */
  params: Record<string, number>;
  /** Fitted mean for a (possibly future) game index and day offset. */
  predict(index: number, days: number): number;
}

const MIN_OBSERVATIONS = 8;

function finish(
  kind: TrendKind,
  k: number,
  obs: TrendObservation[],
  row: (index: number, days: number) => number[],
  fit: OlsFit,
  params: Record<string, number>,
): TrendFit {
  const n = obs.length;
  const df = Math.max(1, n - k);
  const q = studentTQuantile(0.975, df);
  // The band uses the residual variance with all k mean parameters accounted for.
  const scale = fit.sigma2 > 0 ? Math.sqrt(((fit.rss / df) / fit.sigma2)) : 1;
  const fitted: number[] = [], lo: number[] = [], hi: number[] = [];
  obs.forEach((o, i) => {
    const r = row(i, o.days);
    const m = fit.predict(r);
    const se = fit.meanSe(r) * scale;
    fitted.push(m);
    lo.push(m - q * se);
    hi.push(m + q * se);
  });
  const f = k > 1 && fit.rss > 0 ? ((fit.tss - fit.rss) / (k - 1)) / (fit.rss / df) : 0;
  return {
    kind, n, k, fitted, lo, hi,
    r2: fit.r2,
    rss: fit.rss,
    aic: n * Math.log(Math.max(fit.rss, 1e-9) / n) + 2 * (k + 1),
    pValue: k > 1 && fit.rss > 0 ? fUpperTail(Math.max(0, f), k - 1, df) : 1,
    params,
    predict: (index, days) => fit.predict(row(index, days)),
  };
}

export function fitTrend(kind: TrendKind, obs: TrendObservation[]): TrendFit | null {
  const n = obs.length;
  if (n < MIN_OBSERVATIONS) return null;
  const y = obs.map((o) => o.value);

  if (kind === 'linear') {
    const span = Math.max(1, obs[n - 1].days - obs[0].days);
    const row = (_: number, days: number) => [1, days / span];
    const fit = ols(obs.map((o, i) => row(i, o.days)), y);
    if (!fit) return null;
    return finish(kind, 2, obs, row, fit, { start: fit.beta[0], perDay: fit.beta[1] / span });
  }

  if (kind === 'log') {
    const row = (index: number) => [1, Math.log(1 + index)];
    const fit = ols(obs.map((_, i) => row(i)), y);
    if (!fit) return null;
    return finish(kind, 2, obs, row, fit, { start: fit.beta[0], perLogGame: fit.beta[1] });
  }

  // Plateau: value = plateau - gap * exp(-games / tau). For a fixed tau this is linear in the
  // other two parameters, so a grid over tau gives a stable fit without iterative optimisation.
  if (n < 20) return null;
  let best: { fit: OlsFit; tau: number } | null = null;
  const steps = 48;
  const tauMin = 2, tauMax = Math.max(8, n * 3);
  for (let s = 0; s <= steps; s++) {
    const tau = tauMin * (tauMax / tauMin) ** (s / steps);
    const fit = ols(obs.map((_, i) => [1, Math.exp(-i / tau)]), y);
    if (fit && (!best || fit.rss < best.fit.rss)) best = { fit, tau };
  }
  if (!best) return null;
  const tau = best.tau;
  const row = (index: number) => [1, Math.exp(-index / tau)];
  return finish(kind, 3, obs, row, best.fit, { plateau: best.fit.beta[0], gap: -best.fit.beta[1], tau });
}

export interface TrendComparison {
  best: TrendFit;
  all: TrendFit[];
}

/**
 * Fits every model and picks one by AIC, preferring a two-parameter model unless the plateau
 * model is clearly better (more than 2 AIC units).
 */
export function fitBestTrend(obs: TrendObservation[]): TrendComparison | null {
  const all = (['linear', 'log', 'plateau'] as TrendKind[])
    .map((kind) => fitTrend(kind, obs))
    .filter((f): f is TrendFit => f !== null);
  if (all.length === 0) return null;
  const simple = all.filter((f) => f.k === 2).sort((a, b) => a.aic - b.aic)[0];
  const plateau = all.find((f) => f.kind === 'plateau');
  let best = simple ?? all[0];
  if (plateau && (!simple || plateau.aic < simple.aic - 2)) best = plateau;
  return { best, all };
}

// ---------------------------------------------------------------------------------------------
// Multiple testing
// ---------------------------------------------------------------------------------------------

/** Benjamini-Hochberg adjusted p-values (false discovery rate), in the input order. */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    adjusted[i] = running;
  }
  return adjusted;
}

// ---------------------------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------------------------

/** Trailing mean over the last `window` values (fewer at the start, but at least `minCount`). */
export function rollingMean(values: number[], window: number, minCount = 1): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    const count = Math.min(i + 1, window);
    out.push(count >= minCount ? sum / count : null);
  }
  return out;
}

/** Trailing mean over a time window: for each point, the mean of points within `spanMs` before it. */
export function rollingMeanByTime(times: number[], values: number[], spanMs: number, minCount = 1): (number | null)[] {
  const out: (number | null)[] = [];
  let start = 0, sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    while (times[i] - times[start] >= spanMs) sum -= values[start++];
    const count = i - start + 1;
    out.push(count >= minCount ? sum / count : null);
  }
  return out;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}
