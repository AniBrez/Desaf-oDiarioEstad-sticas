import { describe, expect, it } from 'vitest';
import { createRandom } from '../src/data/demo';
import { benjaminiHochberg, fitBestTrend, fitTrend, linearTrend, median, ols, rollingMean, rollingMeanByTime } from '../src/stats/regression';

/** Standard normal draws from a seeded generator (Box-Muller). */
function gaussian(seed: number): () => number {
  const random = createRandom(seed);
  return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

describe('ols', () => {
  it('recovers an exact line', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const fit = ols(x.map((v) => [1, v]), x.map((v) => 2 + 3 * v))!;
    expect(fit.beta[0]).toBeCloseTo(2, 9);
    expect(fit.beta[1]).toBeCloseTo(3, 9);
    expect(fit.r2).toBeCloseTo(1, 9);
  });

  it('returns null for a singular design', () => {
    expect(ols([[1, 2], [1, 2], [1, 2]], [1, 2, 3])).toBeNull();
  });
});

describe('linearTrend', () => {
  it('finds a real slope and brackets it', () => {
    const noise = gaussian(7);
    const x = Array.from({ length: 300 }, (_, i) => i);
    const y = x.map((v) => 10000 + 12 * v + 2500 * noise());
    const trend = linearTrend(x, y)!;
    expect(trend.slopeLo).toBeLessThan(12);
    expect(trend.slopeHi).toBeGreaterThan(12);
    expect(trend.pValue).toBeLessThan(1e-4);
  });

  it('does not see a trend in noise', () => {
    const noise = gaussian(11);
    const x = Array.from({ length: 200 }, (_, i) => i);
    const trend = linearTrend(x, x.map(() => 15000 + 3000 * noise()))!;
    expect(trend.pValue).toBeGreaterThan(0.05);
    expect(trend.slopeLo).toBeLessThan(0);
    expect(trend.slopeHi).toBeGreaterThan(0);
  });
});

describe('learning curves', () => {
  it('recovers a plateau curve and prefers it', () => {
    const noise = gaussian(3);
    const obs = Array.from({ length: 400 }, (_, i) => ({ days: i, value: 20000 - 6000 * Math.exp(-i / 60) + 1800 * noise() }));
    const comparison = fitBestTrend(obs)!;
    expect(comparison.best.kind).toBe('plateau');
    expect(comparison.best.params.plateau).toBeGreaterThan(19500);
    expect(comparison.best.params.plateau).toBeLessThan(20500);
    expect(comparison.best.params.gap).toBeGreaterThan(4000);
    expect(comparison.best.params.gap).toBeLessThan(8500);
    expect(comparison.best.params.tau).toBeGreaterThan(30);
    expect(comparison.best.params.tau).toBeLessThan(110);
    expect(comparison.best.pValue).toBeLessThan(1e-6);
    // The band contains the true curve almost everywhere.
    const inside = obs.filter((_, i) => {
      const truth = 20000 - 6000 * Math.exp(-i / 60);
      return truth >= comparison.best.lo[i] - 150 && truth <= comparison.best.hi[i] + 150;
    }).length;
    expect(inside / obs.length).toBeGreaterThan(0.9);
  });

  it('prefers a two-parameter model for a straight line', () => {
    const noise = gaussian(5);
    const obs = Array.from({ length: 250 }, (_, i) => ({ days: i * 1.2, value: 14000 + 15 * i + 2200 * noise() }));
    const comparison = fitBestTrend(obs)!;
    expect(comparison.best.k).toBe(2);
    const linear = comparison.all.find((f) => f.kind === 'linear')!;
    expect(linear.params.perDay).toBeGreaterThan(8);
    expect(linear.params.perDay).toBeLessThan(18);
  });

  it('needs enough observations', () => {
    expect(fitTrend('linear', [{ days: 0, value: 1 }, { days: 1, value: 2 }])).toBeNull();
    expect(fitBestTrend([])).toBeNull();
  });

  it('predicts beyond the data', () => {
    const obs = Array.from({ length: 30 }, (_, i) => ({ days: i, value: 100 + 2 * i }));
    const fit = fitTrend('linear', obs)!;
    expect(fit.predict(60, 60)).toBeCloseTo(220, 6);
  });
});

describe('helpers', () => {
  it('adjusts p-values (Benjamini-Hochberg)', () => {
    const adjusted = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
    expect(adjusted[0]).toBeCloseTo(0.02, 10);
    expect(adjusted[1]).toBeCloseTo(0.04, 10);
    expect(adjusted[2]).toBeCloseTo(0.04, 10);
    expect(adjusted[3]).toBeCloseTo(0.02, 10);
  });

  it('computes trailing means', () => {
    expect(rollingMean([1, 2, 3, 4, 5], 2)).toEqual([1, 1.5, 2.5, 3.5, 4.5]);
    expect(rollingMean([1, 2, 3], 3, 3)).toEqual([null, null, 2]);
    expect(rollingMeanByTime([0, 1, 2, 10], [10, 20, 30, 40], 3)).toEqual([10, 15, 20, 40]);
    expect(median([5, 1, 3, 2])).toBe(2.5);
  });
});
